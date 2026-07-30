import { conversationRepository } from '../repositories/conversationRepository.js';

// ========== 職責 6：擁有權檢查 ==========
//
// 本檔是整個 service 層的共用核心，被 9 個以 conversationId 為主鍵的方法依賴。
// ⚠️ 必須維持葉節點：只能 import repository，絕不 import 任何兄弟 service 模組——
// 一旦這裡反向依賴其他模組，整個 service 層就會出現循環依賴。

/**
 * 驗證呼叫者身分存在（gateway 注入的 x-user-id）
 * @param {string} userId - 使用者 ID
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 */
export function validateUserId(userId) {
  if (!userId) {
    throw new Error('UNAUTHORIZED');
  }
}

// 🆕 【共用擁有權檢查】以 conversationId 為主鍵的方法都必須先過這一關。
//
// 背景：以 characterId 為主鍵的方法（如 getMessages）擁有權檢查內建在查詢條件
// 裡（findFirst({ userId, characterId })），想漏也漏不掉。但以 conversationId
// 為主鍵的方法只憑主鍵就查得到資料，擁有權得額外寫一行判斷——這裡曾經手刻了
// 4 次、也漏寫了 4 次（getMessagesByConversationId、getMessageById、
// getAIGenerationStatus、clearAIGenerationStatus 曾經完全不驗證 userId，
// 任何登入者都能讀到或清除別人對話的內容）。
// 集中成一個函式後，之後任何新方法都只有一種寫法可用。
/**
 * 驗證對話存在且屬於呼叫者，並回傳該對話
 * @param {string} userId - 使用者 ID
 * @param {string} conversationId - 對話 ID
 * @param {Object} [options]
 * @param {boolean} [options.isInternalRequest] - true 時跳過 userId 驗證與擁有權比對（供內部服務呼叫）
 * @returns {Promise<Object>} 該對話物件
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失（非內部請求）
 * @throws {Error} 'MISSING_CONVERSATION_ID' 若 conversationId 缺失
 * @throws {Error} 'CONVERSATION_NOT_FOUND' 若對話不存在
 * @throws {Error} 'FORBIDDEN' 若對話不屬於呼叫者（非內部請求）
 */
export async function assertConversationOwnership(userId, conversationId, { isInternalRequest } = {}) {
  if (!isInternalRequest) {
    validateUserId(userId);
  }

  if (!conversationId) {
    throw new Error('MISSING_CONVERSATION_ID');
  }

  const conversation = await conversationRepository.findFirst({ id: conversationId });

  if (!conversation) {
    throw new Error('CONVERSATION_NOT_FOUND');
  }

  if (!isInternalRequest && conversation.userId !== userId) {
    throw new Error('FORBIDDEN');
  }

  return conversation;
}
