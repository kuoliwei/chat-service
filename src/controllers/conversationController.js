import { conversationService } from '../services/conversationService.js';

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
      if (error.message === 'UNAUTHORIZED') {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (error.message === 'MISSING_CHARACTER_ID') {
        return res.status(400).json({ message: 'Missing characterId' });
      }
      if (error.message === 'CHARACTER_NOT_FOUND') {
        return res.status(404).json({ message: 'Character not found' });
      }
      if (error.message === 'FORBIDDEN') {
        return res.status(403).json({ message: 'Access denied to this character' });
      }
      // 🆕 【統一風格】AI Service 不可用（包含具體錯誤信息）
      if (error.message.startsWith('AI_SERVICE_UNAVAILABLE')) {
        const specificError = error.message.replace('AI_SERVICE_UNAVAILABLE: ', '');
        return res.status(503).json({ message: specificError });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  },

  async getAllConversations(req, res) {
    try {
      const userId = req.headers['x-user-id'];

      console.log(`📡 [conversationController] GET /conversations, userId: ${userId}`);

      const conversations = await conversationService.getAllConversations(userId);

      return res.status(200).json(conversations);
    } catch (error) {
      if (error.message === 'UNAUTHORIZED') {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  },

  async getConversationsSummary(req, res) {
    try {
      const userId = req.headers['x-user-id'];

      console.log(`📡 [conversationController] GET /conversations/summary, userId: ${userId}`);

      const summary = await conversationService.getConversationsSummary(userId);

      return res.status(200).json(summary);
    } catch (error) {
      if (error.message === 'UNAUTHORIZED') {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
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
      if (error.message === 'UNAUTHORIZED') {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (['MISSING_TEXT', 'INVALID_ROLE', 'CONVERSATION_NOT_FOUND'].includes(error.message)) {
        const errorMessages = {
          'MISSING_TEXT': 'Invalid request',
          'INVALID_ROLE': 'Invalid request',
          'CONVERSATION_NOT_FOUND': 'Conversation not found'
        };
        return res.status(400).json({ message: errorMessages[error.message] || 'Invalid request' });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  },

  async sendMessageToConversation(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { conversationId } = req.params;
      // 🆕 tempUserId：前端樂觀更新的臨時訊息 ID，生成成功後用於配對真實 ID
      const { text, tempUserId } = req.body;

      console.log(`📤 [conversationController] POST /conversations/${conversationId}/messages`);
      console.log(`🐛 [DEBUG] 收到前端臨時 ID: tempUserId=${tempUserId || '(未提供)'}`);

      const result = await conversationService.sendMessageToConversation(userId, conversationId, text, tempUserId);

      return res.status(201).json(result);
    } catch (error) {
      console.error('❌ [sendMessageToConversation] 錯誤:', error.message);
      if (error.message === 'UNAUTHORIZED') {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (['MISSING_CONVERSATION_ID', 'MISSING_TEXT'].includes(error.message)) {
        return res.status(400).json({ message: 'Invalid request' });
      }
      if (error.message === 'CONVERSATION_NOT_FOUND') {
        return res.status(404).json({ message: 'Conversation not found' });
      }
      if (error.message === 'FORBIDDEN') {
        return res.status(403).json({ message: 'Access denied' });
      }
      // 🆕 【並行防護】同一聊天室已有 AI 生成任務進行中 → 409 Conflict
      if (error.message === 'AI_GENERATION_IN_PROGRESS') {
        return res.status(409).json({ message: '上一條訊息仍在處理中，請等待回覆完成後再發送' });
      }
      // 🆕 AI Service 不可用（包含具體錯誤信息）
      if (error.message.startsWith('AI_SERVICE_UNAVAILABLE')) {
        // 提取具體的錯誤信息（格式：AI_SERVICE_UNAVAILABLE: [具體錯誤]）
        const specificError = error.message.replace('AI_SERVICE_UNAVAILABLE: ', '');
        return res.status(503).json({
          message: specificError,
          aiGenerationStatus: { status: 'failed', error: specificError }
        });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
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
      if (error.message === 'UNAUTHORIZED') {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (error.message === 'CONVERSATION_NOT_FOUND') {
        return res.status(404).json({ message: 'Conversation not found' });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  },

  async getMessagesByConversationId(req, res) {
    try {
      const { conversationId } = req.params;
      const { limit = 50, offset = 0 } = req.query;

      console.log(`📖 [conversationController] GET /conversations/${conversationId}/messages`);

      const messages = await conversationService.getMessagesByConversationId(conversationId, parseInt(limit), parseInt(offset));

      return res.status(200).json(messages);
    } catch (error) {
      if (error.message === 'CONVERSATION_NOT_FOUND') {
        return res.status(404).json({ message: 'Conversation not found' });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  },

  async deleteConversation(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { conversationId } = req.params;

      console.log(`🗑️ [conversationController] DELETE /conversations/${conversationId}`);

      const result = await conversationService.deleteConversation(userId, conversationId);

      return res.status(200).json({
        status: 'success',
        message: result.message,
      });
    } catch (error) {
      if (error.message === 'UNAUTHORIZED') {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
      }
      if (error.message === 'MISSING_CONVERSATION_ID') {
        return res.status(400).json({ status: 'error', message: 'Missing conversationId' });
      }
      if (error.message === 'CONVERSATION_NOT_FOUND') {
        return res.status(404).json({ status: 'error', message: 'Conversation not found' });
      }
      if (error.message === 'FORBIDDEN') {
        return res.status(403).json({ status: 'error', message: 'Access denied' });
      }
      // 🆕 RAG 清理失敗（ai-service 不可用等），聊天室未被刪除
      if (error.message.startsWith('SERVICE_ERROR')) {
        const specificError = error.message.replace('SERVICE_ERROR: ', '');
        return res.status(503).json({ status: 'error', message: `RAG 清理失敗，聊天室未刪除: ${specificError}` });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
  },

  async deleteConversationsByCharacter(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { characterId } = req.params;

      console.log(`🗑️ [conversationController] DELETE /conversations/character/${characterId}`);

      const result = await conversationService.deleteConversationsByCharacter(userId, characterId);

      return res.status(200).json({
        status: 'success',
        message: result.message,
        deletedCount: result.deletedCount,
      });
    } catch (error) {
      if (error.message === 'UNAUTHORIZED') {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
      }
      if (error.message === 'MISSING_CHARACTER_ID') {
        return res.status(400).json({ status: 'error', message: 'Missing characterId' });
      }
      if (error.message === 'CHARACTER_NOT_FOUND') {
        return res.status(404).json({ status: 'error', message: 'Character not found' });
      }
      if (error.message === 'NO_CONVERSATIONS_FOUND') {
        return res.status(404).json({ status: 'error', message: 'No conversations found for this character' });
      }
      // 🆕 RAG 清理失敗（ai-service 不可用等），聊天室未被刪除
      if (error.message.startsWith('SERVICE_ERROR')) {
        const specificError = error.message.replace('SERVICE_ERROR: ', '');
        return res.status(503).json({ status: 'error', message: `RAG 清理失敗，聊天室未刪除: ${specificError}` });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ status: 'error', message: 'Internal server error' });
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
      if (error.message === 'UNAUTHORIZED') {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (error.message === 'MISSING_CONVERSATION_ID') {
        return res.status(400).json({ message: 'Missing conversationId' });
      }
      if (error.message === 'CONVERSATION_NOT_FOUND') {
        return res.status(404).json({ message: 'Conversation not found' });
      }
      if (error.message === 'FORBIDDEN') {
        return res.status(403).json({ message: 'Access denied' });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
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

      return res.status(200).json({ status: 'success', ...result });
    } catch (error) {
      console.error('❌ [updateProtagonist] 錯誤:', error.message);
      if (error.message === 'UNAUTHORIZED') {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (error.message === 'MISSING_CONVERSATION_ID') {
        return res.status(400).json({ message: 'Missing conversationId' });
      }
      if (error.message === 'CONVERSATION_NOT_FOUND') {
        return res.status(404).json({ message: 'Conversation not found' });
      }
      if (error.message === 'FORBIDDEN') {
        return res.status(403).json({ message: 'Access denied' });
      }
      // 🆕 RAG 更新失敗（ai-service 不可用等）→ 503，DB 未被修改
      if (error.message.startsWith('SERVICE_ERROR')) {
        const specificError = error.message.replace('SERVICE_ERROR: ', '');
        return res.status(503).json({ message: `主角人設更新失敗: ${specificError}` });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
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
        status: 'success',
        deletedCount: result.deletedCount,
        deletedIds: result.deletedIds,
      });
    } catch (error) {
      console.error('❌ [deleteMessageAndSubsequent] 錯誤:', error.message);
      if (error.message === 'UNAUTHORIZED') {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (error.message === 'MISSING_PARAMS') {
        return res.status(400).json({ message: 'Missing conversationId or messageId' });
      }
      if (error.message === 'CONVERSATION_NOT_FOUND') {
        return res.status(404).json({ message: 'Conversation not found' });
      }
      if (error.message === 'MESSAGE_NOT_FOUND') {
        return res.status(404).json({ message: 'Message not found' });
      }
      if (error.message === 'FORBIDDEN') {
        return res.status(403).json({ message: 'Access denied' });
      }
      if (error.message === 'NOT_USER_MESSAGE') {
        return res.status(400).json({ message: '只能刪除自己發出的訊息' });
      }
      // 🆕 生成中拒絕刪除 → 409，前端顯示懸浮通知
      if (error.message === 'AI_GENERATION_IN_PROGRESS') {
        return res.status(409).json({ message: 'AI 正在回覆中，請等待回覆完成後再刪除' });
      }
      // 🆕 摘要刪除失敗（RAG 不可用等）→ 503，訊息未被刪除
      if (error.message.startsWith('SERVICE_ERROR')) {
        const specificError = error.message.replace('SERVICE_ERROR: ', '');
        return res.status(503).json({ message: `記憶清理失敗，訊息未刪除: ${specificError}` });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  },

  // 🆕 查詢單一訊息（用於前端輪詢 AI 完成狀態）
  async getMessageById(req, res) {
    try {
      const { conversationId, messageId } = req.params;

      console.log(`📡 [conversationController] GET /conversations/${conversationId}/messages/${messageId}`);

      const message = await conversationService.getMessageById(conversationId, messageId);

      return res.status(200).json(message);
    } catch (error) {
      if (error.message === 'MISSING_PARAMS') {
        return res.status(400).json({ message: 'Missing conversationId or messageId' });
      }
      if (error.message === 'MESSAGE_NOT_FOUND') {
        return res.status(404).json({ message: 'Message not found' });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
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
      if (error.message === 'MISSING_CHARACTER_ID') {
        return res.status(400).json({ message: 'Missing characterId' });
      }
      if (error.message === 'NO_FAILED_JOB') {
        return res.status(404).json({ message: 'No failed job found for this character' });
      }
      if (error.message === 'JOB_NOT_FAILED') {
        return res.status(409).json({ message: 'Job is not in failed state' });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  },

  // 🆕 查詢 AI 生成狀態
  async getAIGenerationStatus(req, res) {
    try {
      const { conversationId } = req.params;

      console.log(`📊 [conversationController] GET /conversations/${conversationId}/ai-generation-status`);

      const status = conversationService.getAIGenerationStatus(conversationId);

      // 🐛 【DEBUG】completed 時印出回傳給前端的完整配對資訊
      if (status && status.status === 'completed') {
        console.log(`🐛 [DEBUG] 回傳 completed 狀態給前端: ${JSON.stringify(status)}`);
      }

      return res.status(200).json(status);
    } catch (error) {
      if (error.message === 'MISSING_CONVERSATION_ID') {
        return res.status(400).json({ message: 'Missing conversationId' });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  },

  // 🆕 清除 AI 生成狀態（用戶重試時）
  async clearAIGenerationStatus(req, res) {
    try {
      const { conversationId } = req.params;

      console.log(`🗑️ [conversationController] DELETE /conversations/${conversationId}/ai-generation-status`);

      conversationService.clearAIGenerationStatus(conversationId);

      return res.status(200).json({
        status: 'cleared',
        message: 'AI generation status cleared'
      });
    } catch (error) {
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  },
};
