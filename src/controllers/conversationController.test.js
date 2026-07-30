import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';

// ========== Mock 設定 ==========
//
// Controller 的職責是「HTTP 轉接」：讀 header/params/body → 呼叫 service →
// 把語意錯誤碼轉成 HTTP 狀態碼。因此只 mock 下一層的 service，
// 用手刻的 req/res 假物件驅動（與 auth-service 的 controller 測試同一套做法，不引入 supertest）。

vi.mock('../services/conversationService.js', () => ({
  conversationService: {
    getOrCreateConversation: vi.fn(),
    getAllConversations: vi.fn(),
    getConversationsSummary: vi.fn(),
    sendMessage: vi.fn(),
    sendMessageToConversation: vi.fn(),
    getMessages: vi.fn(),
    getMessagesByConversationId: vi.fn(),
    deleteConversation: vi.fn(),
    deleteConversationsByCharacter: vi.fn(),
    getProtagonist: vi.fn(),
    updateProtagonist: vi.fn(),
    deleteMessageAndSubsequent: vi.fn(),
    getMessageById: vi.fn(),
    retryConversationCreation: vi.fn(),
    getAIGenerationStatus: vi.fn(),
    clearAIGenerationStatus: vi.fn(),
  },
}));

import { conversationService } from '../services/conversationService.js';
import { conversationController } from './conversationController.js';

