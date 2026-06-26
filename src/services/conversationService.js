import { conversationRepository, messageRepository } from '../repositories/conversationRepository.js';
import { serviceClient } from '../lib/serviceClient.js';
import { config } from '../config/index.js';

function generateConversationId() {
  return `conv_${Date.now()}`;
}

function validateUserId(userId) {
  if (!userId) {
    throw new Error('UNAUTHORIZED');
  }
}

/**
 * 組裝傳給 ai-service 的生成請求
 * @param {string} conversationId - 聊天室 ID
 * @param {Object} conversation - 聊天室資訊（包含角色快照）
 * @param {Array} messages - 所有訊息
 * @returns {Promise<Object>} 組裝後的請求物件
 */
async function buildAIServiceRequest(conversationId, conversation, messages) {
  // 1. 提取角色資訊
  const characterInfo = {
    name: conversation.characterName,
    gender: conversation.characterGender,
    tags: conversation.characterTags ? JSON.parse(conversation.characterTags) : []
  };

  // 2. 提取最近 N 條訊息（根據 config）
  const maxMessages = config.ai.contextWindow.maxMessages;
  const recentMessages = messages.slice(-maxMessages);

  // 3. 轉換成請求格式（只需要 role 和 text）
  const conversationHistory = recentMessages.map(msg => ({
    role: msg.role,
    text: msg.text
  }));

  // 4. 組裝最終請求
  const request = {
    conversation_id: conversationId,
    character_info: characterInfo,
    conversation_history: conversationHistory
  };

  console.log(`📦 [conversationService] 組裝 AI 請求: conversationId=${conversationId}, 訊息數=${conversationHistory.length}`);

  return request;
}

/**
 * 清理單個聊天室的 RAG 資料的內部方法
 * @param {string} conversationId - 聊天室 ID
 * @returns {Promise<void>}
 */
async function cleanupConversationRAG(conversationId) {
  console.log(`🧹 [conversationService] 清理 RAG 資料: conversationId=${conversationId}`);
  try {
    await serviceClient.cleanupRAG(conversationId);
    console.log(`✅ [conversationService] RAG 清理成功`);
  } catch (error) {
    console.error(`⚠️  [conversationService] RAG 清理失敗:`, error.message);
    // 不中斷刪除流程，只記錄警告
  }
}

/**
 * 建立新聊天室的內部方法
 * @param {string} userId - 用戶 ID
 * @param {string} characterId - 角色 ID
 * @param {Object} character - 角色信息對象
 * @returns {Promise<Object>} 建立的聊天室信息
 */
async function createNewConversation(userId, characterId, character) {
  console.log(`➕ [conversationService] 建立新對話: userId=${userId}, characterId=${characterId}`);

  const conversationData = {
    id: generateConversationId(),
    userId,
    characterId,
    title: null,
    characterName: character.name,
    characterGender: character.gender,
    characterTags: JSON.stringify(character.tags || []),
    characterIntroduction: character.introduction,
    characterBackground: character.background,
    characterOpening: character.opening,
    characterFewShots: JSON.stringify(character.fewShots || []),
  };

  const conversation = await conversationRepository.create(conversationData);

  // 初始化 RAG 資料
  console.log(`🧠 [conversationService] 初始化 RAG 資料: conversationId=${conversation.id}`);
  try {
    // 轉換 fewShots 格式：[{user, char}] → ["user msg\nchar msg", ...]
    const fewshotsArray = (character.fewShots || []).map(shot => {
      if (typeof shot === 'string') {
        return shot;
      }
      // {user, char} 格式轉成字串
      return `${shot.user}\n${shot.char}`;
    });

    const ragData = {
      conversation_id: conversation.id,
      character_id: characterId,
      background: character.background || '',
      fewshots: fewshotsArray
    };
    console.log(`📊 [conversationService] RAG 初始化資料:`, JSON.stringify(ragData, null, 2));

    const ragResponse = await serviceClient.initializeRAG(ragData);
    console.log(`✅ [conversationService] RAG 初始化成功`);
  } catch (error) {
    console.error(`⚠️  [conversationService] RAG 初始化失敗:`, error.message);
    // 不中斷對話建立流程，只記錄警告
  }

  // 🆕 保存開場白作為第一條訊息
  if (character.opening) {
    try {
      await messageRepository.create({
        conversationId: conversation.id,
        role: 'assistant',
        text: character.opening,
      });
      console.log(`📝 [conversationService] 開場白已保存`);
    } catch (error) {
      console.error(`⚠️  [conversationService] 保存開場白失敗:`, error.message);
      // 不中斷對話建立流程，只記錄警告
    }
  }

  // 🆕 重新查詢完整的對話（包含 messages）
  const completeConversation = await conversationRepository.findFirst(
    { id: conversation.id },
    {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    }
  );

  return completeConversation;
}

