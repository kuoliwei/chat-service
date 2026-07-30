import { conversationRepository, messageRepository } from '../repositories/conversationRepository.js';
import { generationStatusRepository } from '../repositories/generationStatusRepository.js';
import { serviceClient } from '../lib/serviceClient.js';
import { validateUserId, assertConversationOwnership } from './conversationOwnership.js';

// ========== 職責 2：訊息 CRUD ==========
//
// 訊息的保存、查詢與刪除。觸發 AI 生成的那條路徑（sendMessageToConversation）
// 屬於職責 5，在 aiGenerationService.js。
//
// 回溯式刪除（deleteMessageAndSubsequent）是本檔最複雜的部分：刪一則使用者訊息
// 會連帶刪除其後所有訊息，且若刪除範圍涉及已摘要的訊息，必須連動清除對應的
// Qdrant 摘要——否則角色會「記得」已經被刪掉的劇情。

/**
 * 同步發送訊息到某角色的最新對話（不觸發 AI 生成，僅單純保存訊息）
 * @param {string} userId - 使用者 ID
 * @param {string} characterId - 角色 ID
 * @param {'user'|'assistant'} role - 訊息角色
 * @param {string} text - 訊息內容
 * @returns {Promise<{id, role, text, createdAt}>} 已保存的訊息
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 * @throws {Error} 'MISSING_TEXT' 若 text 缺失
 * @throws {Error} 'INVALID_ROLE' 若 role 不是 'user' 或 'assistant'
 * @throws {Error} 'CONVERSATION_NOT_FOUND' 若該角色尚無對話
 */
export async function sendMessage(userId, characterId, role, text) {
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
}

/**
 * 依角色查詢訊息列表（舊方法，透過 characterId 找該用戶與該角色的對話）
 * @param {string} userId - 使用者 ID
 * @param {string} characterId - 角色 ID
 * @param {number} [limit=50] - 回傳筆數上限
 * @param {number} [offset=0] - 略過筆數
 * @returns {Promise<Array<Object>>} 訊息陣列，依 createdAt 遞增排序
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 * @throws {Error} 'CONVERSATION_NOT_FOUND' 若該角色尚無對話
 */
export async function getMessages(userId, characterId, limit = 50, offset = 0) {
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
}

/**
 * 依對話 ID 查詢訊息列表（新方法，供前端與內部服務／ai-service 呼叫）
 * @param {string} userId - 使用者 ID
 * @param {string} conversationId - 對話 ID
 * @param {number} [limit=50] - 回傳筆數上限
 * @param {number} [offset=0] - 略過筆數
 * @param {Object} [options]
 * @param {boolean} [options.isInternalRequest] - true 時跳過 userId 擁有權比對
 * @returns {Promise<Array<Object>>} 訊息陣列，依 createdAt 遞增排序
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失（非內部請求）
 * @throws {Error} 'MISSING_CONVERSATION_ID' 若 conversationId 缺失
 * @throws {Error} 'CONVERSATION_NOT_FOUND' 若對話不存在
 * @throws {Error} 'FORBIDDEN' 若無權限存取該對話
 */
export async function getMessagesByConversationId(userId, conversationId, limit = 50, offset = 0, { isInternalRequest } = {}) {
  // 🔒 擁有權檢查：修正前這裡只確認 conversationId 存在，沒驗證是否屬於呼叫者，
  // 任何登入者帶任意 conversationId 都能讀到別人的完整對話內容。
  // 內部呼叫（isInternalRequest）跳過擁有權比對，供 ai-service 查詢對話歷史。
  const conversation = await assertConversationOwnership(userId, conversationId, { isInternalRequest });

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
}

/**
 * 查詢單一訊息（供前端輪詢 AI 生成完成後配對真實訊息）
 * @param {string} userId - 使用者 ID
 * @param {string} conversationId - 對話 ID
 * @param {string} messageId - 訊息 ID
 * @returns {Promise<{id, role, text, status, createdAt, updatedAt}>}
 * @throws {Error} 'MISSING_PARAMS' 若 conversationId 或 messageId 缺失
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 * @throws {Error} 'CONVERSATION_NOT_FOUND' 若對話不存在
 * @throws {Error} 'FORBIDDEN' 若無權限存取該對話
 * @throws {Error} 'MESSAGE_NOT_FOUND' 若訊息不存在
 */
export async function getMessageById(userId, conversationId, messageId) {
  if (!conversationId || !messageId) {
    throw new Error('MISSING_PARAMS');
  }

  // 🔒 擁有權檢查：修正前這裡完全沒驗證 userId，任何登入者帶任意
  // conversationId/messageId 都能讀到別人單一則訊息的完整內容。
  await assertConversationOwnership(userId, conversationId);

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
}

/**
 * 回溯式刪除：刪除指定用戶訊息及其後所有訊息，對話裁剪回該訊息發出之前的狀態
 * 若刪除範圍涉及已摘要的訊息，連帶刪除對應 Qdrant 摘要，並將刪除點之前、被同一摘要
 * 涵蓋的訊息標回未摘要
 * @param {string} userId - 使用者 ID
 * @param {string} conversationId - 對話 ID
 * @param {string} messageId - 要刪除的目標訊息 ID（必須是 role='user' 的訊息）
 * @returns {Promise<{deletedCount: number, deletedIds: string[]}>}
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 * @throws {Error} 'MISSING_PARAMS' 若 conversationId 或 messageId 缺失
 * @throws {Error} 'CONVERSATION_NOT_FOUND' 若對話不存在
 * @throws {Error} 'FORBIDDEN' 若無權限存取該對話
 * @throws {Error} 'AI_GENERATION_IN_PROGRESS' 若該對話正在生成 AI 回覆
 * @throws {Error} 'MESSAGE_NOT_FOUND' 若目標訊息不存在
 * @throws {Error} 'NOT_USER_MESSAGE' 若目標訊息不是使用者訊息
 * @throws {Error} 'SERVICE_ERROR' 若 Qdrant 摘要刪除失敗（此時 DB 訊息未被刪除）
 */
export async function deleteMessageAndSubsequent(userId, conversationId, messageId) {
  // 缺 userId 一律先回 UNAUTHORIZED，維持與其他方法一致的錯誤優先序。
  validateUserId(userId);

  // MISSING_PARAMS 涵蓋兩者缺一，順序要在擁有權檢查之前——
  // 否則 messageId 缺失時會被 assertConversationOwnership 放行，
  // 誤判成 MESSAGE_NOT_FOUND 而不是「缺少參數」。
  if (!conversationId || !messageId) {
    throw new Error('MISSING_PARAMS');
  }

  // 驗證對話存在與所有權
  const ownedConversation = await assertConversationOwnership(userId, conversationId);

  // 🆕 【生成中拒絕】AI 正在生成時不允許刪除（生成完成會存入新訊息，會打架）
  const deleteTimeGenStatus = generationStatusRepository.get(ownedConversation);
  if (deleteTimeGenStatus?.status === 'generating') {
    console.log(`🚫 [messageService] 聊天室 ${conversationId} AI 生成中，拒絕刪除訊息`);
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

  console.log(`\n🗑️ [messageService] ===== 回溯刪除開始: conversationId=${conversationId} =====`);
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
  console.log(`🗑️ [messageService] ===== 回溯刪除完成 =====\n`);

  // 清除該聊天室的舊生成狀態（completed/failed 已無意義）
  await generationStatusRepository.reset(conversationId);

  return {
    deletedCount: result.count,
    deletedIds: idsToDelete,
  };
}