const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
afterAll(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

const OWNER = 'user_1';
const CONV_ID = 'conv_1';

/** 手刻 Express req/res 假物件；status().json() 需可鏈式呼叫 */
function makeReq({ headers = {}, params = {}, query = {}, body = {} } = {}) {
  return {
    headers: { 'x-user-id': OWNER, ...headers },
    params,
    query,
    body,
  };
}

function makeRes() {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ========== 共用錯誤映射（ERROR_MAP 查表） ==========

describe('錯誤碼 → HTTP 映射', () => {
  it.each([
    ['UNAUTHORIZED', 401, 'Unauthorized'],
    ['MISSING_CHARACTER_ID', 400, 'Missing characterId'],
    ['CHARACTER_NOT_FOUND', 404, 'Character not found'],
    ['CONVERSATION_NOT_FOUND', 404, 'Conversation not found'],
    ['MESSAGE_NOT_FOUND', 404, 'Message not found'],
    ['NOT_USER_MESSAGE', 400, '只能刪除自己發出的訊息'],
    ['NO_FAILED_JOB', 404, 'No failed job found for this character'],
    ['JOB_NOT_FAILED', 409, 'Job is not in failed state'],
    ['NO_CONVERSATIONS_FOUND', 404, 'No conversations found for this character'],
  ])('%s → HTTP %i', async (code, status, message) => {
    conversationService.getAllConversations.mockRejectedValue(new Error(code));
    const res = makeRes();

    await conversationController.getAllConversations(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith({ error: code, message });
  });

  it('未知錯誤 → 500，且留下錯誤日誌供除錯', async () => {
    conversationService.getAllConversations.mockRejectedValue(new Error('BOOM'));
    const res = makeRes();

    await conversationController.getAllConversations(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

// ========== 對話建立 ==========

describe('getOrCreateConversation', () => {
  it('ready → 200 並原樣回傳業務結果', async () => {
    const result = { status: 'ready', conversationId: CONV_ID, messages: [] };
    conversationService.getOrCreateConversation.mockResolvedValue(result);
    const res = makeRes();

    await conversationController.getOrCreateConversation(makeReq({ params: { characterId: 'char_1' } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(result);
  });

  it('preparing → 202（前端據此繼續輪詢）', async () => {
    conversationService.getOrCreateConversation.mockResolvedValue({ status: 'preparing' });
    const res = makeRes();

    await conversationController.getOrCreateConversation(makeReq({ params: { characterId: 'char_1' } }), res);

    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('failed → 503（建立失敗，使用者可重試）', async () => {
    conversationService.getOrCreateConversation.mockResolvedValue({ status: 'failed', message: 'RAG 初始化失敗' });
    const res = makeRes();

    await conversationController.getOrCreateConversation(makeReq({ params: { characterId: 'char_1' } }), res);

    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('FORBIDDEN → 403，且訊息是角色語意而非對話語意', async () => {
    conversationService.getOrCreateConversation.mockRejectedValue(new Error('FORBIDDEN'));
    const res = makeRes();

    await conversationController.getOrCreateConversation(makeReq({ params: { characterId: 'char_1' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'FORBIDDEN', message: 'Access denied to this character' });
  });
});

// ========== 對話查詢 ==========

describe('對話查詢', () => {
  it('getAllConversations 成功 → 200', async () => {
    conversationService.getAllConversations.mockResolvedValue([{ id: CONV_ID }]);
    const res = makeRes();

    await conversationController.getAllConversations(makeReq(), res);

    expect(conversationService.getAllConversations).toHaveBeenCalledWith(OWNER);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('getConversationsSummary 成功 → 200', async () => {
    conversationService.getConversationsSummary.mockResolvedValue([]);
    const res = makeRes();

    await conversationController.getConversationsSummary(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// ========== 訊息 ==========

describe('sendMessage（依 characterId）', () => {
  it('成功 → 201', async () => {
    conversationService.sendMessage.mockResolvedValue({ id: 'm1' });
    const res = makeRes();

    await conversationController.sendMessage(
      makeReq({ params: { characterId: 'char_1' }, body: { role: 'user', text: 'hi' } }),
      res
    );

    expect(conversationService.sendMessage).toHaveBeenCalledWith(OWNER, 'char_1', 'user', 'hi');
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('sendMessageToConversation（觸發 AI 生成）', () => {
  it('成功 → 201 accepted', async () => {
    conversationService.sendMessageToConversation.mockResolvedValue({ status: 'accepted' });
    const res = makeRes();

    await conversationController.sendMessageToConversation(
      makeReq({ params: { conversationId: CONV_ID }, body: { text: 'hi', tempUserId: 'temp_1' } }),
      res
    );

    expect(conversationService.sendMessageToConversation).toHaveBeenCalledWith(
      OWNER, CONV_ID, 'hi', 'temp_1', { isInternalRequest: false }
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('帶 x-internal-request 時把旗標傳給 service', async () => {
    conversationService.sendMessageToConversation.mockResolvedValue({ status: 'accepted' });
    const res = makeRes();

    await conversationController.sendMessageToConversation(
      makeReq({ headers: { 'x-internal-request': 'true' }, params: { conversationId: CONV_ID }, body: { text: 'hi' } }),
      res
    );

    expect(conversationService.sendMessageToConversation).toHaveBeenCalledWith(
      OWNER, CONV_ID, 'hi', undefined, { isInternalRequest: true }
    );
  });

  it.each(['MISSING_CONVERSATION_ID', 'MISSING_TEXT'])(
    '%s → 400 且訊息統一為 Invalid request（本端點特有，不同於共用表）',
    async (code) => {
      conversationService.sendMessageToConversation.mockRejectedValue(new Error(code));
      const res = makeRes();

      await conversationController.sendMessageToConversation(
        makeReq({ params: { conversationId: CONV_ID }, body: {} }),
        res
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: code, message: 'Invalid request' });
    }
  );

  it('AI_GENERATION_IN_PROGRESS → 409，訊息是「發送」語意', async () => {
    conversationService.sendMessageToConversation.mockRejectedValue(new Error('AI_GENERATION_IN_PROGRESS'));
    const res = makeRes();

    await conversationController.sendMessageToConversation(
      makeReq({ params: { conversationId: CONV_ID }, body: { text: 'hi' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'AI_GENERATION_IN_PROGRESS',
      message: '上一條訊息仍在處理中，請等待回覆完成後再發送',
    });
  });
});

describe('訊息查詢', () => {
  it('getMessages 把 limit/offset 轉成數字傳給 service', async () => {
    conversationService.getMessages.mockResolvedValue([]);
    const res = makeRes();

    await conversationController.getMessages(
      makeReq({ params: { characterId: 'char_1' }, query: { limit: '10', offset: '5' } }),
      res
    );

    expect(conversationService.getMessages).toHaveBeenCalledWith(OWNER, 'char_1', 10, 5);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('getMessages 未帶 query 時用預設值 50/0', async () => {
    conversationService.getMessages.mockResolvedValue([]);
    const res = makeRes();

    await conversationController.getMessages(makeReq({ params: { characterId: 'char_1' } }), res);

    expect(conversationService.getMessages).toHaveBeenCalledWith(OWNER, 'char_1', 50, 0);
  });

  it('getMessagesByConversationId 傳遞 isInternalRequest', async () => {
    conversationService.getMessagesByConversationId.mockResolvedValue([]);
    const res = makeRes();

    await conversationController.getMessagesByConversationId(
      makeReq({ headers: { 'x-internal-request': 'true' }, params: { conversationId: CONV_ID } }),
      res
    );

    expect(conversationService.getMessagesByConversationId).toHaveBeenCalledWith(
      OWNER, CONV_ID, 50, 0, { isInternalRequest: true }
    );
  });

  it('getMessageById 成功 → 200', async () => {
    conversationService.getMessageById.mockResolvedValue({ id: 'm1' });
    const res = makeRes();

    await conversationController.getMessageById(
      makeReq({ params: { conversationId: CONV_ID, messageId: 'm1' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// ========== 對話刪除（SERVICE_ERROR → 503，各端點訊息不同） ==========

describe('deleteConversation', () => {
  it('成功 → 200 並包成 { success, message }', async () => {
    conversationService.deleteConversation.mockResolvedValue({ message: 'Conversation deleted successfully' });
    const res = makeRes();

    await conversationController.deleteConversation(makeReq({ params: { conversationId: CONV_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Conversation deleted successfully' });
  });

  it('SERVICE_ERROR → 503，訊息點明「聊天室未刪除」', async () => {
    conversationService.deleteConversation.mockRejectedValue(new Error('SERVICE_ERROR: ai-service 無法連線'));
    const res = makeRes();

    await conversationController.deleteConversation(makeReq({ params: { conversationId: CONV_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: 'SERVICE_ERROR',
      message: 'RAG 清理失敗，聊天室未刪除: ai-service 無法連線',
    });
  });
});

describe('deleteConversationsByCharacter', () => {
  it('成功 → 200 並帶出 deletedCount', async () => {
    conversationService.deleteConversationsByCharacter.mockResolvedValue({ message: '2 conversation(s) deleted successfully', deletedCount: 2 });
    const res = makeRes();

    await conversationController.deleteConversationsByCharacter(makeReq({ params: { characterId: 'char_1' } }), res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: '2 conversation(s) deleted successfully',
      deletedCount: 2,
    });
  });

  it('SERVICE_ERROR → 503', async () => {
    conversationService.deleteConversationsByCharacter.mockRejectedValue(new Error('SERVICE_ERROR: 清理失敗'));
    const res = makeRes();

    await conversationController.deleteConversationsByCharacter(makeReq({ params: { characterId: 'char_1' } }), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: 'SERVICE_ERROR',
      message: 'RAG 清理失敗，聊天室未刪除: 清理失敗',
    });
  });
});

describe('deleteMessageAndSubsequent', () => {
  it('成功 → 200，訊息含刪除筆數', async () => {
    conversationService.deleteMessageAndSubsequent.mockResolvedValue({ deletedCount: 3, deletedIds: ['a', 'b', 'c'] });
    const res = makeRes();

    await conversationController.deleteMessageAndSubsequent(
      makeReq({ params: { conversationId: CONV_ID, messageId: 'm1' } }),
      res
    );

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: '3 則訊息已刪除',
      deletedCount: 3,
      deletedIds: ['a', 'b', 'c'],
    });
  });

  it('AI_GENERATION_IN_PROGRESS → 409，訊息是「刪除」語意（與發送端點不同）', async () => {
    conversationService.deleteMessageAndSubsequent.mockRejectedValue(new Error('AI_GENERATION_IN_PROGRESS'));
    const res = makeRes();

    await conversationController.deleteMessageAndSubsequent(
      makeReq({ params: { conversationId: CONV_ID, messageId: 'm1' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'AI_GENERATION_IN_PROGRESS',
      message: 'AI 正在回覆中，請等待回覆完成後再刪除',
    });
  });

  it('SERVICE_ERROR → 503，訊息點明「訊息未刪除」', async () => {
    conversationService.deleteMessageAndSubsequent.mockRejectedValue(new Error('SERVICE_ERROR: Qdrant 不可用'));
    const res = makeRes();

    await conversationController.deleteMessageAndSubsequent(
      makeReq({ params: { conversationId: CONV_ID, messageId: 'm1' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: 'SERVICE_ERROR',
      message: '記憶清理失敗，訊息未刪除: Qdrant 不可用',
    });
  });
});

// ========== 主角人設 ==========

describe('主角人設', () => {
  it('getProtagonist 成功 → 200', async () => {
    conversationService.getProtagonist.mockResolvedValue({ protagonistName: '阿明', protagonistBackground: null });
    const res = makeRes();

    await conversationController.getProtagonist(makeReq({ params: { conversationId: CONV_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('updateProtagonist 成功 → 200', async () => {
    conversationService.updateProtagonist.mockResolvedValue({ protagonistName: '阿明', protagonistBackground: '旅人' });
    const res = makeRes();

    await conversationController.updateProtagonist(
      makeReq({ params: { conversationId: CONV_ID }, body: { protagonistName: '阿明', protagonistBackground: '旅人' } }),
      res
    );

    expect(conversationService.updateProtagonist).toHaveBeenCalledWith(OWNER, CONV_ID, '阿明', '旅人');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('updateProtagonist 遇 SERVICE_ERROR → 503，訊息為主角語意', async () => {
    conversationService.updateProtagonist.mockRejectedValue(new Error('SERVICE_ERROR: RAG 不可用'));
    const res = makeRes();

    await conversationController.updateProtagonist(
      makeReq({ params: { conversationId: CONV_ID }, body: {} }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: 'SERVICE_ERROR',
      message: '主角人設更新失敗: RAG 不可用',
    });
  });
});

// ========== 建立重試 / AI 生成狀態 ==========

describe('retryConversationCreation', () => {
  it('成功 → 200', async () => {
    conversationService.retryConversationCreation.mockResolvedValue({ success: true, message: '失敗狀態已清除，請重新開啟聊天室' });
    const res = makeRes();

    await conversationController.retryConversationCreation(makeReq({ params: { characterId: 'char_1' } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('NO_FAILED_JOB → 404', async () => {
    conversationService.retryConversationCreation.mockRejectedValue(new Error('NO_FAILED_JOB'));
    const res = makeRes();

    await conversationController.retryConversationCreation(makeReq({ params: { characterId: 'char_1' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('AI 生成狀態', () => {
  it('getAIGenerationStatus 成功 → 200 並原樣回傳配對資訊', async () => {
    const status = { status: 'completed', tempUserId: 'temp_1', userMessageId: 'u1', assistantMessageId: 'a1' };
    conversationService.getAIGenerationStatus.mockResolvedValue(status);
    const res = makeRes();

    await conversationController.getAIGenerationStatus(makeReq({ params: { conversationId: CONV_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(status);
  });

  it('clearAIGenerationStatus 成功 → 200', async () => {
    conversationService.clearAIGenerationStatus.mockResolvedValue(undefined);
    const res = makeRes();

    await conversationController.clearAIGenerationStatus(makeReq({ params: { conversationId: CONV_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: 'AI generation status cleared' });
  });

  it('FORBIDDEN → 403（共用表的通用訊息）', async () => {
    conversationService.getAIGenerationStatus.mockRejectedValue(new Error('FORBIDDEN'));
    const res = makeRes();

    await conversationController.getAIGenerationStatus(makeReq({ params: { conversationId: CONV_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'FORBIDDEN', message: 'Access denied' });
  });
});
