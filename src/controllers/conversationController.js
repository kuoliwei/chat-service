import { conversationService } from '../services/conversationService.js';

// 固定 status + 固定 message 的錯誤碼查表；帶動態內容或依端點語意不同的錯誤碼
// （AI_GENERATION_IN_PROGRESS、SERVICE_ERROR: 前綴等）不納入，維持個別處理
const ERROR_MAP = {
  UNAUTHORIZED: { status: 401, message: 'Unauthorized' },
  MISSING_CHARACTER_ID: { status: 400, message: 'Missing characterId' },
  MISSING_CONVERSATION_ID: { status: 400, message: 'Missing conversationId' },
  MISSING_PARAMS: { status: 400, message: 'Missing conversationId or messageId' },
  MISSING_TEXT: { status: 400, message: 'Invalid request' },
  INVALID_ROLE: { status: 400, message: 'Invalid request' },
  CHARACTER_NOT_FOUND: { status: 404, message: 'Character not found' },
  CONVERSATION_NOT_FOUND: { status: 404, message: 'Conversation not found' },
  MESSAGE_NOT_FOUND: { status: 404, message: 'Message not found' },
  FORBIDDEN: { status: 403, message: 'Access denied' },
  NOT_USER_MESSAGE: { status: 400, message: '只能刪除自己發出的訊息' },
  NO_FAILED_JOB: { status: 404, message: 'No failed job found for this character' },
  JOB_NOT_FAILED: { status: 409, message: 'Job is not in failed state' },
  NO_CONVERSATIONS_FOUND: { status: 404, message: 'No conversations found for this character' },
};

/**
 * 統一的錯誤回應（與 auth / user / character 三服務的 respondError 慣例一致）
 *
 * 判斷順序：端點特有的覆寫 → SERVICE_ERROR 前綴 → 共用 ERROR_MAP → 500。
 * 覆寫擺第一是因為同一個錯誤碼在不同端點的語意確實不同——例如
 * AI_GENERATION_IN_PROGRESS 在發送端點要說「請等待回覆完成後再發送」，
 * 在刪除端點要說「請等待回覆完成後再刪除」；壓成同一句會讓前端無法給出正確提示。
 *
 * 日誌慣例（比照 character-service）：只有未命中 ERROR_MAP 的非預期例外才印 ❌，
 * 已知的語意錯誤（400/401/403/404/409）不重複印。
 *
 * @param {Object} res - Express response
 * @param {Error} error - service 層拋出的語意錯誤
 * @param {Object} [options]
 * @param {Object} [options.overrides] - 端點特有的錯誤碼覆寫 `{ CODE: { status, message } }`
 * @param {string} [options.serviceErrorPrefix] - 提供時，SERVICE_ERROR 回 503 且訊息為
 *   `${prefix}: ${ai-service 回傳的細節}`；未提供則 SERVICE_ERROR 落到 500
 * @returns {Object} Express response
 */
function respondWithError(res, error, { overrides, serviceErrorPrefix } = {}) {
  const override = overrides?.[error.message];
  if (override) {
    return res.status(override.status).json({ error: error.message, message: override.message });
  }

  // SERVICE_ERROR 帶 ai-service 回傳的動態細節，且各端點要說明「什麼沒被做掉」
  if (serviceErrorPrefix && error.message.startsWith('SERVICE_ERROR')) {
    const detail = error.message.replace('SERVICE_ERROR: ', '');
    return res.status(503).json({ error: 'SERVICE_ERROR', message: `${serviceErrorPrefix}: ${detail}` });
  }

  const mapped = ERROR_MAP[error.message];
  if (mapped) {
    return res.status(mapped.status).json({ error: error.message, message: mapped.message });
  }

  console.error('❌ [conversationController]', error);
  return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
}

// 端點特有的錯誤覆寫（同一錯誤碼在不同端點語意不同，不能壓平成共用表）
const FORBIDDEN_ON_CHARACTER = {
  FORBIDDEN: { status: 403, message: 'Access denied to this character' },
};
const INVALID_REQUEST_ON_SEND = {
  MISSING_CONVERSATION_ID: { status: 400, message: 'Invalid request' },
  MISSING_TEXT: { status: 400, message: 'Invalid request' },
  AI_GENERATION_IN_PROGRESS: { status: 409, message: '上一條訊息仍在處理中，請等待回覆完成後再發送' },
};
const GENERATION_IN_PROGRESS_ON_DELETE = {
  AI_GENERATION_IN_PROGRESS: { status: 409, message: 'AI 正在回覆中，請等待回覆完成後再刪除' },
};

