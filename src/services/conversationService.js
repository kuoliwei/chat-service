import { getOrCreateConversation, retryConversationCreation } from './conversationCreationService.js';
import {
  getAllConversations,
  getConversationsSummary,
  deleteConversation,
  deleteConversationsByCharacter,
} from './conversationCrudService.js';
import {
  sendMessage,
  getMessages,
  getMessagesByConversationId,
  getMessageById,
  deleteMessageAndSubsequent,
} from './messageService.js';
import {
  sendMessageToConversation,
  _generateAIResponseAsync,
  getAIGenerationStatus,
  clearAIGenerationStatus,
} from './aiGenerationService.js';
import { getProtagonist, updateProtagonist } from './protagonistService.js';

// ========== conversationService（組裝層 / barrel） ==========
//
// 本檔曾是 1000+ 行、7 種職責混在一起的單一檔案。依《程式撰寫設計原則.md》
// 列出的職責清單拆成下列模組後，這裡只負責把它們重新組裝成 controller 慣用的
// 單一物件介面——controller 的 16 處呼叫因此完全不需修改。
//
// 職責 1：對話 CRUD（讀取／列表／刪除）  → conversationCrudService.js
// 職責 2：訊息 CRUD                      → messageService.js
// 職責 3：摘要機制                        → summaryService.js（被職責 5 使用）
// 職責 4：對話建立狀態機                  → conversationCreationService.js
// 職責 5：AI 生成狀態機                   → aiGenerationService.js
// 職責 6：擁有權檢查                      → conversationOwnership.js（共用葉節點）
// 職責 7：主角人設                        → protagonistService.js
//
// ⚠️ 依賴方向必須維持單向：各子模組彼此可直接 import，但一律不得 import 本檔，
// 否則會形成 barrel → 子模組 → barrel 的循環依賴。

export const conversationService = {
  // 職責 4：對話建立狀態機
  getOrCreateConversation,
  retryConversationCreation,

  // 職責 1：對話 CRUD
  getAllConversations,
  getConversationsSummary,
  deleteConversation,
  deleteConversationsByCharacter,

  // 職責 2：訊息 CRUD
  sendMessage,
  getMessages,
  getMessagesByConversationId,
  getMessageById,
  deleteMessageAndSubsequent,

  // 職責 5：AI 生成狀態機
  sendMessageToConversation,
  _generateAIResponseAsync,
  getAIGenerationStatus,
  clearAIGenerationStatus,

  // 職責 7：主角人設
  getProtagonist,
  updateProtagonist,
};
