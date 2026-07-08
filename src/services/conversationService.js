import { conversationRepository, messageRepository } from '../repositories/conversationRepository.js';
import { serviceClient } from '../lib/serviceClient.js';
import { config } from '../config/index.js';

// 🆕 內存 Map：跟蹤 AI 生成狀態（成功、失敗）
// Key: conversationId, Value: { status: 'generating'|'completed'|'failed', error?: string }
const aiGenerationStatus = new Map();

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
    console.log(`🐛 [DEBUG] 訊息數(${messages.length}) <= shortTermLimit(${shortTermLimit})，不觸發摘要`);
    return null;
  }

  // 計算需要被考慮摘要的訊息（排除最新的 shortTermLimit 條）
  const candidateMessages = messages.slice(0, -shortTermLimit);
  const excludedMessages = messages.slice(-shortTermLimit);
  const historyLength = calculateHistoryLength(candidateMessages);

  // 🐛 【DEBUG】列印被送去摘要的候選訊息
  console.log(`🐛 [DEBUG] ===== 摘要候選訊息（將被製作成摘要，共 ${candidateMessages.length} 條）=====`);
  candidateMessages.forEach((msg, idx) => {
    console.log(`🐛 [DEBUG]   候選 ${idx + 1}. id=${msg.id} [${msg.role}] createdAt=${msg.createdAt?.toISOString?.() || msg.createdAt} | ${msg.text}`);
  });

  // 🐛 【DEBUG】列印被排除（保留）的最新訊息
  console.log(`🐛 [DEBUG] ===== 被排除的最新 ${shortTermLimit} 條（不摘要，保留為短期記憶）=====`);
  excludedMessages.forEach((msg, idx) => {
    console.log(`🐛 [DEBUG]   排除 ${idx + 1}. id=${msg.id} [${msg.role}] createdAt=${msg.createdAt?.toISOString?.() || msg.createdAt} | ${msg.text}`);
  });

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
  // 🆕 protagonist_name：主角（主人公）名稱，未設定為 null（ai-service 不注入主角段落）
  const request = {
    conversation_id: conversationId,
    character_info: characterInfo,
    conversation_history: conversationHistory,
    protagonist_name: conversation.protagonistName || null
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
  // 🆕 【被動報錯】RAG 清理失敗時直接拋異常，中斷刪除流程
  // 呼叫端必須先清 RAG、成功後才刪 DB，確保不會留下孤兒資料
  await serviceClient.cleanupRAG(conversationId);
  console.log(`✅ [conversationService] RAG 清理成功`);
}

/**
 * 執行摘要機制：生成摘要、存入向量資料庫、標記訊息
 * @param {string} conversationId - 聊天室 ID
 * @param {Array} messagesToSummarize - 需要摘要的訊息陣列
 * @returns {Promise<Object>} 摘要結果
 * @throws 如果摘要過程失敗（包括 RAG 不可用）
 */