export const conversationService = {
  async getOrCreateConversation(userId, characterId) {
    validateUserId(userId);

    if (!characterId) {
      throw new Error('MISSING_CHARACTER_ID');
    }

    // 🆕 驗證角色是否存在（調用 character-service）
    console.log(`🔍 [conversationService] 驗證角色存在性...`);
    let character;
    try {
      character = await serviceClient.getCharacter(characterId, userId);  // 🆕 傳遞 userId
      console.log(`✅ [conversationService] 角色驗證通過: ${character.name}`);
    } catch (error) {
      console.error(`❌ [conversationService] 角色驗證失敗:`, error.message);
      if (error.message === 'CHARACTER_NOT_FOUND') {
        throw new Error('CHARACTER_NOT_FOUND');
      }
      throw error;
    }

    // 查詢該用戶與該角色的最新對話
    let conversation = await conversationRepository.findFirst(
      {
        userId,
        characterId,
      },
      {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      }
    );

    // 如果不存在，建立新對話
    if (!conversation) {
      console.log(`📸 [conversationService] 保存角色快照: ${character.name}`);
      conversation = await createNewConversation(userId, characterId, character);
    }

    return {
      conversationId: conversation.id,
      messages: conversation.messages || [],
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  },

  async getAllConversations(userId) {
    validateUserId(userId);

    const conversations = await conversationRepository.findMany(
      { userId },
      { updatedAt: 'desc' },
      {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      }
    );

    return conversations;
  },

  async getConversationsSummary(userId) {
    validateUserId(userId);

    // 🆕 只查詢基本信息，不包含訊息內容
    const conversations = await conversationRepository.findMany(
      { userId },
      { updatedAt: 'desc' }
    );

    // 返回簡化版本
    return conversations.map((conv) => ({
      conversationId: conv.id,
      characterId: conv.characterId,
      characterName: conv.characterName,
      updatedAt: conv.updatedAt,
    }));
  },

  async sendMessage(userId, characterId, role, text) {
    validateUserId(userId);

    if (!text) {
      throw new Error('MISSING_TEXT');
    }

    if (!role || !['user', 'assistant'].includes(role)) {
      throw new Error('INVALID_ROLE');
    }

    // 查詢最新對話
    const conversation = await conversationRepository.findFirst({
      userId,
      characterId,
    });

    if (!conversation) {
      throw new Error('CONVERSATION_NOT_FOUND');
    }

    // 建立訊息
    const message = await messageRepository.create({
      conversationId: conversation.id,
      role,
      text,
    });

    // 更新對話的 updatedAt
    await conversationRepository.update(conversation.id, {
      updatedAt: new Date(),
    });

    return {
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
    };
  },

  async sendMessageToConversation(userId, conversationId, text) {
    validateUserId(userId);

    if (!conversationId) {
      throw new Error('MISSING_CONVERSATION_ID');
    }

    if (!text) {
      throw new Error('MISSING_TEXT');
    }

    // 🆕 直接用 conversationId 查詢對話
    const conversation = await conversationRepository.findFirst({
      id: conversationId,
    });

    if (!conversation) {
      throw new Error('CONVERSATION_NOT_FOUND');
    }

    // 驗證所有權
    if (conversation.userId !== userId) {
      throw new Error('FORBIDDEN');
    }

    // 建立用戶訊息
    const userMessage = await messageRepository.create({
      conversationId: conversation.id,
      role: 'user',
      text,
    });

    console.log(`📝 [conversationService] 用戶訊息已保存: id=${userMessage.id}`);

    // 🆕 獲取所有訊息（包括剛剛新加的用戶訊息）
    const allMessages = await messageRepository.findMany(
      { conversationId: conversation.id },
      { createdAt: 'asc' }
    );

    // 🆕 組裝請求並呼叫 ai-service 生成回應
    console.log(`🤖 [conversationService] 準備呼叫 AI 生成回應...`);
    const aiRequest = await buildAIServiceRequest(conversation.id, conversation, allMessages);

    let aiResponse;
    try {
      const result = await serviceClient.generateResponse(aiRequest);
      aiResponse = result.message;
      console.log(`✅ [conversationService] AI 回應已取得`);
    } catch (error) {
      console.error(`❌ [conversationService] 呼叫 AI 失敗:`, error.message);
      // 錯誤處理：返回預設回應，而不是中斷流程
      aiResponse = `（${conversation.characterName} 暫時無法回應，請稍後再試。）`;
      console.log(`⚠️  [conversationService] 使用預設回應`);
    }

    // 🆕 保存 AI 回應
    const assistantMessage = await messageRepository.create({
      conversationId: conversation.id,
      role: 'assistant',
      text: aiResponse,
    });

    console.log(`💬 [conversationService] AI 訊息已保存: id=${assistantMessage.id}`);

    // 更新對話的 updatedAt
    await conversationRepository.update(conversation.id, {
      updatedAt: new Date(),
    });

    // 返回兩條訊息（用戶訊息 + AI 回應）
    return {
      userMessage: {
        id: userMessage.id,
        role: userMessage.role,
        text: userMessage.text,
        createdAt: userMessage.createdAt,
      },
      assistantMessage: {
        id: assistantMessage.id,
        role: assistantMessage.role,
        text: assistantMessage.text,
        createdAt: assistantMessage.createdAt,
      },
    };
  },

  async getMessages(userId, characterId, limit = 50, offset = 0) {
    validateUserId(userId);

    // 查詢對話
    const conversation = await conversationRepository.findFirst({
      userId,
      characterId,
    });

    if (!conversation) {
      throw new Error('CONVERSATION_NOT_FOUND');
    }

    // 查詢訊息
    const messages = await messageRepository.findMany(
      { conversationId: conversation.id },
      { createdAt: 'asc' }
    );

    return messages.slice(offset, offset + limit);
  },

  async deleteConversation(userId, conversationId) {
    validateUserId(userId);

    if (!conversationId) {
      throw new Error('MISSING_CONVERSATION_ID');
    }

    // 查詢對話是否存在且屬於該用戶
    const conversation = await conversationRepository.findFirst({
      id: conversationId,
    });

    if (!conversation) {
      throw new Error('CONVERSATION_NOT_FOUND');
    }

    if (conversation.userId !== userId) {
      throw new Error('FORBIDDEN');
    }

    // 刪除對話（訊息會自動刪除，因為有 onDelete: Cascade）
    console.log(`🗑️ [conversationService] 刪除對話: conversationId=${conversationId}`);
    await conversationRepository.delete(conversationId);

    // 清理 RAG 資料
    await cleanupConversationRAG(conversationId);

    return { message: 'Conversation deleted successfully' };
  },

  async deleteConversationsByCharacter(userId, characterId) {
    validateUserId(userId);

    if (!characterId) {
      throw new Error('MISSING_CHARACTER_ID');
    }

    // 驗證角色是否存在
    await serviceClient.getCharacter(characterId, userId);

    // 查詢該用戶與該角色的所有對話
    const conversations = await conversationRepository.findMany({
      userId,
      characterId,
    });

    if (conversations.length === 0) {
      throw new Error('NO_CONVERSATIONS_FOUND');
    }

    // 刪除所有對話
    console.log(`🗑️ [conversationService] 刪除角色對話: userId=${userId}, characterId=${characterId}, count=${conversations.length}`);
    await conversationRepository.deleteByCharacterId(characterId, userId);

    // 清理每個對話的 RAG 資料
    console.log(`🧹 [conversationService] 清理 RAG 資料: 共 ${conversations.length} 個聊天室`);
    for (const conversation of conversations) {
      await cleanupConversationRAG(conversation.id);
    }

    return {
      message: `${conversations.length} conversation(s) deleted successfully`,
      deletedCount: conversations.length,
    };
  },

  async restartConversation(userId, characterId) {
    validateUserId(userId);

    if (!characterId) {
      throw new Error('MISSING_CHARACTER_ID');
    }

    // 驗證角色是否存在
    console.log(`🔄 [conversationService] 重啟對話: userId=${userId}, characterId=${characterId}`);
    const character = await serviceClient.getCharacter(characterId);

    // 1. 查詢該用戶與該角色的最新對話
    const existingConversation = await conversationRepository.findFirst({
      userId,
      characterId,
    });

    // 2. 如果存在，刪除舊對話
    if (existingConversation) {
      console.log(`🗑️ [conversationService] 刪除舊對話: ${existingConversation.id}`);
      await conversationRepository.delete(existingConversation.id);
    }

    // 3. 建立新對話
    const newConversation = await createNewConversation(userId, characterId, character);

    console.log(`✅ [conversationService] 重啟完成，新對話 ID: ${newConversation.id}`);

    return {
      conversationId: newConversation.id,
      messages: [],
      title: newConversation.title,
      createdAt: newConversation.createdAt,
      updatedAt: newConversation.updatedAt,
    };
  },

  async restartConversationById(userId, conversationId) {
    validateUserId(userId);

    if (!conversationId) {
      throw new Error('MISSING_CONVERSATION_ID');
    }

    // 🆕 查詢指定的對話
    const conversation = await conversationRepository.findFirst({
      id: conversationId,
    });

    if (!conversation) {
      throw new Error('CONVERSATION_NOT_FOUND');
    }

    // 驗證所有權
    if (conversation.userId !== userId) {
      throw new Error('FORBIDDEN');
    }

    // 1. 獲取角色信息（用於快照）
    console.log(`🔄 [conversationService] 直接重啟對話: conversationId=${conversationId}`);
    const character = await serviceClient.getCharacter(conversation.characterId);

    // 2. 刪除舊對話
    console.log(`🗑️ [conversationService] 刪除舊對話: ${conversationId}`);
    await conversationRepository.delete(conversationId);

    // 3. 建立新對話
    const newConversation = await createNewConversation(userId, conversation.characterId, character);

    console.log(`✅ [conversationService] 重啟完成，新對話 ID: ${newConversation.id}`);

    return {
      conversationId: newConversation.id,
      messages: [],
      title: newConversation.title,
      createdAt: newConversation.createdAt,
      updatedAt: newConversation.updatedAt,
    };
  },
};
