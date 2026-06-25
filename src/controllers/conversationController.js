import { conversationService } from '../services/conversationService.js';

export const conversationController = {
  async getOrCreateConversation(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { characterId } = req.params;

      console.log(`📡 [conversationController] GET /conversations/character/${characterId}, userId: ${userId}`);

      const conversation = await conversationService.getOrCreateConversation(userId, characterId);

      return res.status(200).json(conversation);
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
      if (error.message === 'UNAUTHORIZED') {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (['MISSING_TEXT', 'INVALID_ROLE', 'CONVERSATION_NOT_FOUND'].includes(error.message)) {
        return res.status(400).json({ message: error.message });
      }
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  },

  async sendMessageToConversation(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { conversationId } = req.params;
      const { role, text } = req.body;

      console.log(`📤 [conversationController] POST /conversations/${conversationId}/messages`);

      const message = await conversationService.sendMessageToConversation(userId, conversationId, role, text);

      return res.status(201).json(message);
    } catch (error) {
      if (error.message === 'UNAUTHORIZED') {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (['MISSING_CONVERSATION_ID', 'MISSING_TEXT', 'INVALID_ROLE'].includes(error.message)) {
        return res.status(400).json({ message: error.message });
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
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
  },

  async restartConversation(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { characterId } = req.params;

      console.log(`🔄 [conversationController] POST /conversations/character/${characterId}/restart`);

      const result = await conversationService.restartConversation(userId, characterId);

      return res.status(200).json({
        status: 'success',
        data: result,
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
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
  },

  async restartConversationById(req, res) {
    try {
      const userId = req.headers['x-user-id'];
      const { conversationId } = req.params;

      console.log(`🔄 [conversationController] POST /conversations/${conversationId}/restart`);

      const result = await conversationService.restartConversationById(userId, conversationId);

      return res.status(200).json({
        status: 'success',
        data: result,
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
      console.error('❌ [conversationController]', error);
      return res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
  },
};
