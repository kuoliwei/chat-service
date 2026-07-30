import { messageRepository, generationStatusRepository } from '../repositories/conversationRepository.js';
import { serviceClient } from '../lib/serviceClient.js';
import { config } from '../config/index.js';
import { assertConversationOwnership } from './conversationOwnership.js';
import { checkIfNeedsSummary, executeSummary } from './summaryService.js';

// ========== 職責 5：AI 生成狀態機 ==========
//
// 一個「生成回合」的完整協定：
//   1. 原子性搶鎖（generating）——同一聊天室同時只允許一個回合，含殭屍鎖逾時保險
//   2. 前置流程：撈未摘要訊息 → 必要時先做摘要（任何環節失敗都要先解鎖再拋出）
//   3. 立即回 accepted，AI 生成在背景進行
//   4. 生成成功才「原子性」保存使用者訊息 + AI 回覆，並寫入臨時 ID 配對資訊
//   5. 前端透過 getAIGenerationStatus 輪詢結果
//
// AI 生成狀態持久化在 Conversation 表的 generationStatus 等欄位
// （原本是進程內記憶體 Map，服務重啟即遺失、多實例不共享，已改為 DB 欄位）。
// config.persistence.enableGenerationStatus 可切換回記憶體版本（僅供本機測試，見 config.txt）。

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

  // 2. 轉換成請求格式（只需要 role 和 text）
  //    直接送全部傳入的訊息（即未摘要訊息）——短期記憶窗口完全由摘要機制決定，
  //    不再額外截斷（原 maxMessages/slice 機制已移除）
  const conversationHistory = messages.map(msg => ({
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
 * 背景生成 AI 回覆並原子性保存用戶訊息＋AI 訊息（由 sendMessageToConversation 呼叫，不對外暴露）
 * 成功時同時寫入兩則訊息並將生成狀態設為 completed；失敗時兩則訊息都不保存，狀態設為 failed
 * @param {Object} conversation - 對話物件
 * @param {Array} allMessages - 已保存的未摘要訊息（不含本次用戶訊息）
 * @param {string} userText - 本次使用者訊息內容
 * @param {string} [tempUserId] - 前端臨時訊息 ID，供完成狀態配對
 * @returns {Promise<void>} 不拋出異常，錯誤透過 generationStatusRepository.setFailed 記錄
 */
export async function _generateAIResponseAsync(conversation, allMessages, userText, tempUserId) {
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

    // 記錄成功狀態，讓前端可以檢測到生成完成
    // 🆕 附上「臨時 ID ↔ 真實 ID」配對資訊，前端據此精準替換
    await generationStatusRepository.setCompleted(conversation.id, {
      tempUserId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
    });
    console.log(`✅ [conversationService] AI 生成狀態已更新為 'completed'`);
    console.log(`🐛 [DEBUG] ===== 配對資訊已寫入 =====`);
    console.log(`🐛 [DEBUG]   tempUserId（前端臨時）: ${tempUserId || null}`);
    console.log(`🐛 [DEBUG]   userMessageId（真實）: ${userMessage.id}`);
    console.log(`🐛 [DEBUG]   assistantMessageId（真實）: ${assistantMessage.id}`);
  } catch (error) {
    console.error(`❌ [conversationService] 背景生成失敗:`, error.message);
    console.log(`⚠️  [conversationService] 用戶訊息與 AI 訊息都不保存（失敗時不持久化）`);

    // 記錄失敗狀態，讓前端可以查詢
    await generationStatusRepository.setFailed(conversation.id, error.message);
    console.log(`⚠️  [conversationService] AI 回應失敗已記錄，前端將透過狀態查詢偵測`);
  }
}

/**
 * 非同步發送訊息到指定對話並觸發 AI 生成（立即回 accepted，背景生成回覆）
 * 同一對話已有生成任務進行中時會拒絕（並行防護），成功時會先執行摘要機制（若達閾值）
 * 再背景呼叫 AI 服務，結果透過 getAIGenerationStatus 輪詢取得
 * @param {string} userId - 使用者 ID
 * @param {string} conversationId - 對話 ID
 * @param {string} text - 使用者訊息內容
 * @param {string} [tempUserId] - 前端臨時訊息 ID，生成完成後放入狀態供前端配對替換
 * @param {Object} [options]
 * @param {boolean} [options.isInternalRequest] - true 時跳過 userId 擁有權比對（供內部服務呼叫）
 * @returns {Promise<{status: 'accepted', message: string}>}
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失（非內部請求）
 * @throws {Error} 'MISSING_CONVERSATION_ID' 若 conversationId 缺失
 * @throws {Error} 'CONVERSATION_NOT_FOUND' 若對話不存在
 * @throws {Error} 'FORBIDDEN' 若無權限存取該對話
 * @throws {Error} 'MISSING_TEXT' 若 text 缺失
 * @throws {Error} 'AI_GENERATION_IN_PROGRESS' 若該對話已有生成任務進行中
 */
export async function sendMessageToConversation(userId, conversationId, text, tempUserId, { isInternalRequest } = {}) {
  // 先授權再驗輸入：無權存取這個聊天室的人，不該因為送出的內容格式不同
  // 而收到不一樣的回應（400 vs 403 的差異本身就是一種資訊）。
  const conversation = await assertConversationOwnership(userId, conversationId, { isInternalRequest });

  if (!text) {
    throw new Error('MISSING_TEXT');
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
  //   // 記錄失敗狀態到 DB，讓前端可以立即查詢（使用具體的錯誤信息）
  //   await conversationRepository.update(conversation.id, {
  //     generationStatus: 'failed',
  //     generationError: error.message,  // ← 使用具體的錯誤信息
  //     generationUpdatedAt: new Date(),
  //   });
  //   throw new Error(`AI_SERVICE_UNAVAILABLE: ${error.message}`);
  // }

  // 🆕 【第二步：拒絕並行生成】同一聊天室已有任務進行中 → 拒絕
  // 原子性搶鎖交給 generationStatusRepository：persistence 開啟時用 DB updateMany
  // 的 where 條件做「檢查後更新」；關閉時用記憶體 Map + 單執行緒同步區塊，效果相同。
  // where/檢查條件涵蓋「目前不是 generating」或「是 generating 但已超過殭屍鎖時限」，
  // 回傳 false 代表這兩個條件都不成立（別人正持有有效的鎖），視為搶鎖失敗。
  // 🔑 tempUserId 一併傳入：上鎖同時標記「本回合身分」並清掉上一回合殘留的訊息 ID，
  // 讓前端輪詢能分辨讀到的狀態屬於哪一回合（詳見 tryAcquireLock 的註解）。
  const staleLimitMs = (config.ai?.timeouts?.generateResponse || 60000) + 30000;
  const acquired = await generationStatusRepository.tryAcquireLock(conversation.id, staleLimitMs, { tempUserId });

  if (!acquired) {
    console.log(`🚫 [conversationService] 聊天室 ${conversation.id} 已有 AI 生成任務進行中，拒絕新訊息`);
    throw new Error('AI_GENERATION_IN_PROGRESS');
  }
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
    await generationStatusRepository.releaseLock(conversation.id);
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
  // （拆檔前這裡是 this._generateAIResponseAsync；改為直接呼叫模組內函式，
  //   不再隱性依賴 barrel 是否把該方法合併進同一個物件）
  _generateAIResponseAsync(conversation, unsummarizedMessages, text, tempUserId);

  // 立即返回
  return response;
}

/**
 * 查詢對話目前的 AI 生成狀態（供前端輪詢用）
 * 🔒 擁有權檢查：修正前只認 conversationId，任何登入者都能查詢別人對話的
 * AI 生成狀態（改成 async 是因為擁有權檢查需要查一次資料庫）。
 * @param {string} userId - 使用者 ID
 * @param {string} conversationId - 對話 ID
 * @returns {Promise<Object>} { status: 'generating'|'completed'|'failed'|'unknown', error?,
 *   tempUserId?, userMessageId?, assistantMessageId?, timestamp? }
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 * @throws {Error} 'MISSING_CONVERSATION_ID' 若 conversationId 缺失
 * @throws {Error} 'CONVERSATION_NOT_FOUND' 若對話不存在
 * @throws {Error} 'FORBIDDEN' 若無權限存取該對話
 */
export async function getAIGenerationStatus(userId, conversationId) {
  const conversation = await assertConversationOwnership(userId, conversationId);
  const genStatus = generationStatusRepository.get(conversation);

  if (!genStatus) {
    // 沒有記錄 = 還沒開始或已完成
    return {
      status: 'unknown',
      message: 'No generation status record'
    };
  }

  console.log(`📊 [conversationService] 查詢 AI 生成狀態: conversationId=${conversationId}, 狀態=${genStatus.status}`);

  return {
    status: genStatus.status,
    error: genStatus.error || undefined,
    tempUserId: genStatus.tempUserId || undefined,
    userMessageId: genStatus.userMessageId || undefined,
    assistantMessageId: genStatus.assistantMessageId || undefined,
    timestamp: genStatus.updatedAt ? genStatus.updatedAt.getTime() : undefined,
  };
}

/**
 * 清除對話的 AI 生成狀態記錄（用戶重試或其他操作後呼叫，避免殘留舊狀態）
 * 🔒 擁有權檢查：修正前只認 conversationId，任何登入者都能清除別人對話的
 * AI 生成狀態記錄（改成 async 是因為擁有權檢查需要查一次資料庫）。
 * @param {string} userId - 使用者 ID
 * @param {string} conversationId - 對話 ID
 * @returns {Promise<void>}
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 * @throws {Error} 'MISSING_CONVERSATION_ID' 若 conversationId 缺失
 * @throws {Error} 'CONVERSATION_NOT_FOUND' 若對話不存在
 * @throws {Error} 'FORBIDDEN' 若無權限存取該對話
 */
export async function clearAIGenerationStatus(userId, conversationId) {
  const conversation = await assertConversationOwnership(userId, conversationId);
  const genStatus = generationStatusRepository.get(conversation);

  if (genStatus) {
    await generationStatusRepository.reset(conversationId);
    console.log(`🗑️ [conversationService] 已清除 AI 生成狀態: conversationId=${conversationId}`);
  }
}