export const conversationController = {
  async getOrCreateConversation(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { characterId } = req.params;

      console.log(`\n📡 [conversationController] GET /conversations/character/${characterId}`);
      console.log(`   userId: ${userId}`);

      const result = await conversationService.getOrCreateConversation(userId, characterId);

      console.log(`   result.status: ${result.status}`);

      // 根據建立狀態回不同 HTTP 碼，供前端輪詢判斷
      // 注意：result.status 是業務語意欄位（preparing/failed/ready），不是本檔案錯誤格式的 error/message 包裹，維持原樣直接回傳。
      if (result.status === 'preparing') {
        // 202 Accepted：聊天室建立中，前端應繼續輪詢
        console.log(`   → HTTP 202 Accepted (preparing)\n`);
        return res.status(202).json(result);
      }
      if (result.status === 'failed') {
        // 503：建立失敗（例如 RAG 初始化失敗）
        console.log(`   → HTTP 503 Failed (${result.message})\n`);
        return res.status(503).json(result);
      }
      // ready：聊天室已就緒
      console.log(`   → HTTP 200 Ready (conversationId: ${result.conversationId})\n`);
      return res.status(200).json(result);
    } catch (error) {
      return respondWithError(res, error, { overrides: FORBIDDEN_ON_CHARACTER });
    }
  },

  async getAllConversations(req, res) {
    try {
      const userId = req.headers['x-user-id'];

      console.log(`📡 [conversationController] GET /conversations, userId: ${userId}`);

      const conversations = await conversationService.getAllConversations(userId);

      return res.status(200).json(conversations);
    } catch (error) {
      return respondWithError(res, error);
    }
  },

  async getConversationsSummary(req, res) {
    try {
      const userId = req.headers['x-user-id'];

      console.log(`📡 [conversationController] GET /conversations/summary, userId: ${userId}`);

      const summary = await conversationService.getConversationsSummary(userId);

      return res.status(200).json(summary);
    } catch (error) {
      return respondWithError(res, error);
    }
  },

  async sendMessage(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { characterId } = req.params;
      const { role, text } = req.body;

      console.log(`📤 [conversationController] POST /conversations/character/${characterId}/messages`);

      const message = await conversationService.sendMessage(userId, characterId, role, text);

      return res.status(201).json(message);
    } catch (error) {
      return respondWithError(res, error);
    }
  },

  async sendMessageToConversation(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const isInternalRequest = req.headers['x-internal-request'] === 'true';
      const { conversationId } = req.params;
      // 🆕 tempUserId：前端樂觀更新的臨時訊息 ID，生成成功後用於配對真實 ID
      const { text, tempUserId } = req.body;

      console.log(`📤 [conversationController] POST /conversations/${conversationId}/messages`);
      console.log(`🐛 [DEBUG] 收到前端臨時 ID: tempUserId=${tempUserId || '(未提供)'}`);

      const result = await conversationService.sendMessageToConversation(userId, conversationId, text, tempUserId, { isInternalRequest });

      return res.status(201).json(result);
    } catch (error) {
      return respondWithError(res, error, { overrides: INVALID_REQUEST_ON_SEND });
    }
  },

  async getMessages(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { characterId } = req.params;
      const { limit = 50, offset = 0 } = req.query;

      console.log(`📖 [conversationController] GET /conversations/character/${characterId}/messages`);

      const messages = await conversationService.getMessages(userId, characterId, parseInt(limit), parseInt(offset));

      return res.status(200).json(messages);
    } catch (error) {
      return respondWithError(res, error);
    }
  },

  async getMessagesByConversationId(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const isInternalRequest = req.headers['x-internal-request'] === 'true';
      const { conversationId } = req.params;
      const { limit = 50, offset = 0 } = req.query;

      console.log(`📖 [conversationController] GET /conversations/${conversationId}/messages`);

      const messages = await conversationService.getMessagesByConversationId(userId, conversationId, parseInt(limit), parseInt(offset), { isInternalRequest });

      return res.status(200).json(messages);
    } catch (error) {
      return respondWithError(res, error);
    }
  },

  async deleteConversation(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { conversationId } = req.params;

      console.log(`🗑️ [conversationController] DELETE /conversations/${conversationId}`);

      const result = await conversationService.deleteConversation(userId, conversationId);

      return res.status(200).json({
        success: true,
        message: result.message,
      });
    } catch (error) {
      return respondWithError(res, error, { serviceErrorPrefix: 'RAG 清理失敗，聊天室未刪除' });
    }
  },

  async deleteConversationsByCharacter(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { characterId } = req.params;

      console.log(`🗑️ [conversationController] DELETE /conversations/character/${characterId}`);

      const result = await conversationService.deleteConversationsByCharacter(userId, characterId);

      return res.status(200).json({
        success: true,
        message: result.message,
        deletedCount: result.deletedCount,
      });
    } catch (error) {
      return respondWithError(res, error, { serviceErrorPrefix: 'RAG 清理失敗，聊天室未刪除' });
    }
  },

  // 🆕 重啟聊天室已改由前端複用「刪除 + 建立」既有管線，restartConversation/restartConversationById 已移除

  // 🆕 【主角人設】讀取主角名稱與背景
  async getProtagonist(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { conversationId } = req.params;

      console.log(`👤 [conversationController] GET /conversations/${conversationId}/protagonist`);

      const result = await conversationService.getProtagonist(userId, conversationId);

      return res.status(200).json(result);
    } catch (error) {
      return respondWithError(res, error);
    }
  },

  // 🆕 【主角人設】更新主角名稱與背景（先更新 RAG 再寫 DB）
  async updateProtagonist(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { conversationId } = req.params;
      const { protagonistName, protagonistBackground } = req.body;

      console.log(`👤 [conversationController] PUT /conversations/${conversationId}/protagonist`);

      const result = await conversationService.updateProtagonist(
        userId, conversationId, protagonistName, protagonistBackground
      );

      return res.status(200).json(result);
    } catch (error) {
      // RAG 更新失敗（ai-service 不可用等）→ 503，DB 未被修改
      return respondWithError(res, error, { serviceErrorPrefix: '主角人設更新失敗' });
    }
  },

  // 🆕 【刪除訊息】刪除指定用戶訊息及其後所有訊息（回溯式刪除）
  async deleteMessageAndSubsequent(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { conversationId, messageId } = req.params;

      console.log(`🗑️ [conversationController] DELETE /conversations/${conversationId}/messages/${messageId}`);

      const result = await conversationService.deleteMessageAndSubsequent(userId, conversationId, messageId);

      return res.status(200).json({
        success: true,
        message: `${result.deletedCount} 則訊息已刪除`,
        deletedCount: result.deletedCount,
        deletedIds: result.deletedIds,
      });
    } catch (error) {
      // 生成中拒絕刪除 → 409（前端顯示懸浮通知）；摘要刪除失敗 → 503（訊息未被刪除）
      return respondWithError(res, error, {
        overrides: GENERATION_IN_PROGRESS_ON_DELETE,
        serviceErrorPrefix: '記憶清理失敗，訊息未刪除',
      });
    }
  },

  // 🆕 查詢單一訊息（用於前端輪詢 AI 完成狀態）
  async getMessageById(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { conversationId, messageId } = req.params;

      console.log(`📡 [conversationController] GET /conversations/${conversationId}/messages/${messageId}`);

      const message = await conversationService.getMessageById(userId, conversationId, messageId);

      return res.status(200).json(message);
    } catch (error) {
      return respondWithError(res, error);
    }
  },

  // 🆕 重試聊天室建立（清除失敗狀態）
  async retryConversationCreation(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { characterId } = req.params;

      console.log(`\n🔄 [conversationController] POST /conversations/character/${characterId}/retry`);
      console.log(`   userId: ${userId}`);

      const result = await conversationService.retryConversationCreation(userId, characterId);

      console.log(`   ✅ 失敗狀態已清除，允許重試\n`);
      return res.status(200).json(result);
    } catch (error) {
      return respondWithError(res, error);
    }
  },

  // 🆕 查詢 AI 生成狀態
  async getAIGenerationStatus(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { conversationId } = req.params;

      console.log(`📊 [conversationController] GET /conversations/${conversationId}/ai-generation-status`);

      const status = await conversationService.getAIGenerationStatus(userId, conversationId);

      // 🐛 【DEBUG】completed 時印出回傳給前端的完整配對資訊
      if (status && status.status === 'completed') {
        console.log(`🐛 [DEBUG] 回傳 completed 狀態給前端: ${JSON.stringify(status)}`);
      }

      return res.status(200).json(status);
    } catch (error) {
      return respondWithError(res, error);
    }
  },

  // 🆕 清除 AI 生成狀態（用戶重試時）
  async clearAIGenerationStatus(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { conversationId } = req.params;

      console.log(`🗑️ [conversationController] DELETE /conversations/${conversationId}/ai-generation-status`);

      await conversationService.clearAIGenerationStatus(userId, conversationId);

      return res.status(200).json({
        success: true,
        message: 'AI generation status cleared'
      });
    } catch (error) {
      return respondWithError(res, error);
    }
  },
};
