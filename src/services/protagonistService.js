import { conversationRepository } from '../repositories/conversationRepository.js';
import { serviceClient } from '../lib/serviceClient.js';
import { assertConversationOwnership } from './conversationOwnership.js';

// ========== 職責 7：主角人設 ==========
//
// 「主角」= 使用者在這個聊天室裡扮演的角色（有別於 AI 扮演的角色）。
// 名稱與背景存在 Conversation 表的 protagonistName/protagonistBackground 欄位，
// 背景另外會切片存進 RAG 供 AI 生成時檢索。
//
// 更新順序與對話刪除一致：先動 RAG（失敗即中斷），成功才寫 DB。

/**
 * 讀取對話的主角（使用者扮演角色）名稱與背景
 * @param {string} userId - 使用者 ID
 * @param {string} conversationId - 對話 ID
 * @returns {Promise<{protagonistName: string|null, protagonistBackground: string|null}>}
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 * @throws {Error} 'MISSING_CONVERSATION_ID' 若 conversationId 缺失
 * @throws {Error} 'CONVERSATION_NOT_FOUND' 若對話不存在
 * @throws {Error} 'FORBIDDEN' 若無權限存取該對話
 */
export async function getProtagonist(userId, conversationId) {
  const conversation = await assertConversationOwnership(userId, conversationId);

  return {
    protagonistName: conversation.protagonistName,
    protagonistBackground: conversation.protagonistBackground,
  };
}

/**
 * 更新對話的主角名稱與背景。先更新 RAG（背景切片，失敗拋錯中止），成功後才寫 DB
 * @param {string} userId - 使用者 ID
 * @param {string} conversationId - 對話 ID
 * @param {string} [protagonistName] - 主角名稱
 * @param {string} [protagonistBackground] - 主角背景文本
 * @returns {Promise<{protagonistName: string|null, protagonistBackground: string|null}>}
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 * @throws {Error} 'MISSING_CONVERSATION_ID' 若 conversationId 缺失
 * @throws {Error} 'CONVERSATION_NOT_FOUND' 若對話不存在
 * @throws {Error} 'FORBIDDEN' 若無權限存取該對話
 * @throws {Error} 'SERVICE_ERROR' 若 RAG 更新失敗
 */
export async function updateProtagonist(userId, conversationId, protagonistName, protagonistBackground) {
  await assertConversationOwnership(userId, conversationId);

  console.log(`\n👤 [protagonistService] 更新主角人設: conversationId=${conversationId}`);
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
}
