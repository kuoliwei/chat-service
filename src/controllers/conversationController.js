import { conversationService } from '../services/conversationService.js';

// 固定 status + 固定 message 的錯誤碼查表；帶動態內容或依端點語意不同的錯誤碼
// （AI_GENERATION_IN_PROGRESS、AI_SERVICE_UNAVAILABLE:/SERVICE_ERROR: 前綴等）不納入，維持個別處理
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
      if (error.message === 'FORBIDDEN') {
        return res.status(403).json({ error: 'FORBIDDEN', message: 'Access denied to this character' });
      }
      // 🆕 【統一風格】AI Service 不可用（包含具體錯誤信息）
      if (error.message.startsWith('AI_SERVICE_UNAVAILABLE')) {
        const specificError = error.message.replace('AI_SERVICE_UNAVAILABLE: ', '');
        return res.status(503).json({ error: 'AI_SERVICE_UNAVAILABLE', message: specificError });
      }
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
    }
  },

  async getAllConversations(req, res) {
    try {
      const userId = req.headers['x-user-id'];

      console.log(`📡 [conversationController] GET /conversations, userId: ${userId}`);

      const conversations = await conversationService.getAllConversations(userId);

      return res.status(200).json(conversations);
    } catch (error) {
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
    }
  },

  async getConversationsSummary(req, res) {
    try {
      const userId = req.headers['x-user-id'];

      console.log(`📡 [conversationController] GET /conversations/summary, userId: ${userId}`);

      const summary = await conversationService.getConversationsSummary(userId);

      return res.status(200).json(summary);
    } catch (error) {
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
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
      console.error('❌ [sendMessage] 錯誤:', error.message);
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
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
      console.error('❌ [sendMessageToConversation] 錯誤:', error.message);
      // 此端點的 MISSING_CONVERSATION_ID/MISSING_TEXT 訊息與其他方法不同（"Invalid request"），
      // 不納入共用 ERROR_MAP，維持原樣避免行為變更
      if (['MISSING_CONVERSATION_ID', 'MISSING_TEXT'].includes(error.message)) {
        return res.status(400).json({ error: error.message, message: 'Invalid request' });
      }
      // 🆕 【並行防護】同一聊天室已有 AI 生成任務進行中 → 409 Conflict
      if (error.message === 'AI_GENERATION_IN_PROGRESS') {
        return res.status(409).json({ error: 'AI_GENERATION_IN_PROGRESS', message: '上一條訊息仍在處理中，請等待回覆完成後再發送' });
      }
      // 🆕 AI Service 不可用（包含具體錯誤信息）
      if (error.message.startsWith('AI_SERVICE_UNAVAILABLE')) {
        // 提取具體的錯誤信息（格式：AI_SERVICE_UNAVAILABLE: [具體錯誤]）
        const specificError = error.message.replace('AI_SERVICE_UNAVAILABLE: ', '');
        return res.status(503).json({
          error: 'AI_SERVICE_UNAVAILABLE',
          message: specificError,
          aiGenerationStatus: { status: 'failed', error: specificError }
        });
      }
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
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
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
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
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
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
      // 🆕 RAG 清理失敗（ai-service 不可用等），聊天室未被刪除
      if (error.message.startsWith('SERVICE_ERROR')) {
        const specificError = error.message.replace('SERVICE_ERROR: ', '');
        return res.status(503).json({ error: 'SERVICE_ERROR', message: `RAG 清理失敗，聊天室未刪除: ${specificError}` });
      }
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
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
      // 🆕 RAG 清理失敗（ai-service 不可用等），聊天室未被刪除
      if (error.message.startsWith('SERVICE_ERROR')) {
        const specificError = error.message.replace('SERVICE_ERROR: ', '');
        return res.status(503).json({ error: 'SERVICE_ERROR', message: `RAG 清理失敗，聊天室未刪除: ${specificError}` });
      }
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
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
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
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
      console.error('❌ [updateProtagonist] 錯誤:', error.message);
      // 🆕 RAG 更新失敗（ai-service 不可用等）→ 503，DB 未被修改
      if (error.message.startsWith('SERVICE_ERROR')) {
        const specificError = error.message.replace('SERVICE_ERROR: ', '');
        return res.status(503).json({ error: 'SERVICE_ERROR', message: `主角人設更新失敗: ${specificError}` });
      }
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
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
      console.error('❌ [deleteMessageAndSubsequent] 錯誤:', error.message);
      // 🆕 生成中拒絕刪除 → 409，前端顯示懸浮通知
      if (error.message === 'AI_GENERATION_IN_PROGRESS') {
        return res.status(409).json({ error: 'AI_GENERATION_IN_PROGRESS', message: 'AI 正在回覆中，請等待回覆完成後再刪除' });
      }
      // 🆕 摘要刪除失敗（RAG 不可用等）→ 503，訊息未被刪除
      if (error.message.startsWith('SERVICE_ERROR')) {
        const specificError = error.message.replace('SERVICE_ERROR: ', '');
        return res.status(503).json({ error: 'SERVICE_ERROR', message: `記憶清理失敗，訊息未刪除: ${specificError}` });
      }
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
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
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
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
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
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
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
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
      const mapped = ERROR_MAP[error.message];
      if (mapped) {
        return res.status(mapped.status).json({ error: error.message, message: mapped.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
    }
  },
};
