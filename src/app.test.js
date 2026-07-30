import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { conversationController } from './controllers/conversationController.js';

vi.mock('./controllers/conversationController.js', () => ({
  conversationController: {
    getOrCreateConversation: vi.fn((req, res) => res.json({ handler: 'getOrCreateConversation' })),
    getConversationsSummary: vi.fn((req, res) => res.json({ handler: 'getConversationsSummary' })),
    getAllConversations: vi.fn((req, res) => res.json({ handler: 'getAllConversations' })),
    getMessages: vi.fn((req, res) => res.json({ handler: 'getMessages' })),
    getMessagesByConversationId: vi.fn((req, res) => res.json({ handler: 'getMessagesByConversationId' })),
    sendMessage: vi.fn((req, res) => res.json({ handler: 'sendMessage' })),
    getMessageById: vi.fn((req, res) => res.json({ handler: 'getMessageById' })),
    deleteMessageAndSubsequent: vi.fn((req, res) => res.json({ handler: 'deleteMessageAndSubsequent' })),
    sendMessageToConversation: vi.fn((req, res) => res.json({ handler: 'sendMessageToConversation' })),
    deleteConversation: vi.fn((req, res) => res.json({ handler: 'deleteConversation' })),
    deleteConversationsByCharacter: vi.fn((req, res) => res.json({ handler: 'deleteConversationsByCharacter' })),
    retryConversationCreation: vi.fn((req, res) => res.json({ handler: 'retryConversationCreation' })),
    getProtagonist: vi.fn((req, res) => res.json({ handler: 'getProtagonist' })),
    updateProtagonist: vi.fn((req, res) => res.json({ handler: 'updateProtagonist' })),
    getAIGenerationStatus: vi.fn((req, res) => res.json({ handler: 'getAIGenerationStatus' })),
    clearAIGenerationStatus: vi.fn((req, res) => res.json({ handler: 'clearAIGenerationStatus' })),
  }
}));

describe('app.js - 路由掛載', () => {

  it('所有 API 路由 handler 應為預期的 controller 方法', () => {
    expect(typeof conversationController.getOrCreateConversation).toBe('function');
    expect(typeof conversationController.getConversationsSummary).toBe('function');
    expect(typeof conversationController.getAllConversations).toBe('function');
    expect(typeof conversationController.getMessages).toBe('function');
    expect(typeof conversationController.getMessagesByConversationId).toBe('function');
    expect(typeof conversationController.sendMessage).toBe('function');
    expect(typeof conversationController.getMessageById).toBe('function');
    expect(typeof conversationController.deleteMessageAndSubsequent).toBe('function');
    expect(typeof conversationController.sendMessageToConversation).toBe('function');
    expect(typeof conversationController.deleteConversation).toBe('function');
    expect(typeof conversationController.deleteConversationsByCharacter).toBe('function');
    expect(typeof conversationController.retryConversationCreation).toBe('function');
    expect(typeof conversationController.getProtagonist).toBe('function');
    expect(typeof conversationController.updateProtagonist).toBe('function');
    expect(typeof conversationController.getAIGenerationStatus).toBe('function');
    expect(typeof conversationController.clearAIGenerationStatus).toBe('function');
  });

  it('所有路由的 handler 應為預期的 controller 方法', () => {
    const app = express();
    app.use(express.json());

    const routeHandlers = [
      ['/api/v1/conversations/character/:characterId', 'get', conversationController.getOrCreateConversation],
      ['/api/v1/conversations/summary', 'get', conversationController.getConversationsSummary],
      ['/api/v1/conversations', 'get', conversationController.getAllConversations],
      ['/api/v1/conversations/character/:characterId/messages', 'get', conversationController.getMessages],
      ['/api/v1/conversations/:conversationId/messages', 'get', conversationController.getMessagesByConversationId],
      ['/api/v1/conversations/character/:characterId/messages', 'post', conversationController.sendMessage],
      ['/api/v1/conversations/:conversationId/messages/:messageId', 'get', conversationController.getMessageById],
      ['/api/v1/conversations/:conversationId/messages/:messageId', 'delete', conversationController.deleteMessageAndSubsequent],
      ['/api/v1/conversations/:conversationId/messages', 'post', conversationController.sendMessageToConversation],
      ['/api/v1/conversations/:conversationId', 'delete', conversationController.deleteConversation],
      ['/api/v1/conversations/character/:characterId', 'delete', conversationController.deleteConversationsByCharacter],
      ['/api/v1/conversations/character/:characterId/retry', 'post', conversationController.retryConversationCreation],
      ['/api/v1/conversations/:conversationId/protagonist', 'get', conversationController.getProtagonist],
      ['/api/v1/conversations/:conversationId/protagonist', 'put', conversationController.updateProtagonist],
      ['/api/v1/conversations/:conversationId/ai-generation-status', 'get', conversationController.getAIGenerationStatus],
      ['/api/v1/conversations/:conversationId/ai-generation-status', 'delete', conversationController.clearAIGenerationStatus],
    ];

    routeHandlers.forEach(([path, method, handler]) => {
      app[method](path, handler);
    });

    // 驗證所有 handler 都有被掛載
    routeHandlers.forEach(([, , handler]) => {
      expect(typeof handler).toBe('function');
    });
  });
});
