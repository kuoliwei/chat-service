import { messageRepository } from '../repositories/conversationRepository.js';
import { serviceClient } from '../lib/serviceClient.js';
import { config } from '../config/index.js';

// ========== 職責 3：摘要機制 ==========
//
// 長期記憶壓縮：未摘要訊息累積到閾值時，把較舊的訊息壓成一份摘要存進向量庫，
// 短期記憶只保留最新 N 條。被摘要的訊息會記下涵蓋它的 summaryId，
// 供回溯刪除訊息時精準配對刪除對應摘要（見 messageService.deleteMessageAndSubsequent）。
//
// 葉節點模組：不依賴任何兄弟 service 模組。

/**
 * 計算訊息陣列的總字數
 * 注意：傳入的 messages 應該已由資料庫過濾為未摘要的訊息
 * @param {Array} messages - 訊息陣列（已過濾未摘要）
 * @returns {number} 總字數
 */
function calculateHistoryLength(messages) {
  return messages.reduce((total, msg) => total + (msg.text ? msg.text.length : 0), 0);
}

/**
 * 檢查是否需要觸發摘要機制
 * @param {Array} messages - 未摘要的訊息陣列
 * @param {number} [threshold] - 觸發閾值（預設從 config 讀取）
 * @param {number} [shortTermLimit] - 保留的最新訊息數（預設從 config 讀取）
 * @returns {Object|null} { needsSummary, messagesToSummarize, totalLength }；不需摘要時回 null
 */
export function checkIfNeedsSummary(messages, threshold = null, shortTermLimit = null) {
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

  console.log(`📊 [summaryService] 摘要檢查: 歷史字數=${historyLength}, 閾值=${threshold}, 需要摘要=${historyLength >= threshold}`);

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
 * 執行摘要機制：生成摘要、存入向量資料庫、標記訊息
 * @param {string} conversationId - 聊天室 ID
 * @param {Array} messagesToSummarize - 需要摘要的訊息陣列
 * @returns {Promise<{summaryId: string, summary: string, summarizedCount: number}|null>}
 *   傳入空陣列時回 null
 * @throws {Error} 'SERVICE_ERROR' 前綴——摘要生成或存入向量庫失敗（RAG 不可用等）
 */
export async function executeSummary(conversationId, messagesToSummarize) {
  if (!messagesToSummarize || messagesToSummarize.length === 0) {
    return null;
  }

  console.log(`\n♻️  [summaryService] 啟動摘要機制: conversationId=${conversationId}, 訊息數=${messagesToSummarize.length}`);

  // 1. 組裝要摘要的文本
  const textToSummarize = messagesToSummarize
    .map(msg => `[${msg.role}] ${msg.text}`)
    .join('\n');

  console.log(`  ├── 📥 被摘要的訊息:`);
  messagesToSummarize.forEach((msg, idx) => {
    console.log(`  │   ${idx + 1}. [${msg.role}] ${msg.text.substring(0, 50)}...`);
  });

  // 2. 調用 ai-service 生成摘要
  // 🆕 提示詞使用英文（模型對英文指令服從度較高）、markdown 結構化；中文對照如下：
  //   # 請將以下對話總結為約 ${maxWords} 字的摘要。
  //   ## 撰寫規則
  //   - 以第三人稱方式撰寫。
  //   - 內容需要包含關鍵情節。
  //   - 最後需要用一句話特別記錄角色對使用者的好感度如何。
  //   - 請使用對話中使用的語言進行總結。
  //   ## 對話內容
  //   {對話}
  const summaryConfig = config.summary;
  const summaryPrompt = `# Summarize the following conversation into a summary of approximately ${summaryConfig.maxWords} words.

## Writing Rules
- Write in the third person.
- Include the key plot points.
- End with one sentence specifically noting the character's affinity toward the user.
- Summarize in the same language used in the conversation.

## Conversation
${textToSummarize}`;

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
