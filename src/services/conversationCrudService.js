import { conversationRepository } from '../repositories/conversationRepository.js';
import { serviceClient } from '../lib/serviceClient.js';
import { validateUserId, assertConversationOwnership } from './conversationOwnership.js';

// ========== 職責 1：對話 CRUD（讀取／列表／刪除） ==========
//
// 對話容器本身的讀取與銷毀。建立流程因為牽涉非同步狀態機，獨立在
// conversationCreationService.js（職責 4）。
//
// 刪除的順序原則：先清 RAG（失敗即中斷、DB 不動），成功才刪 DB——
// 確保不會留下「DB 沒了但向量庫還記得」的孤兒資料。

/**
 * 清理單個聊天室的 RAG 資料
 * @param {string} conversationId - 聊天室 ID
 * @returns {Promise<void>}
 * @throws {Error} 'SERVICE_ERROR' 前綴——RAG 清理失敗（呼叫端據此中斷刪除流程）
 */
async function cleanupConversationRAG(conversationId) {
  console.log(`🧹 [conversationService] 清理 RAG 資料: conversationId=${conversationId}`);
  // 🆕 【被動報錯】RAG 清理失敗時直接拋異常，中斷刪除流程
  // 呼叫端必須先清 RAG、成功後才刪 DB，確保不會留下孤兒資料
  await serviceClient.cleanupRAG(conversationId);
  console.log(`✅ [conversationService] RAG 清理成功`);
}

/**
 * 取得使用者的所有對話（含各對話最新一則訊息）
 * @param {string} userId - 使用者 ID
 * @returns {Promise<Array<Object>>} 對話列表，依 updatedAt 遞減排序
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 */
export async function getAllConversations(userId) {
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
}

/**
 * 取得使用者的所有對話摘要（輕量版，不含訊息內容，供列表頁快速載入）
 * @param {string} userId - 使用者 ID
 * @returns {Promise<Array<{conversationId, characterId, characterName, updatedAt}>>}
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 */
export async function getConversationsSummary(userId) {
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
}

/**
 * 刪除單一對話（含其所有訊息，Cascade）。先清理 RAG 資料，失敗則中斷、DB 不動
 * @param {string} userId - 使用者 ID
 * @param {string} conversationId - 對話 ID
 * @returns {Promise<{message: string}>}
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 * @throws {Error} 'MISSING_CONVERSATION_ID' 若 conversationId 缺失
 * @throws {Error} 'CONVERSATION_NOT_FOUND' 若對話不存在
 * @throws {Error} 'FORBIDDEN' 若無權限存取該對話
 * @throws {Error} 'SERVICE_ERROR' 若 RAG 清理失敗（前綴，實際訊息由 ai-service 回傳）
 */
export async function deleteConversation(userId, conversationId) {
  // 查詢對話是否存在且屬於該用戶
  await assertConversationOwnership(userId, conversationId);

  // 🆕 【順序調換】先清理 RAG 資料，失敗會拋錯中斷，此時 DB 還完好
  await cleanupConversationRAG(conversationId);

  // RAG 清理成功，才刪除對話（訊息會自動刪除，因為有 onDelete: Cascade）
  // AI 生成狀態存在 Conversation 表本身的欄位，整筆記錄刪除後自然一併清除，不需額外處理。
  console.log(`🗑️ [conversationService] 刪除對話: conversationId=${conversationId}`);
  await conversationRepository.delete(conversationId);

  return { message: 'Conversation deleted successfully' };
}

/**
 * 刪除某使用者與某角色的所有對話。逐一清理各對話的 RAG 資料，任一失敗即中斷、DB 不動
 * @param {string} userId - 使用者 ID
 * @param {string} characterId - 角色 ID
 * @returns {Promise<{message: string, deletedCount: number}>}
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 * @throws {Error} 'MISSING_CHARACTER_ID' 若 characterId 缺失
 * @throws {Error} 'NO_CONVERSATIONS_FOUND' 若該角色無任何對話
 * @throws {Error} 'SERVICE_ERROR' 若任一對話的 RAG 清理失敗
 */
export async function deleteConversationsByCharacter(userId, characterId) {
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
  // AI 生成狀態存在 Conversation 表本身的欄位，整筆記錄刪除後自然一併清除，不需額外處理。
  console.log(`🗑️ [conversationService] 刪除角色對話: userId=${userId}, characterId=${characterId}, count=${conversations.length}`);
  await conversationRepository.deleteByCharacterId(characterId, userId);

  return {
    message: `${conversations.length} conversation(s) deleted successfully`,
    deletedCount: conversations.length,
  };
}

// 🆕 重啟聊天室已改由前端複用「刪除 + 建立」既有管線，
// restartConversation / restartConversationById（不清 RAG、不初始化 RAG 的舊管線）已移除
