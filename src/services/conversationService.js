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
 * 計算聊天歷史的總字數（排除最新的 N 條訊息）
 * 注意：傳入的 messages 應該已由資料庫過濾為未摘要的訊息
 * @param {Array} messages - 訊息陣列（已過濾未摘要）
 * @param {number} excludeLatestCount - 要排除的最新訊息數（預設 0）
 * @returns {number} 總字數
 */
function calculateHistoryLength(messages, excludeLatestCount = 0) {
  const messagesToCount = excludeLatestCount > 0
    ? messages.slice(0, -excludeLatestCount)
    : messages;
  return messagesToCount.reduce((total, msg) => total + (msg.text ? msg.text.length : 0), 0);
}

/**
 * 檢查是否需要觸發摘要機制
 * @param {Array} messages - 未摘要的訊息陣列
 * @param {number} threshold - 觸發閾值（預設從 config 讀取）
 * @param {number} shortTermLimit - 保留的最新訊息數（預設從 config 讀取）
 * @returns {Object|null} { needsSummary: boolean, messagesToSummarize: Array } 或 null
 */
function checkIfNeedsSummary(messages, threshold = null, shortTermLimit = null) {
  const summaryConfig = config.summary;
  threshold = threshold ?? summaryConfig.threshold;
  shortTermLimit = shortTermLimit ?? summaryConfig.shortTermLimit;

  // 訊息不足以觸發摘要（需要超過保留訊息數）
  if (messages.length <= shortTermLimit) {
    return null;
  }

  // 計算需要被考慮摘要的訊息（排除最新的 shortTermLimit 條）
  const candidateMessages = messages.slice(0, -shortTermLimit);
  const historyLength = calculateHistoryLength(candidateMessages);

  console.log(`📊 [conversationService] 摘要檢查: 歷史字數=${historyLength}, 閾值=${threshold}, 需要摘要=${historyLength >= threshold}`);

  if (historyLength >= threshold) {
    return {
      needsSummary: true,
      messagesToSummarize: candidateMessages,
      totalLength: historyLength
    };
  }

  return null;
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
 * 執行摘要機制：生成摘要、存入向量資料庫、標記訊息
 * @param {string} conversationId - 聊天室 ID
 * @param {Array} messagesToSummarize - 需要摘要的訊息陣列
 * @returns {Promise<Object|null>} 摘要結果或 null
 */
async function executeSummary(conversationId, messagesToSummarize) {
  if (!messagesToSummarize || messagesToSummarize.length === 0) {
    return null;
  }

  console.log(`\n♻️  [conversationService] 啟動摘要機制: conversationId=${conversationId}, 訊息數=${messagesToSummarize.length}`);

  try {
    // 1. 組裝要摘要的文本
    const textToSummarize = messagesToSummarize
      .map(msg => `[${msg.role}] ${msg.text}`)
      .join('\n');

    console.log(`  ├── 📥 被摘要的訊息:`);
    messagesToSummarize.forEach((msg, idx) => {
      console.log(`  │   ${idx + 1}. [${msg.role}] ${msg.text.substring(0, 50)}...`);
    });

    // 2. 調用 ai-service 生成摘要
    const summaryConfig = config.summary;
    const summaryPrompt = `請將以下對話內容縮減為一段 ${summaryConfig.maxWords} 字以內的摘要，保留關鍵事實。請使用對話中使用的語言進行總結：\n\n${textToSummarize}`;

    console.log(`  ├── 🔄 呼叫 ai-service 生成摘要...`);
    const summaryResult = await serviceClient.generateSummary(conversationId, summaryPrompt);

    console.log(`  ├── 📤 摘要結果: ${summaryResult}`);

    // 3. 將摘要存入向量資料庫
    console.log(`  ├── 💾 存入向量資料庫...`);
    await serviceClient.addSummary(conversationId, summaryResult);

    // 4. 標記這些訊息為已摘要
    console.log(`  ├── 🏷️  標記訊息為已摘要...`);
    for (const msg of messagesToSummarize) {
      await messageRepository.update(msg.id, { summarized: true });
    }

    console.log(`  ✅ [系統] 摘要完成，${messagesToSummarize.length} 條訊息已標記`);
    console.log(`  ${'-'.repeat(50)}\n`);

    return {
      summaryId: `summary_${Date.now()}`,
      summary: summaryResult,
      summarizedCount: messagesToSummarize.length
    };
  } catch (error) {
    console.error(`  ❌ [conversationService] 摘要執行失敗:`, error.message);
    // 不中斷對話流程，只記錄錯誤
    return null;
  }
}

/**
 * 聊天室建立流程的記憶體狀態追蹤
 * key: `${userId}:${characterId}`
 * value: { status: 'preparing' | 'failed', error?: string }
 * 注意：聊天室一旦成功寫入 DB，就從這裡移除（DB 有記錄 = 已就緒）
 */
const creationJobs = new Map();

/**
 * 背景發起聊天室建立流程（非同步）
 * 流程：發起 RAG 初始化 → 初始化進度由 getOrCreateConversation 輪詢檢查
 * @param {string} userId - 用戶 ID
 * @param {string} characterId - 角色 ID
 * @param {Object} character - 角色信息對象
 * @param {string} jobKey - creationJobs 的 key
 * @param {string} conversationId - 生成的聊天室 ID
 * @returns {Promise<void>}
 */
async function _prepareAndCreateConversation(userId, characterId, character, jobKey, conversationId) {
  console.log(`\n🏗️  [背景任務] 發起聊天室建立`);
  console.log(`  ├─ conversationId: ${conversationId}`);
  console.log(`  ├─ userId: ${userId}`);
  console.log(`  ├─ character: ${character.name}`);
  console.log(`  └─ jobKey: ${jobKey}`);

  try {
    // === 1. 發起 RAG 初始化 ===
    console.log(`\n  🧠 [背景任務] 發起 RAG 初始化`);

    // 轉換 fewShots 格式：[{user, char}] → ["user msg\nchar msg", ...]
    const fewshotsArray = (character.fewShots || []).map(shot => {
      if (typeof shot === 'string') {
        return shot;
      }
      return `${shot.user}\n${shot.char}`;
    });

    const ragData = {
      conversation_id: conversationId,
      character_id: characterId,
      background: character.background || '',
      fewshots: fewshotsArray
    };
    console.log(`  ├─ 📊 RAG 初始化資料:`);
    console.log(`  ├─   background: ${(ragData.background || '').length} 字`);
    console.log(`  ├─   fewshots: ${ragData.fewshots.length} 個`);

    // 發起初始化（ai-service 立即回 202，背景進行）
    console.log(`  ├─ 📤 呼叫 ai-service POST /conversations/initialize...`);
    await serviceClient.initializeRAG(ragData);
    console.log(`  ✅ [背景任務] RAG 初始化請求已發送`);

    // === 2. 等待 RAG 初始化完成 ===
    console.log(`  ├─ ⏳ 【背景任務】等待 RAG 初始化完成...`);
    let ragStatus = 'pending';
    let checkAttempts = 0;
    const maxAttempts = 120; // 最多等 120 秒

    while (ragStatus !== 'ready' && checkAttempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // sleep 1 秒
      checkAttempts++;

      const statusData = await serviceClient.checkRAGStatus(conversationId);
      ragStatus = statusData;

      if (ragStatus === 'ready') {
        console.log(`  ├─ ✅ 【背景任務】RAG 初始化完成 (${checkAttempts} 秒)`);
        break;
      }

      if (ragStatus === 'failed') {
        throw new Error(`RAG 初始化失敗`);
      }
    }

    if (ragStatus !== 'ready') {
      throw new Error(`RAG 初始化超時（超過 ${maxAttempts} 秒）`);
    }

    // === 3. 直接寫入 DB ===
    console.log(`  ├─ 📝 【背景任務】寫入 DB...`);
    await conversationRepository.create({
      id: conversationId,
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
    });
    console.log(`  ├─ ✅ 【背景任務】DB 寫入成功`);

    // === 4. 保存開場白 ===
    if (character.opening) {
      await messageRepository.create({
        conversationId,
        role: 'assistant',
        text: character.opening,
      });
      console.log(`  ├─ 💬 【背景任務】開場白已保存`);
    }

    // === 5. 標記 job 狀態為 ready ===
    creationJobs.set(jobKey, { status: 'ready', conversationId });
    console.log(`  └─ ✅ 【背景任務】標記狀態: ready\n`);

  } catch (error) {
    console.error(`\n  ❌ 【背景任務】失敗: ${error.message}`);

    // 失敗 → 標記 job 為 failed
    creationJobs.set(jobKey, { status: 'failed', error: error.message });
    console.error(`  └─ job 已標記為 failed\n`);
  }
}

/**
 * 創建新對話的內部函數
 * @param {string} userId - 用戶 ID
 * @param {string} characterId - 角色 ID
 * @param {Object} character - 角色信息
 * @returns {Promise<Object>} 包含 id、messages 等的對話對象
 */
async function createNewConversation(userId, characterId, character) {
  const conversationId = generateConversationId();

  console.log(`  ├─ 📝 創建新對話: ${conversationId}`);

  // 寫入 DB
  await conversationRepository.create({
    id: conversationId,
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
  });

  const messages = [];

  // 保存開場白（如果有）
  if (character.opening) {
    const openingMessage = await messageRepository.create({
      conversationId,
      role: 'assistant',
      text: character.opening,
    });
    messages.push(openingMessage);
    console.log(`  ├─ 💬 開場白已保存`);
  }

  console.log(`  ✅ 新對話創建完成: ${conversationId}`);

  return {
    id: conversationId,
    userId,
    characterId,
    title: null,
    messages,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// 🆕 請求追蹤計數器（用於識別並發請求）
let requestCounter = 0;

export const conversationService = {
  async getOrCreateConversation(userId, characterId) {
    // 🆕 為每個請求分配唯一 ID，用於追蹤並發請求
    const requestId = ++requestCounter;
    const timestamp = new Date().toISOString().split('T')[1];
    console.log(`\n📨 [conversationService] 收到建立聊天室請求 #${requestId} (${timestamp}): userId=${userId}, characterId=${characterId}`);

    validateUserId(userId);

    if (!characterId) {
      throw new Error('MISSING_CHARACTER_ID');
    }

    // 🆕 驗證角色是否存在（調用 character-service）
    console.log(`  ├─ 【請求 #${requestId}】驗證角色存在性...`);
    let character;
    try {
      character = await serviceClient.getCharacter(characterId, userId);  // 🆕 傳遞 userId
      console.log(`  ├─ 【請求 #${requestId}】✅ 角色驗證通過: ${character.name}`);
    } catch (error) {
      console.error(`  ├─ 【請求 #${requestId}】❌ 角色驗證失敗:`, error.message);
      if (error.message === 'CHARACTER_NOT_FOUND') {
        throw new Error('CHARACTER_NOT_FOUND');
      }
      throw error;
    }

    // === 步驟 1：查詢現有對話，存在就直接回傳（ready）===
    console.log(`  ├─ 【請求 #${requestId}】[步驟 1] 查詢現有對話...`);
    const conversation = await conversationRepository.findFirst(
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

    if (conversation) {
      console.log(`  ├─ 【請求 #${requestId}】✅ 對話已存在: conversationId=${conversation.id}, 訊息數=${conversation.messages?.length || 0}`);
      console.log(`  └─ 【請求 #${requestId}】回傳 ready\n`);
      return {
        status: 'ready',
        conversationId: conversation.id,
        messages: conversation.messages || [],
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      };
    }

    console.log(`  ├─ 【請求 #${requestId}】對話不存在，進入步驟 2`);

    // === 步驟 2：不存在 → 檢查背景建立 job ===
    const jobKey = `${userId}:${characterId}`;
    const job = creationJobs.get(jobKey);

    console.log(`  ├─ 【請求 #${requestId}】[步驟 2] 檢查 job 狀態: jobKey=${jobKey}`);
    if (job) {
      console.log(`  ├─ 【請求 #${requestId}】⚠️  job 已存在: status=${job.status}, conversationId=${job.conversationId}`);

      if (job.status === 'failed') {
        // 回報失敗，但【不自動刪除 job】
        // 讓前端持續看到失敗狀態，由使用者主動重試
        console.log(`  ├─ 【請求 #${requestId}】❌ job 已失敗，攔截該請求，回傳 failed`);
        console.log(`  ├─ 失敗原因: ${job.error || 'unknown'}`);
        console.log(`  └─ 【請求 #${requestId}】回傳 failed\n`);
        return {
          status: 'failed',
          message: job.error || '聊天室建立失敗',
          canRetry: true  // 🆕 告訴前端可以重試
        };
      }

      // 🆕 job 準備中 → 主動查詢 ai-service 的 RAG 初始化狀態
      if (job.status === 'preparing') {
        console.log(`  ├─ 【請求 #${requestId}】🔄 job 準備中，攔截該請求，查詢 ai-service RAG 狀態...`);
        try {
          const ragStatus = await serviceClient.checkRAGStatus(job.conversationId);
          console.log(`  ├─ RAG 狀態: ${ragStatus}`);

          if (ragStatus === 'ready') {
            // RAG 已完成 → 現在寫入 DB
            console.log(`  ├─ RAG 初始化完成，開始寫入 DB`);
            await conversationRepository.create({
              id: job.conversationId,
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
            });
            console.log(`  ├─ 聊天室記錄已寫入 DB`);

            // 保存開場白
            if (character.opening) {
              await messageRepository.create({
                conversationId: job.conversationId,
                role: 'assistant',
                text: character.opening,
              });
              console.log(`  ├─ 開場白已保存`);
            }

            // 成功：清除 job、查詢完整聊天室資料、回傳 ready
            creationJobs.delete(jobKey);
            const completeConversation = await conversationRepository.findFirst(
              { id: job.conversationId },
              { messages: { orderBy: { createdAt: 'asc' } } }
            );

            console.log(`  ✅ 聊天室建立完成: conversationId=${completeConversation.id}\n`);
            return {
              status: 'ready',
              conversationId: completeConversation.id,
              messages: completeConversation.messages || [],
              title: completeConversation.title,
              createdAt: completeConversation.createdAt,
              updatedAt: completeConversation.updatedAt,
            };
          }

          if (ragStatus === 'failed') {
            // RAG 初始化失敗
            console.log(`  ├─ RAG 初始化失敗`);
            creationJobs.set(jobKey, { status: 'failed', error: 'RAG initialization failed' });
            return { status: 'failed', message: 'RAG initialization failed' };
          }

          // pending → 仍在初始化中
          console.log(`  ├─ RAG 仍在初始化中，回傳 preparing`);
          return { status: 'preparing' };

        } catch (error) {
          console.error(`  ├─ 查詢 RAG 狀態失敗: ${error.message}`);
          // 查詢失敗不急著標記失敗，可能只是暫時網絡問題，維持 preparing
          console.log(`  ├─ 維持 preparing，下次輪詢重試`);
          return { status: 'preparing' };
        }
      }
    }

    // === 步驟 3：沒有 job → 啟動背景建立，立即回傳 preparing ===
    const conversationId = generateConversationId();
    creationJobs.set(jobKey, { status: 'preparing', conversationId });
    console.log(`  ├─ 【請求 #${requestId}】[步驟 3] ✅ 創建新 job，允許該請求繼續`);
    console.log(`  ├─ conversationId: ${conversationId}`);
    console.log(`  ├─ character: ${character.name}`);
    console.log(`  └─ 發起 RAG 初始化...\n`);
    // fire-and-forget（不 await）
    _prepareAndCreateConversation(userId, characterId, character, jobKey, conversationId);

    return { status: 'preparing' };
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

    // 獲取未摘要的訊息（包括剛剛新加的用戶訊息）
    let unsummarizedMessages = await messageRepository.findUnsummarized(conversation.id);

    // 🆕 檢查並執行摘要機制（先摘要，再生成回應）
    const summaryCheck = checkIfNeedsSummary(unsummarizedMessages);
    if (summaryCheck && summaryCheck.needsSummary) {
      console.log(`[conversationService] 檢測到需要摘要，先執行摘要...`);
      await executeSummary(conversation.id, summaryCheck.messagesToSummarize);
      // 摘要完成後，重新獲取未摘要的訊息
      unsummarizedMessages = await messageRepository.findUnsummarized(conversation.id);
    }

    // 🆕 建立佔位的 AI 訊息（狀態為 pending）
    const assistantMessage = await messageRepository.create({
      conversationId: conversation.id,
      role: 'assistant',
      text: `（${conversation.characterName} 正在思考中...）`,
      status: 'pending',
    });

    console.log(`💬 [conversationService] AI 佔位訊息已建立: id=${assistantMessage.id}`);

    // 🆕 立即返回（不等 AI 生成完成）
    const response = {
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

    // 🆕 在背景異步生成 AI 回覆（不 await）
    console.log(`⏳ [conversationService] 背景生成 AI 回覆: messageId=${assistantMessage.id}`);
    this._generateAIResponseAsync(conversation, assistantMessage.id, unsummarizedMessages);

    // 立即返回
    return response;
  },

  // 🆕 異步生成 AI 回覆並更新訊息
  async _generateAIResponseAsync(conversation, assistantMessageId, allMessages) {
    try {
      // 組裝請求
      const aiRequest = await buildAIServiceRequest(conversation.id, conversation, allMessages);

      // 呼叫 AI 服務
      const result = await serviceClient.generateResponse(aiRequest);
      const aiResponse = result.message;
      console.log(`✅ [conversationService] AI 回應已取得: messageId=${assistantMessageId}`);

      // 更新訊息文本和狀態
      await messageRepository.update(assistantMessageId, {
        text: aiResponse,
        status: 'completed',
      });

      console.log(`💬 [conversationService] AI 訊息已更新: id=${assistantMessageId}`);
    } catch (error) {
      console.error(`❌ [conversationService] 背景生成失敗:`, error.message);
      // 錯誤時用預設回應
      const fallbackMessage = `（${conversation.characterName} 暫時無法回應，請稍後再試。）`;
      await messageRepository.update(assistantMessageId, {
        text: fallbackMessage,
        status: 'completed',
      });
      console.log(`⚠️  [conversationService] 已用預設回應更新訊息`);
    }
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

  async getMessagesByConversationId(conversationId, limit = 50, offset = 0) {
    if (!conversationId) {
      throw new Error('MISSING_CONVERSATION_ID');
    }

    // 查詢對話是否存在
    const conversation = await conversationRepository.findFirst({
      id: conversationId,
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
      messages: newConversation.messages,
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
    const character = await serviceClient.getCharacter(conversation.characterId, userId);

    // 2. 刪除舊對話
    console.log(`🗑️ [conversationService] 刪除舊對話: ${conversationId}`);
    await conversationRepository.delete(conversationId);

    // 3. 建立新對話
    const newConversation = await createNewConversation(userId, conversation.characterId, character);

    console.log(`✅ [conversationService] 重啟完成，新對話 ID: ${newConversation.id}`);

    return {
      conversationId: newConversation.id,
      messages: newConversation.messages,
      title: newConversation.title,
      createdAt: newConversation.createdAt,
      updatedAt: newConversation.updatedAt,
    };
  },

  // 🆕 查詢單一訊息（用於前端輪詢 AI 完成狀態）
  async getMessageById(conversationId, messageId) {
    if (!conversationId || !messageId) {
      throw new Error('MISSING_PARAMS');
    }

    const message = await messageRepository.findFirst({
      id: messageId,
      conversationId,
    });

    if (!message) {
      throw new Error('MESSAGE_NOT_FOUND');
    }

    return {
      id: message.id,
      role: message.role,
      text: message.text,
      status: message.status,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  },

  // 🆕 清除失敗的 job，讓使用者重試建立聊天室
  async retryConversationCreation(userId, characterId) {
    validateUserId(userId);

    if (!characterId) {
      throw new Error('MISSING_CHARACTER_ID');
    }

    const jobKey = `${userId}:${characterId}`;
    const job = creationJobs.get(jobKey);

    if (!job) {
      console.log(`  ⚠️  [conversationService] job 不存在，無需清除: ${jobKey}`);
      throw new Error('NO_FAILED_JOB');
    }

    if (job.status !== 'failed') {
      console.log(`  ⚠️  [conversationService] job 狀態不是 failed (status=${job.status})，無法重試`);
      throw new Error('JOB_NOT_FAILED');
    }

    // 清除失敗 job，允許重新開始
    console.log(`  🔄 [conversationService] 清除失敗 job，允許重試: ${jobKey}`);
    creationJobs.delete(jobKey);

    return {
      status: 'cleared',
      message: '失敗狀態已清除，請重新開啟聊天室'
    };
  },
};
