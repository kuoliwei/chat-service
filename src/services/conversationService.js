import { conversationRepository, messageRepository } from '../repositories/conversationRepository.js';
import { serviceClient } from '../lib/serviceClient.js';

function generateConversationId() {
  return `conv_${Date.now()}`;
}

function validateUserId(userId) {
  if (!userId) {
    throw new Error('UNAUTHORIZED');
  }
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
      console.log(`➕ [conversationService] 建立新對話: userId=${userId}, characterId=${characterId}`);
      console.log(`📸 [conversationService] 保存角色快照: ${character.name}`);

      conversation = await conversationRepository.create({
        id: generateConversationId(),
        userId,
        characterId,
        title: null,
        // 🆕 角色快照（防止後續編輯影響已有對話）
        characterName: character.name,
        characterGender: character.gender,
        characterTags: JSON.stringify(character.tags || []),
        characterIntroduction: character.introduction,
        characterBackground: character.background,
        characterOpening: character.opening,
        characterFewShots: JSON.stringify(character.fewShots || []),
      });
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

  async sendMessageToConversation(userId, conversationId, role, text) {
    validateUserId(userId);

    if (!conversationId) {
      throw new Error('MISSING_CONVERSATION_ID');
    }

    if (!text) {
      throw new Error('MISSING_TEXT');
    }

    if (!role || !['user', 'assistant'].includes(role)) {
      throw new Error('INVALID_ROLE');
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

    return { message: 'Conversation deleted successfully' };
  },

  async deleteConversationsByCharacter(userId, characterId) {
    validateUserId(userId);

    if (!characterId) {
      throw new Error('MISSING_CHARACTER_ID');
    }

    // 驗證角色是否存在
    await serviceClient.getCharacter(characterId);

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

    // 3. 建立新對話（帶角色快照）
    console.log(`➕ [conversationService] 建立新對話: userId=${userId}, characterId=${characterId}`);
    const newConversation = await conversationRepository.create({
      id: generateConversationId(),
      userId,
      characterId,
      title: null,
      // 角色快照
      characterName: character.name,
      characterGender: character.gender,
      characterTags: JSON.stringify(character.tags || []),
      characterIntroduction: character.introduction,
      characterBackground: character.background,
      characterOpening: character.opening,
      characterFewShots: JSON.stringify(character.fewShots || []),
    });

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

    // 3. 建立新對話（帶角色快照）
    console.log(`➕ [conversationService] 建立新對話`);
    const newConversation = await conversationRepository.create({
      id: generateConversationId(),
      userId,
      characterId: conversation.characterId,
      title: null,
      // 角色快照
      characterName: character.name,
      characterGender: character.gender,
      characterTags: JSON.stringify(character.tags || []),
      characterIntroduction: character.introduction,
      characterBackground: character.background,
      characterOpening: character.opening,
      characterFewShots: JSON.stringify(character.fewShots || []),
    });

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