async function executeSummary(conversationId, messagesToSummarize) {
  if (!messagesToSummarize || messagesToSummarize.length === 0) {
    return null;
  }

  console.log(`\n♻️  [conversationService] 啟動摘要機制: conversationId=${conversationId}, 訊息數=${messagesToSummarize.length}`);

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
  // 🆕 【被動報錯】如果 RAG 不可用，直接拋異常，中斷對話流程
  // 🆕 回傳值為 ai-service 生成的 summary_id（= Qdrant point id）
  console.log(`  ├── 💾 存入向量資料庫...`);
  const summaryId = await serviceClient.addSummary(conversationId, summaryResult);

  // 4. 標記這些訊息為已摘要，並記錄涵蓋它們的摘要 ID（供日後回溯刪除時精準配對）
  console.log(`  ├── 🏷️  標記訊息為已摘要（summaryId=${summaryId}）...`);
  for (const msg of messagesToSummarize) {
    await messageRepository.update(msg.id, { summarized: true, summaryId });
  }

  console.log(`  ✅ [系統] 摘要完成，${messagesToSummarize.length} 條訊息已標記（summaryId=${summaryId}）`);
  console.log(`  ${'-'.repeat(50)}\n`);

  return {
    summaryId,
    summary: summaryResult,
    summarizedCount: messagesToSummarize.length
  };
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

    // 轉換 fewShots 格式：[{user, char}] → ["User: user msg\nCharacter: char msg", ...]
    // 🆕 加上說話者標籤（User:/Character: 冒號風格，LLM 訓練語料中最常見的對話標記慣例），
    // 讓 LLM 明確知道範例中哪句是用戶、哪句是角色——標籤在存入 RAG 時就寫進文本
    const fewshotsArray = (character.fewShots || []).map(shot => {
      if (typeof shot === 'string') {
        return shot;
      }
      return `User: ${shot.user}\nCharacter: ${shot.char}`;
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
        // 刪除失敗的 job，但返回失敗給用戶
        // 用戶可以手動點擊重試，下次請求就能重新檢查
        console.log(`  ├─ 【請求 #${requestId}】❌ job 已失敗，清除舊 job`);
        console.log(`  ├─ 失敗原因: ${job.error || 'unknown'}`);
        creationJobs.delete(jobKey);
        console.log(`  └─ 【請求 #${requestId}】回傳 503（用戶可重試）\n`);
        return {
          status: 'failed',
          message: job.error || '聊天室建立失敗'
        };
      }

      if (job.status === 'preparing') {
        // job 準備中 → 主動查詢 ai-service 的 RAG 初始化狀態
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

    // === 步驟 3：沒有 job → 【新增】先檢查 AI Service 健康 ===
    // 🆕 【實驗性註解】暫時停用健檢觸發，觀察無健檢時錯誤是否仍能正確傳播
    // console.log(`  ├─ 【請求 #${requestId}】[步驟 3] 檢查 AI Service 健康狀態...`);
    // try {
    //   await serviceClient.checkAIServiceHealth();
    // } catch (error) {
    //   // 🆕 【統一風格】用 throw error，而不是返回錯誤對象
    //   // 這樣可以使用具體的錯誤信息，而不是固定的通用消息
    //   console.log(`  ├─ 【請求 #${requestId}】❌ AI Service 無法連接: ${error.message}`);
    //   const errorMsg = error.message;
    //   creationJobs.set(jobKey, { status: 'failed', error: errorMsg });
    //   throw new Error(`AI_SERVICE_UNAVAILABLE: ${errorMsg}`);
    // }

    // === 步驟 4：AI Service 可用 → 啟動背景建立，立即回傳 preparing ===
    const conversationId = generateConversationId();
    creationJobs.set(jobKey, { status: 'preparing', conversationId });
    console.log(`  ├─ 【請求 #${requestId}】[步驟 4] ✅ 創建新 job，允許該請求繼續`);
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

  // 🆕 tempUserId（可選）：前端臨時訊息 ID，生成成功後放入狀態供前端配對替換
  async sendMessageToConversation(userId, conversationId, text, tempUserId) {
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

    // 🆕 【實驗性註解】暫時停用健檢觸發，觀察無健檢時錯誤是否仍能正確傳播
    // // 🆕 【健康檢查】模仿建立聊天室的方式，先檢查 AI Service
    // console.log(`🏥 [conversationService] 檢查 AI Service 健康狀態...`);
    // try {
    //   await serviceClient.checkAIServiceHealth();
    //   console.log(`✅ [conversationService] AI Service 健康，繼續發送訊息`);
    // } catch (error) {
    //   // 🆕 【統一錯誤處理】捕獲具體的錯誤信息，而不是使用固定的通用消息
    //   console.error(`❌ [conversationService] AI Service 無法連接: ${error.message}`);
    //
    //   // 記錄失敗狀態到內存 Map，讓前端可以立即查詢（使用具體的錯誤信息）
    //   aiGenerationStatus.set(conversation.id, {
    //     status: 'failed',
    //     error: error.message,  // ← 使用具體的錯誤信息
    //     timestamp: Date.now()
    //   });
    //   throw new Error(`AI_SERVICE_UNAVAILABLE: ${error.message}`);
    // }

    // 🆕 【第二步：拒絕並行生成】同一聊天室已有任務進行中 → 拒絕
    // 【原子性】檢查後立刻上鎖，中間不能有任何 await——
    // Node 單線程下同一個同步區塊不會被其他請求插隊，堵住競態窗口
    const existingStatus = aiGenerationStatus.get(conversation.id);
    if (existingStatus && existingStatus.status === 'generating') {
      // 🆕 【第三步：殭屍鎖保險】generating 超過時限視為失效，放行新請求
      // 時限 = generateResponse timeout + 30 秒緩衝（異步任務最久等 timeout 就會進 catch）
      const staleLimitMs = (config.ai?.timeouts?.generateResponse || 60000) + 30000;
      const lockAgeMs = Date.now() - (existingStatus.timestamp || 0);

      if (lockAgeMs < staleLimitMs) {
        console.log(`🚫 [conversationService] 聊天室 ${conversation.id} 已有 AI 生成任務進行中（已 ${Math.round(lockAgeMs / 1000)} 秒），拒絕新訊息`);
        throw new Error('AI_GENERATION_IN_PROGRESS');
      }

      // 鎖已過期：不應該發生的異常狀態，記警告後放行（下面會覆寫新鎖）
      console.warn(`⚠️  [conversationService] 偵測到殭屍鎖: 聊天室 ${conversation.id} 的 generating 狀態已掛 ${Math.round(lockAgeMs / 1000)} 秒（時限 ${staleLimitMs / 1000} 秒），視為失效並放行`);
    }
    aiGenerationStatus.set(conversation.id, {
      status: 'generating',
      timestamp: Date.now()
    });
    console.log(`🔒 [conversationService] 已上鎖（generating），開始處理訊息`);

    // 🆕 【重大改動】不立即保存用戶訊息
    // 改為：在 AI 生成成功後，才同時保存用戶訊息 + AI 回覆
    // 這樣可以避免：AI 生成失敗時，用戶訊息孤立在資料庫
    console.log(`⏳ [conversationService] 暫不保存用戶訊息，等待 AI 生成結果...`);

    // 🆕 【失敗解鎖】上鎖後、啟動異步任務前，任何環節拋錯都要先解鎖再拋出
    // 否則鎖會殘留在 Map 中，聊天室被永久鎖死
    let unsummarizedMessages;
    try {
      // 獲取未摘要的訊息（不包括這次的用戶訊息，因為還沒保存）
      unsummarizedMessages = await messageRepository.findUnsummarized(conversation.id);

      // 🐛 【DEBUG】列印撈出的所有未摘要訊息
      console.log(`\n🐛 [DEBUG] ===== 撈出未摘要訊息（summarized=false，共 ${unsummarizedMessages.length} 條）=====`);
      unsummarizedMessages.forEach((msg, idx) => {
        console.log(`🐛 [DEBUG]   ${idx + 1}. id=${msg.id} [${msg.role}] createdAt=${msg.createdAt?.toISOString?.() || msg.createdAt} | ${msg.text}`);
      });

      // 🆕 檢查並執行摘要機制（先摘要，再生成回應）
      const summaryCheck = checkIfNeedsSummary(unsummarizedMessages);
      if (summaryCheck && summaryCheck.needsSummary) {
        console.log(`[conversationService] 檢測到需要摘要，先執行摘要...`);
        await executeSummary(conversation.id, summaryCheck.messagesToSummarize);
        // 摘要完成後，重新獲取未摘要的訊息
        unsummarizedMessages = await messageRepository.findUnsummarized(conversation.id);
      }
    } catch (error) {
      // 解鎖後再拋出，讓 controller 回傳錯誤
      console.log(`🔓 [conversationService] 前置流程失敗，解鎖並拋出: ${error.message}`);
      aiGenerationStatus.delete(conversation.id);
      throw error;
    }

    // 🆕 【立即返回】前端已經用臨時 ID 顯示訊息了
    // 後端只需確認收到，異步生成 AI 回復
    // 成功後才同時保存用戶訊息 + AI 訊息
    const response = {
      status: 'accepted',
      message: 'Message received, AI generation in progress',
    };

    // 在背景異步生成 AI 回覆（不 await，不創建占位符）
    // 注意：'generating' 鎖已在流程開頭（檢查後）原子性地上好，此處不再重複寫入
    console.log(`⏳ [conversationService] 背景生成 AI 回覆`);

    // 🆕 傳入用戶訊息文本與臨時 ID，讓異步任務保存並回報配對
    this._generateAIResponseAsync(conversation, unsummarizedMessages, text, tempUserId);

    // 立即返回
    return response;
  },

  // 異步生成 AI 回覆並創建訊息
  // 🆕 【重大改動】同時保存用戶訊息 + AI 回覆（原子性）
  // tempUserId（可選）：前端臨時訊息 ID，成功時放入狀態供前端配對
  async _generateAIResponseAsync(conversation, allMessages, userText, tempUserId) {
    try {
      // 🆕 組裝包含新用戶訊息的對話列表（用於 AI 上下文）
      const messagesForAI = [
        ...allMessages,
        { role: 'user', text: userText, createdAt: new Date().toISOString() }
      ];
      console.log(`📋 [conversationService] AI 上下文訊息數: ${messagesForAI.length}`);

      // 組裝請求
      const aiRequest = await buildAIServiceRequest(conversation.id, conversation, messagesForAI);

      // 呼叫 AI 服務
      const result = await serviceClient.generateResponse(aiRequest);
      const aiResponse = result.message;
      console.log(`✅ [conversationService] AI 回應已取得`);

      // 🆕 【原子性保存】同時創建用戶訊息 + AI 訊息
      console.log(`💾 [conversationService] 開始原子性保存：用戶訊息 + AI 訊息...`);

      // 1. 先保存用戶訊息
      const userMessage = await messageRepository.create({
        conversationId: conversation.id,
        role: 'user',
        text: userText,
      });
      console.log(`📝 [conversationService] 用戶訊息已保存: id=${userMessage.id}`);

      // 2. 再保存 AI 訊息
      const assistantMessage = await messageRepository.create({
        conversationId: conversation.id,
        role: 'assistant',
        text: aiResponse,
        status: 'completed',
      });

      console.log(`💬 [conversationService] AI 訊息已創建: id=${assistantMessage.id}`);
      console.log(`  【DEBUG】AI 訊息詳情: ID: ${assistantMessage.id.substring(0, 8)}..., status: ${assistantMessage.status}, createdAt: ${assistantMessage.createdAt}`);

      // 記錄成功狀態到內存 Map，讓前端可以檢測到生成完成
      // 🆕 附上「臨時 ID ↔ 真實 ID」配對資訊，前端據此精準替換
      const completedStatus = {
        status: 'completed',
        tempUserId: tempUserId || null,          // 前端送來的臨時用戶訊息 ID
        userMessageId: userMessage.id,           // 剛存入 DB 的用戶訊息真實 ID
        assistantMessageId: assistantMessage.id, // 剛存入 DB 的 AI 訊息真實 ID
        timestamp: Date.now()
      };
      aiGenerationStatus.set(conversation.id, completedStatus);
      console.log(`✅ [conversationService] AI 生成狀態已更新為 'completed'`);
      console.log(`🐛 [DEBUG] ===== 配對資訊已寫入狀態 Map =====`);
      console.log(`🐛 [DEBUG]   tempUserId（前端臨時）: ${completedStatus.tempUserId}`);
      console.log(`🐛 [DEBUG]   userMessageId（DB 真實）: ${completedStatus.userMessageId}`);
      console.log(`🐛 [DEBUG]   assistantMessageId（DB 真實）: ${completedStatus.assistantMessageId}`);
    } catch (error) {
      console.error(`❌ [conversationService] 背景生成失敗:`, error.message);
      console.log(`⚠️  [conversationService] 用戶訊息與 AI 訊息都不保存（失敗時不持久化）`);

      // 記錄失敗狀態到內存 Map，讓前端可以查詢
      aiGenerationStatus.set(conversation.id, {
        status: 'failed',
        error: error.message,
        timestamp: Date.now()
      });
      console.log(`⚠️  [conversationService] AI 回應失敗已記錄，前端將透過狀態查詢偵測`);
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

    // 【DEBUG】打印所有訊息及其順序
    console.log(`📋 [DEBUG getMessagesByConversationId] 訊息總數: ${messages.length}`);
    messages.forEach((m, idx) => {
      console.log(`  [${idx}] ID: ${m.id.substring(0, 8)}..., role: ${m.role}, status: ${m.status}, createdAt: ${m.createdAt}`);
    });

    const slicedMessages = messages.slice(offset, offset + limit);
    console.log(`📋 [DEBUG getMessagesByConversationId] 返回訊息數（slice 後）: ${slicedMessages.length}`);

    return slicedMessages;
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

    // 🆕 【順序調換】先清理 RAG 資料，失敗會拋錯中斷，此時 DB 還完好
    await cleanupConversationRAG(conversationId);

    // RAG 清理成功，才刪除對話（訊息會自動刪除，因為有 onDelete: Cascade）
    console.log(`🗑️ [conversationService] 刪除對話: conversationId=${conversationId}`);
    await conversationRepository.delete(conversationId);

    // 🆕 清除內存中的 AI 生成狀態記錄
    aiGenerationStatus.delete(conversationId);

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

    // 🆕 【順序調換】先清理每個對話的 RAG 資料，失敗會拋錯中斷，此時 DB 還完好
    console.log(`🧹 [conversationService] 清理 RAG 資料: 共 ${conversations.length} 個聊天室`);
    for (const conversation of conversations) {
      await cleanupConversationRAG(conversation.id);
    }

    // RAG 全部清理成功，才刪除所有對話
    console.log(`🗑️ [conversationService] 刪除角色對話: userId=${userId}, characterId=${characterId}, count=${conversations.length}`);
    await conversationRepository.deleteByCharacterId(characterId, userId);

    // 🆕 清除每個對話在內存中的 AI 生成狀態記錄
    for (const conversation of conversations) {
      aiGenerationStatus.delete(conversation.id);
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

  // 🆕 【主角人設】讀取聊天室的主角名稱與背景
  async getProtagonist(userId, conversationId) {
    validateUserId(userId);

    if (!conversationId) {
      throw new Error('MISSING_CONVERSATION_ID');
    }

    const conversation = await conversationRepository.findFirst({ id: conversationId });
    if (!conversation) {
      throw new Error('CONVERSATION_NOT_FOUND');
    }
    if (conversation.userId !== userId) {
      throw new Error('FORBIDDEN');
    }

    return {
      protagonistName: conversation.protagonistName,
      protagonistBackground: conversation.protagonistBackground,
    };
  },

  // 🆕 【主角人設】更新聊天室的主角名稱與背景
  // 流程：先更新 RAG（背景切片，失敗拋錯中止）→ 成功後才寫 DB（與刪除的順序原則一致）
  async updateProtagonist(userId, conversationId, protagonistName, protagonistBackground) {
    validateUserId(userId);

    if (!conversationId) {
      throw new Error('MISSING_CONVERSATION_ID');
    }

    const conversation = await conversationRepository.findFirst({ id: conversationId });
    if (!conversation) {
      throw new Error('CONVERSATION_NOT_FOUND');
    }
    if (conversation.userId !== userId) {
      throw new Error('FORBIDDEN');
    }

    console.log(`\n👤 [conversationService] 更新主角人設: conversationId=${conversationId}`);
    console.log(`   ├─ 名稱: ${protagonistName || '(空)'}`);
    console.log(`   ├─ 背景: ${(protagonistBackground || '').length} 字`);

    // 1. 先更新 RAG（ai-service 會刪舊切片再存新切片；失敗拋錯，DB 不動）
    await serviceClient.updateProtagonistRAG(conversationId, protagonistBackground || '');
    console.log(`   ├─ ✅ RAG 主角背景切片已更新`);

    // 2. RAG 成功後才寫 DB
    await conversationRepository.update(conversationId, {
      protagonistName: protagonistName || null,
      protagonistBackground: protagonistBackground || null,
    });
    console.log(`   └─ ✅ DB 主角欄位已更新\n`);

    return {
      protagonistName: protagonistName || null,
      protagonistBackground: protagonistBackground || null,
    };
  },

  // 🆕 【刪除訊息】刪除指定的用戶訊息及其後所有訊息（回溯式刪除）
  // 語義：對話裁剪回該訊息發出之前的狀態，之後的用戶訊息與 AI 回覆全部刪除
  async deleteMessageAndSubsequent(userId, conversationId, messageId) {
    validateUserId(userId);

    if (!conversationId || !messageId) {
      throw new Error('MISSING_PARAMS');
    }

    // 驗證對話存在與所有權
    const conversation = await conversationRepository.findFirst({ id: conversationId });
    if (!conversation) {
      throw new Error('CONVERSATION_NOT_FOUND');
    }
    if (conversation.userId !== userId) {
      throw new Error('FORBIDDEN');
    }

    // 🆕 【生成中拒絕】AI 正在生成時不允許刪除（生成完成會存入新訊息，會打架）
    const genStatus = aiGenerationStatus.get(conversationId);
    if (genStatus && genStatus.status === 'generating') {
      console.log(`🚫 [conversationService] 聊天室 ${conversationId} AI 生成中，拒絕刪除訊息`);
      throw new Error('AI_GENERATION_IN_PROGRESS');
    }

    // 驗證目標訊息存在、屬於該對話、且是用戶自己的訊息
    const targetMessage = await messageRepository.findFirst({
      id: messageId,
      conversationId,
    });
    if (!targetMessage) {
      throw new Error('MESSAGE_NOT_FOUND');
    }
    if (targetMessage.role !== 'user') {
      throw new Error('NOT_USER_MESSAGE');
    }

    // 撈出全部訊息（時間升序），找到目標的位置，其後（含目標）全部刪除
    // 用排序位置而非 createdAt 比較，避免同毫秒時間戳的邊界問題
    const allMessages = await messageRepository.findMany(
      { conversationId },
      { createdAt: 'asc' }
    );
    const targetIndex = allMessages.findIndex(m => m.id === messageId);
    if (targetIndex === -1) {
      throw new Error('MESSAGE_NOT_FOUND');
    }

    const messagesToDelete = allMessages.slice(targetIndex);
    const idsToDelete = messagesToDelete.map(m => m.id);

    console.log(`\n🗑️ [conversationService] ===== 回溯刪除開始: conversationId=${conversationId} =====`);
    console.log(`🐛 [DEBUG] 目標訊息: id=${messageId}（位置 ${targetIndex + 1}/${allMessages.length}）`);

    // 🐛 【DEBUG】對話全貌：每條訊息的位置、id、摘要歸屬，並標記刪除線
    console.log(`🐛 [DEBUG] ----- 對話全貌（共 ${allMessages.length} 條，>>> 起為刪除範圍）-----`);
    allMessages.forEach((m, idx) => {
      const marker = idx >= targetIndex ? '>>>' : '   ';
      const summaryTag = m.summaryId ? `summaryId=${m.summaryId}` : (m.summarized ? 'summarized(舊資料,無id)' : '未摘要');
      console.log(`🐛 [DEBUG] ${marker} ${idx + 1}. id=${m.id} [${m.role}] ${summaryTag} | ${m.text.substring(0, 30)}...`);
    });

    console.log(`🐛 [DEBUG] ----- 將被刪除的訊息（共 ${idsToDelete.length} 條）-----`);
    messagesToDelete.forEach((m, idx) => {
      console.log(`🐛 [DEBUG]   刪除 ${idx + 1}. id=${m.id} [${m.role}] | ${m.text.substring(0, 30)}...`);
    });

    // 🆕 【記憶清理】收集刪除範圍內訊息的 summaryId（去重、排除 null）
    // 這些摘要涵蓋了被刪的訊息，必須連帶刪除，否則角色會「記得」被刪的劇情
    const summaryIdsToDelete = [...new Set(
      messagesToDelete.map(m => m.summaryId).filter(Boolean)
    )];

    if (summaryIdsToDelete.length > 0) {
      console.log(`🐛 [DEBUG] ----- 將被刪除的摘要（共 ${summaryIdsToDelete.length} 份）-----`);
      summaryIdsToDelete.forEach((sid, idx) => {
        const coveredInRange = messagesToDelete.filter(m => m.summaryId === sid).map(m => m.id);
        console.log(`🐛 [DEBUG]   摘要 ${idx + 1}. summaryId=${sid}（涵蓋刪除範圍內的訊息: ${coveredInRange.join(', ')}）`);
      });

      // 找出刪除點之前、被這些摘要涵蓋的訊息——摘要刪除後，它們要標回未摘要
      const messagesToUnmark = allMessages
        .slice(0, targetIndex)
        .filter(m => m.summaryId && summaryIdsToDelete.includes(m.summaryId));

      console.log(`🐛 [DEBUG] ----- 將標回未摘要的訊息（刪除點之前、共 ${messagesToUnmark.length} 條）-----`);
      messagesToUnmark.forEach((m, idx) => {
        console.log(`🐛 [DEBUG]   標回 ${idx + 1}. id=${m.id} [${m.role}] 原 summaryId=${m.summaryId} | ${m.text.substring(0, 30)}...`);
      });

      // 【順序關鍵】先刪 Qdrant 摘要（失敗拋錯中止，DB 完好），成功後才動 DB
      console.log(`🐛 [DEBUG] 步驟 1/3: 呼叫 ai-service 刪除 Qdrant 摘要...`);
      await serviceClient.deleteSummaries(conversationId, summaryIdsToDelete);
      console.log(`🐛 [DEBUG] 步驟 1/3 ✅ Qdrant 摘要已刪除: ${summaryIdsToDelete.join(', ')}`);

      // 標回未摘要（之後累積夠了會再次被摘要）
      console.log(`🐛 [DEBUG] 步驟 2/3: 標回未摘要...`);
      for (const msg of messagesToUnmark) {
        await messageRepository.update(msg.id, { summarized: false, summaryId: null });
        console.log(`🐛 [DEBUG]   ✅ id=${msg.id} → summarized=false, summaryId=null`);
      }
    } else {
      console.log(`🐛 [DEBUG] 刪除範圍不涉及任何摘要（summaryId 皆為 null），跳過記憶清理`);
      console.log(`🐛 [DEBUG] 步驟 1/3、2/3 跳過`);
    }

    console.log(`🐛 [DEBUG] 步驟 3/3: 刪除 DB 訊息...`);
    const result = await messageRepository.deleteManyByIds(idsToDelete);
    console.log(`🐛 [DEBUG] 步驟 3/3 ✅ 已刪除 ${result.count} 條訊息`);
    console.log(`🗑️ [conversationService] ===== 回溯刪除完成 =====\n`);

    // 清除該聊天室的舊生成狀態（completed/failed 已無意義）
    aiGenerationStatus.delete(conversationId);

    return {
      deletedCount: result.count,
      deletedIds: idsToDelete,
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

  // 🆕 查詢 AI 生成狀態（成功、失敗、生成中）
  getAIGenerationStatus(conversationId) {
    if (!conversationId) {
      throw new Error('MISSING_CONVERSATION_ID');
    }

    const status = aiGenerationStatus.get(conversationId);

    if (!status) {
      // 沒有記錄 = 還沒開始或已完成
      return {
        status: 'unknown',
        message: 'No generation status record'
      };
    }

    console.log(`📊 [conversationService] 查詢 AI 生成狀態: conversationId=${conversationId}, 狀態=${status.status}`);

    return status;
  },

  // 🆕 清除 AI 生成狀態（用戶重試或其他操作後）
  clearAIGenerationStatus(conversationId) {
    if (aiGenerationStatus.has(conversationId)) {
      aiGenerationStatus.delete(conversationId);
      console.log(`🗑️ [conversationService] 已清除 AI 生成狀態: conversationId=${conversationId}`);
    }
  },
};
