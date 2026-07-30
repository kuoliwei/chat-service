import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';

// ========== Mock 設定 ==========
//
// 三個模組全部整模組替換（與 character-service 的 vi.mock factory 模式一致）：
//   1. conversationRepository.js — 匯出 4 個物件，每個的每一個方法都要列齊，
//      漏列會在該分支被走到時炸 "not a function"
//   2. serviceClient.js — 對 ai-service/character-service 的 HTTP 呼叫
//   3. config/index.js — 必須 mock！config.json 沒進版控（只有 config.example.json），
//      真實模組讀不到檔案會直接 process.exit(1)；mock 掉同時讓摘要閾值可預測

vi.mock('../repositories/conversationRepository.js', () => ({
  conversationRepository: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteByCharacterId: vi.fn(),
  },
  messageRepository: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnsummarized: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteManyByIds: vi.fn(),
  },
  conversationCreationJobRepository: {
    findByKey: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
  generationStatusRepository: {
    get: vi.fn(),
    tryAcquireLock: vi.fn(),
    releaseLock: vi.fn(),
    setCompleted: vi.fn(),
    setFailed: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock('../lib/serviceClient.js', () => ({
  serviceClient: {
    getCharacter: vi.fn(),
    getUser: vi.fn(),
    checkAIServiceHealth: vi.fn(),
    initializeRAG: vi.fn(),
    cleanupRAG: vi.fn(),
    generateResponse: vi.fn(),
    generateSummary: vi.fn(),
    addSummary: vi.fn(),
    deleteSummaries: vi.fn(),
    updateProtagonistRAG: vi.fn(),
    checkRAGStatus: vi.fn(),
  },
}));

vi.mock('../config/index.js', () => ({
  config: {
    summary: { threshold: 100, shortTermLimit: 2, maxWords: 200 },
    ai: { timeouts: { generateResponse: 60000, cleanupRAG: 10000, initializeRAG: 30000 } },
    persistence: { enableCreationJobs: true, enableGenerationStatus: true },
  },
}));

import {
  conversationRepository,
  messageRepository,
  conversationCreationJobRepository,
  generationStatusRepository,
} from '../repositories/conversationRepository.js';
import { serviceClient } from '../lib/serviceClient.js';
import { conversationService } from './conversationService.js';

// 本服務有大量 console.log（含 🐛 [DEBUG] 前綴），不壓掉測試輸出無法閱讀
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

afterAll(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ========== 測試資料工廠 ==========

const OWNER = 'user_1';
const CONV_ID = 'conv_1700000000000';

/** 建立一筆對話（欄位對齊 Conversation 表；log 會讀 characterName） */
function makeConversation(overrides = {}) {
  return {
    id: CONV_ID,
    userId: OWNER,
    characterId: 'char_1',
    title: null,
    characterName: '小狼',
    characterGender: 'female',
    characterTags: '["狼娘"]',
    protagonistName: null,
    protagonistBackground: null,
    createdAt: new Date('2026-07-01'),
    updatedAt: new Date('2026-07-02'),
    ...overrides,
  };
}

/** 建立一筆訊息（id 需夠長，service 的 log 會做 id.substring(0, 8)） */
function makeMessage(id, overrides = {}) {
  return {
    id: `msg_${id}_padding`,
    conversationId: CONV_ID,
    role: 'user',
    text: `訊息 ${id}`,
    status: 'completed',
    summarized: false,
    summaryId: null,
    createdAt: new Date('2026-07-01'),
    updatedAt: new Date('2026-07-01'),
    ...overrides,
  };
}

/** 讓 assertConversationOwnership 通過，並回傳該對話物件 */
function givenOwnedConversation(overrides = {}) {
  const conversation = makeConversation(overrides);
  conversationRepository.findFirst.mockResolvedValue(conversation);
  return conversation;
}

// ========== mock 管線冒煙測試 ==========

describe('mock 管線', () => {
  it('conversationService 匯出 17 個方法', () => {
    expect(Object.keys(conversationService)).toHaveLength(17);
  });

  it('repository 與 serviceClient 已被替換為 mock', () => {
    expect(vi.isMockFunction(conversationRepository.findFirst)).toBe(true);
    expect(vi.isMockFunction(messageRepository.create)).toBe(true);
    expect(vi.isMockFunction(conversationCreationJobRepository.findByKey)).toBe(true);
    expect(vi.isMockFunction(generationStatusRepository.tryAcquireLock)).toBe(true);
    expect(vi.isMockFunction(serviceClient.getCharacter)).toBe(true);
  });
});

// ========== 職責 6：擁有權檢查 ==========
// assertConversationOwnership 守著 9 個以 conversationId 為主鍵的方法，
// 這裡用最單純的 getProtagonist 當載體完整驗證它的四種失敗與一種成功。

describe('職責 6：擁有權檢查（assertConversationOwnership）', () => {
  it('缺 userId → UNAUTHORIZED', async () => {
    await expect(conversationService.getProtagonist(null, CONV_ID)).rejects.toThrow('UNAUTHORIZED');
    expect(conversationRepository.findFirst).not.toHaveBeenCalled();
  });

  it('缺 conversationId → MISSING_CONVERSATION_ID', async () => {
    await expect(conversationService.getProtagonist(OWNER, null)).rejects.toThrow('MISSING_CONVERSATION_ID');
    expect(conversationRepository.findFirst).not.toHaveBeenCalled();
  });

  it('對話不存在 → CONVERSATION_NOT_FOUND', async () => {
    conversationRepository.findFirst.mockResolvedValue(null);
    await expect(conversationService.getProtagonist(OWNER, CONV_ID)).rejects.toThrow('CONVERSATION_NOT_FOUND');
  });

  it('對話屬於別人 → FORBIDDEN', async () => {
    givenOwnedConversation({ userId: 'user_other' });
    await expect(conversationService.getProtagonist(OWNER, CONV_ID)).rejects.toThrow('FORBIDDEN');
  });

  it('內部請求（isInternalRequest）跳過 userId 擁有權比對', async () => {
    givenOwnedConversation({ userId: 'user_other' });
    const messages = [makeMessage(1)];
    messageRepository.findMany.mockResolvedValue(messages);

    // 不帶 userId、且對話屬於別人，內部請求仍應放行
    await expect(
      conversationService.getMessagesByConversationId(null, CONV_ID, 50, 0, { isInternalRequest: true })
    ).resolves.toEqual(messages);
  });
});

// ========== 職責 4：對話建立狀態機 ==========

describe('職責 4：對話建立狀態機', () => {
  describe('getOrCreateConversation', () => {
    it('缺 userId → UNAUTHORIZED', async () => {
      await expect(conversationService.getOrCreateConversation(null, 'char_1')).rejects.toThrow('UNAUTHORIZED');
    });

    it('缺 characterId → MISSING_CHARACTER_ID', async () => {
      await expect(conversationService.getOrCreateConversation(OWNER, null)).rejects.toThrow('MISSING_CHARACTER_ID');
    });

    it('角色不存在 → CHARACTER_NOT_FOUND', async () => {
      serviceClient.getCharacter.mockRejectedValue(new Error('CHARACTER_NOT_FOUND'));
      await expect(conversationService.getOrCreateConversation(OWNER, 'char_1')).rejects.toThrow('CHARACTER_NOT_FOUND');
    });

    it('角色驗證的其他錯誤原樣往上拋（不被吞成 CHARACTER_NOT_FOUND）', async () => {
      serviceClient.getCharacter.mockRejectedValue(new Error('SERVICE_ERROR: connect ECONNREFUSED'));
      await expect(conversationService.getOrCreateConversation(OWNER, 'char_1')).rejects.toThrow('SERVICE_ERROR');
    });

    it('對話已存在 → 回 ready 並帶出訊息列表', async () => {
      serviceClient.getCharacter.mockResolvedValue({ name: '小狼' });
      const messages = [makeMessage(1), makeMessage(2)];
      conversationRepository.findFirst.mockResolvedValue(makeConversation({ messages }));

      const result = await conversationService.getOrCreateConversation(OWNER, 'char_1');

      expect(result.status).toBe('ready');
      expect(result.conversationId).toBe(CONV_ID);
      expect(result.messages).toEqual(messages);
      expect(conversationCreationJobRepository.upsert).not.toHaveBeenCalled();
    });

    it('對話不存在但有 failed job → 回 failed 並清掉該 job（讓使用者可重試）', async () => {
      serviceClient.getCharacter.mockResolvedValue({ name: '小狼' });
      conversationRepository.findFirst.mockResolvedValue(null);
      conversationCreationJobRepository.findByKey.mockResolvedValue({
        status: 'failed',
        error: 'RAG 初始化失敗',
      });

      const result = await conversationService.getOrCreateConversation(OWNER, 'char_1');

      expect(result).toEqual({ status: 'failed', message: 'RAG 初始化失敗' });
      expect(conversationCreationJobRepository.delete).toHaveBeenCalledWith(OWNER, 'char_1');
    });

    it('有 preparing job → 回 preparing 且不重複啟動背景任務', async () => {
      serviceClient.getCharacter.mockResolvedValue({ name: '小狼' });
      conversationRepository.findFirst.mockResolvedValue(null);
      conversationCreationJobRepository.findByKey.mockResolvedValue({ status: 'preparing' });

      const result = await conversationService.getOrCreateConversation(OWNER, 'char_1');

      expect(result).toEqual({ status: 'preparing' });
      expect(conversationCreationJobRepository.upsert).not.toHaveBeenCalled();
      expect(serviceClient.initializeRAG).not.toHaveBeenCalled();
    });

    it('無對話也無 job → 建立 preparing job 並立即回 preparing', async () => {
      serviceClient.getCharacter.mockResolvedValue({ name: '小狼', tags: [], fewShots: [] });
      conversationRepository.findFirst.mockResolvedValue(null);
      conversationCreationJobRepository.findByKey.mockResolvedValue(null);
      // 背景任務是 fire-and-forget 且含 1 秒輪詢迴圈；讓 initializeRAG 立刻失敗，
      // 使它走進 catch 直接結束，測試不會留下待觸發的 timer
      serviceClient.initializeRAG.mockRejectedValue(new Error('SERVICE_ERROR: 測試用'));

      const result = await conversationService.getOrCreateConversation(OWNER, 'char_1');

      expect(result).toEqual({ status: 'preparing' });
      expect(conversationCreationJobRepository.upsert).toHaveBeenCalledWith(
        OWNER,
        'char_1',
        expect.objectContaining({ status: 'preparing' })
      );
    });
  });

  describe('retryConversationCreation', () => {
    it('缺 userId → UNAUTHORIZED', async () => {
      await expect(conversationService.retryConversationCreation(null, 'char_1')).rejects.toThrow('UNAUTHORIZED');
    });

    it('缺 characterId → MISSING_CHARACTER_ID', async () => {
      await expect(conversationService.retryConversationCreation(OWNER, null)).rejects.toThrow('MISSING_CHARACTER_ID');
    });

    it('job 不存在 → NO_FAILED_JOB', async () => {
      conversationCreationJobRepository.findByKey.mockResolvedValue(null);
      await expect(conversationService.retryConversationCreation(OWNER, 'char_1')).rejects.toThrow('NO_FAILED_JOB');
    });

    it('job 狀態不是 failed → JOB_NOT_FAILED', async () => {
      conversationCreationJobRepository.findByKey.mockResolvedValue({ status: 'preparing' });
      await expect(conversationService.retryConversationCreation(OWNER, 'char_1')).rejects.toThrow('JOB_NOT_FAILED');
      expect(conversationCreationJobRepository.delete).not.toHaveBeenCalled();
    });

    it('failed job → 清除並回成功', async () => {
      conversationCreationJobRepository.findByKey.mockResolvedValue({ status: 'failed' });

      const result = await conversationService.retryConversationCreation(OWNER, 'char_1');

      expect(result.success).toBe(true);
      expect(conversationCreationJobRepository.delete).toHaveBeenCalledWith(OWNER, 'char_1');
    });
  });
});

// ========== 職責 1：對話 CRUD（讀取／列表／刪除） ==========

describe('職責 1：對話 CRUD', () => {
  describe('getAllConversations', () => {
    it('缺 userId → UNAUTHORIZED', async () => {
      await expect(conversationService.getAllConversations(null)).rejects.toThrow('UNAUTHORIZED');
    });

    it('回傳該使用者的對話列表', async () => {
      const conversations = [makeConversation()];
      conversationRepository.findMany.mockResolvedValue(conversations);

      await expect(conversationService.getAllConversations(OWNER)).resolves.toEqual(conversations);
      expect(conversationRepository.findMany).toHaveBeenCalledWith(
        { userId: OWNER },
        { updatedAt: 'desc' },
        expect.anything()
      );
    });
  });

  describe('getConversationsSummary', () => {
    it('缺 userId → UNAUTHORIZED', async () => {
      await expect(conversationService.getConversationsSummary(null)).rejects.toThrow('UNAUTHORIZED');
    });

    it('只回傳輕量欄位，不含訊息內容', async () => {
      conversationRepository.findMany.mockResolvedValue([makeConversation()]);

      const result = await conversationService.getConversationsSummary(OWNER);

      expect(result).toEqual([
        {
          conversationId: CONV_ID,
          characterId: 'char_1',
          characterName: '小狼',
          updatedAt: new Date('2026-07-02'),
        },
      ]);
    });
  });

  describe('deleteConversation', () => {
    it('對話屬於別人 → FORBIDDEN，且不動 RAG 與 DB', async () => {
      givenOwnedConversation({ userId: 'user_other' });

      await expect(conversationService.deleteConversation(OWNER, CONV_ID)).rejects.toThrow('FORBIDDEN');
      expect(serviceClient.cleanupRAG).not.toHaveBeenCalled();
      expect(conversationRepository.delete).not.toHaveBeenCalled();
    });

    it('先清 RAG 成功後才刪 DB', async () => {
      givenOwnedConversation();
      serviceClient.cleanupRAG.mockResolvedValue({ status: 'success' });

      await conversationService.deleteConversation(OWNER, CONV_ID);

      expect(serviceClient.cleanupRAG).toHaveBeenCalledWith(CONV_ID);
      expect(conversationRepository.delete).toHaveBeenCalledWith(CONV_ID);
    });

    it('RAG 清理失敗 → 中斷且 DB 不動（不留孤兒資料）', async () => {
      givenOwnedConversation();
      serviceClient.cleanupRAG.mockRejectedValue(new Error('SERVICE_ERROR: ai-service 無法連線'));

      await expect(conversationService.deleteConversation(OWNER, CONV_ID)).rejects.toThrow('SERVICE_ERROR');
      expect(conversationRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('deleteConversationsByCharacter', () => {
    it('缺 userId → UNAUTHORIZED', async () => {
      await expect(conversationService.deleteConversationsByCharacter(null, 'char_1')).rejects.toThrow('UNAUTHORIZED');
    });

    it('缺 characterId → MISSING_CHARACTER_ID', async () => {
      await expect(conversationService.deleteConversationsByCharacter(OWNER, null)).rejects.toThrow('MISSING_CHARACTER_ID');
    });

    it('該角色無對話 → NO_CONVERSATIONS_FOUND', async () => {
      serviceClient.getCharacter.mockResolvedValue({ name: '小狼' });
      conversationRepository.findMany.mockResolvedValue([]);

      await expect(conversationService.deleteConversationsByCharacter(OWNER, 'char_1')).rejects.toThrow('NO_CONVERSATIONS_FOUND');
    });

    it('逐一清 RAG 後才批次刪 DB', async () => {
      serviceClient.getCharacter.mockResolvedValue({ name: '小狼' });
      conversationRepository.findMany.mockResolvedValue([
        makeConversation({ id: 'conv_a' }),
        makeConversation({ id: 'conv_b' }),
      ]);
      serviceClient.cleanupRAG.mockResolvedValue({ status: 'success' });

      const result = await conversationService.deleteConversationsByCharacter(OWNER, 'char_1');

      expect(serviceClient.cleanupRAG).toHaveBeenCalledTimes(2);
      expect(conversationRepository.deleteByCharacterId).toHaveBeenCalledWith('char_1', OWNER);
      expect(result.deletedCount).toBe(2);
    });

    it('任一對話的 RAG 清理失敗 → 中斷且不批次刪 DB', async () => {
      serviceClient.getCharacter.mockResolvedValue({ name: '小狼' });
      conversationRepository.findMany.mockResolvedValue([makeConversation({ id: 'conv_a' })]);
      serviceClient.cleanupRAG.mockRejectedValue(new Error('SERVICE_ERROR: 清理失敗'));

      await expect(conversationService.deleteConversationsByCharacter(OWNER, 'char_1')).rejects.toThrow('SERVICE_ERROR');
      expect(conversationRepository.deleteByCharacterId).not.toHaveBeenCalled();
    });
  });
});

// ========== 職責 2：訊息 CRUD ==========

describe('職責 2：訊息 CRUD', () => {
  describe('sendMessage（依 characterId 的同步保存，不觸發 AI）', () => {
    it('缺 userId → UNAUTHORIZED', async () => {
      await expect(conversationService.sendMessage(null, 'char_1', 'user', 'hi')).rejects.toThrow('UNAUTHORIZED');
    });

    it('缺 text → MISSING_TEXT', async () => {
      await expect(conversationService.sendMessage(OWNER, 'char_1', 'user', '')).rejects.toThrow('MISSING_TEXT');
    });

    it('role 不是 user/assistant → INVALID_ROLE', async () => {
      await expect(conversationService.sendMessage(OWNER, 'char_1', 'system', 'hi')).rejects.toThrow('INVALID_ROLE');
    });

    it('該角色尚無對話 → CONVERSATION_NOT_FOUND', async () => {
      conversationRepository.findFirst.mockResolvedValue(null);
      await expect(conversationService.sendMessage(OWNER, 'char_1', 'user', 'hi')).rejects.toThrow('CONVERSATION_NOT_FOUND');
    });

    it('保存訊息並更新對話的 updatedAt', async () => {
      givenOwnedConversation();
      const created = makeMessage(1, { text: 'hi' });
      messageRepository.create.mockResolvedValue(created);

      const result = await conversationService.sendMessage(OWNER, 'char_1', 'user', 'hi');

      expect(messageRepository.create).toHaveBeenCalledWith({
        conversationId: CONV_ID,
        role: 'user',
        text: 'hi',
      });
      expect(conversationRepository.update).toHaveBeenCalledWith(CONV_ID, expect.objectContaining({ updatedAt: expect.any(Date) }));
      expect(result).toEqual({
        id: created.id,
        role: 'user',
        text: 'hi',
        createdAt: created.createdAt,
      });
    });
  });

  describe('getMessages（依 characterId）', () => {
    it('缺 userId → UNAUTHORIZED', async () => {
      await expect(conversationService.getMessages(null, 'char_1')).rejects.toThrow('UNAUTHORIZED');
    });

    it('該角色尚無對話 → CONVERSATION_NOT_FOUND', async () => {
      conversationRepository.findFirst.mockResolvedValue(null);
      await expect(conversationService.getMessages(OWNER, 'char_1')).rejects.toThrow('CONVERSATION_NOT_FOUND');
    });

    it('依 limit/offset 分頁', async () => {
      givenOwnedConversation();
      messageRepository.findMany.mockResolvedValue([makeMessage(1), makeMessage(2), makeMessage(3)]);

      const result = await conversationService.getMessages(OWNER, 'char_1', 2, 1);

      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('訊息 2');
    });
  });

  describe('getMessagesByConversationId（依 conversationId）', () => {
    it('對話屬於別人 → FORBIDDEN', async () => {
      givenOwnedConversation({ userId: 'user_other' });
      await expect(conversationService.getMessagesByConversationId(OWNER, CONV_ID)).rejects.toThrow('FORBIDDEN');
    });

    it('回傳該對話的訊息（時間升序）', async () => {
      givenOwnedConversation();
      const messages = [makeMessage(1), makeMessage(2)];
      messageRepository.findMany.mockResolvedValue(messages);

      await expect(conversationService.getMessagesByConversationId(OWNER, CONV_ID)).resolves.toEqual(messages);
      expect(messageRepository.findMany).toHaveBeenCalledWith({ conversationId: CONV_ID }, { createdAt: 'asc' });
    });
  });

  describe('getMessageById', () => {
    it('缺 messageId → MISSING_PARAMS（早於擁有權檢查）', async () => {
      await expect(conversationService.getMessageById(OWNER, CONV_ID, null)).rejects.toThrow('MISSING_PARAMS');
      expect(conversationRepository.findFirst).not.toHaveBeenCalled();
    });

    it('對話屬於別人 → FORBIDDEN', async () => {
      givenOwnedConversation({ userId: 'user_other' });
      await expect(conversationService.getMessageById(OWNER, CONV_ID, 'msg_1_padding')).rejects.toThrow('FORBIDDEN');
    });

    it('訊息不存在 → MESSAGE_NOT_FOUND', async () => {
      givenOwnedConversation();
      messageRepository.findFirst.mockResolvedValue(null);
      await expect(conversationService.getMessageById(OWNER, CONV_ID, 'msg_1_padding')).rejects.toThrow('MESSAGE_NOT_FOUND');
    });

    it('回傳單一訊息的公開欄位', async () => {
      givenOwnedConversation();
      const message = makeMessage(1);
      messageRepository.findFirst.mockResolvedValue(message);

      const result = await conversationService.getMessageById(OWNER, CONV_ID, message.id);

      expect(result).toEqual({
        id: message.id,
        role: message.role,
        text: message.text,
        status: message.status,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      });
    });
  });

  describe('deleteMessageAndSubsequent（回溯式刪除）', () => {
    it('缺 userId → UNAUTHORIZED', async () => {
      await expect(conversationService.deleteMessageAndSubsequent(null, CONV_ID, 'msg_1_padding')).rejects.toThrow('UNAUTHORIZED');
    });

    it('缺 messageId → MISSING_PARAMS（早於擁有權檢查，避免誤判成 MESSAGE_NOT_FOUND）', async () => {
      await expect(conversationService.deleteMessageAndSubsequent(OWNER, CONV_ID, null)).rejects.toThrow('MISSING_PARAMS');
      expect(conversationRepository.findFirst).not.toHaveBeenCalled();
    });

    it('對話屬於別人 → FORBIDDEN', async () => {
      givenOwnedConversation({ userId: 'user_other' });
      await expect(conversationService.deleteMessageAndSubsequent(OWNER, CONV_ID, 'msg_1_padding')).rejects.toThrow('FORBIDDEN');
    });

    it('AI 生成中 → AI_GENERATION_IN_PROGRESS（拒絕刪除，避免與生成結果打架）', async () => {
      givenOwnedConversation();
      generationStatusRepository.get.mockReturnValue({ status: 'generating' });

      await expect(conversationService.deleteMessageAndSubsequent(OWNER, CONV_ID, 'msg_1_padding')).rejects.toThrow('AI_GENERATION_IN_PROGRESS');
      expect(messageRepository.deleteManyByIds).not.toHaveBeenCalled();
    });

    it('目標訊息不存在 → MESSAGE_NOT_FOUND', async () => {
      givenOwnedConversation();
      generationStatusRepository.get.mockReturnValue(null);
      messageRepository.findFirst.mockResolvedValue(null);

      await expect(conversationService.deleteMessageAndSubsequent(OWNER, CONV_ID, 'msg_1_padding')).rejects.toThrow('MESSAGE_NOT_FOUND');
    });

    it('目標訊息不是使用者發的 → NOT_USER_MESSAGE', async () => {
      givenOwnedConversation();
      generationStatusRepository.get.mockReturnValue(null);
      messageRepository.findFirst.mockResolvedValue(makeMessage(1, { role: 'assistant' }));

      await expect(conversationService.deleteMessageAndSubsequent(OWNER, CONV_ID, 'msg_1_padding')).rejects.toThrow('NOT_USER_MESSAGE');
    });

    it('刪除目標及其後所有訊息，並清除舊生成狀態', async () => {
      givenOwnedConversation();
      generationStatusRepository.get.mockReturnValue(null);
      const target = makeMessage(2);
      messageRepository.findFirst.mockResolvedValue(target);
      messageRepository.findMany.mockResolvedValue([makeMessage(1), target, makeMessage(3), makeMessage(4)]);
      messageRepository.deleteManyByIds.mockResolvedValue({ count: 3 });

      const result = await conversationService.deleteMessageAndSubsequent(OWNER, CONV_ID, target.id);

      expect(messageRepository.deleteManyByIds).toHaveBeenCalledWith([
        'msg_2_padding',
        'msg_3_padding',
        'msg_4_padding',
      ]);
      expect(result.deletedCount).toBe(3);
      expect(generationStatusRepository.reset).toHaveBeenCalledWith(CONV_ID);
      // 刪除範圍未涉及摘要 → 不該動 Qdrant
      expect(serviceClient.deleteSummaries).not.toHaveBeenCalled();
    });

    it('刪除範圍涉及摘要 → 連動刪 Qdrant 摘要並把刪除點之前的訊息標回未摘要', async () => {
      givenOwnedConversation();
      generationStatusRepository.get.mockReturnValue(null);
      // msg1、msg2 同屬摘要 sum_1；刪除點在 msg2
      const msg1 = makeMessage(1, { summarized: true, summaryId: 'sum_1' });
      const target = makeMessage(2, { summarized: true, summaryId: 'sum_1' });
      const msg3 = makeMessage(3);
      messageRepository.findFirst.mockResolvedValue(target);
      messageRepository.findMany.mockResolvedValue([msg1, target, msg3]);
      messageRepository.deleteManyByIds.mockResolvedValue({ count: 2 });

      await conversationService.deleteMessageAndSubsequent(OWNER, CONV_ID, target.id);

      // 順序關鍵：先刪 Qdrant 摘要（失敗會中止，DB 完好）
      expect(serviceClient.deleteSummaries).toHaveBeenCalledWith(CONV_ID, ['sum_1']);
      // 刪除點之前、被同一摘要涵蓋的 msg1 要標回未摘要
      expect(messageRepository.update).toHaveBeenCalledWith(msg1.id, { summarized: false, summaryId: null });
      expect(messageRepository.deleteManyByIds).toHaveBeenCalledWith([target.id, msg3.id]);
    });

    it('Qdrant 摘要刪除失敗 → 中斷且不刪 DB 訊息', async () => {
      givenOwnedConversation();
      generationStatusRepository.get.mockReturnValue(null);
      const target = makeMessage(2, { summarized: true, summaryId: 'sum_1' });
      messageRepository.findFirst.mockResolvedValue(target);
      messageRepository.findMany.mockResolvedValue([makeMessage(1), target]);
      serviceClient.deleteSummaries.mockRejectedValue(new Error('SERVICE_ERROR: Qdrant 不可用'));

      await expect(conversationService.deleteMessageAndSubsequent(OWNER, CONV_ID, target.id)).rejects.toThrow('SERVICE_ERROR');
      expect(messageRepository.deleteManyByIds).not.toHaveBeenCalled();
    });
  });
});

// ========== 職責 7：主角人設 ==========

describe('職責 7：主角人設', () => {
  describe('getProtagonist', () => {
    it('回傳主角名稱與背景', async () => {
      givenOwnedConversation({ protagonistName: '阿明', protagonistBackground: '一名旅人' });

      await expect(conversationService.getProtagonist(OWNER, CONV_ID)).resolves.toEqual({
        protagonistName: '阿明',
        protagonistBackground: '一名旅人',
      });
    });
  });

  describe('updateProtagonist', () => {
    it('對話屬於別人 → FORBIDDEN，且不動 RAG 與 DB', async () => {
      givenOwnedConversation({ userId: 'user_other' });

      await expect(conversationService.updateProtagonist(OWNER, CONV_ID, '阿明', '背景')).rejects.toThrow('FORBIDDEN');
      expect(serviceClient.updateProtagonistRAG).not.toHaveBeenCalled();
      expect(conversationRepository.update).not.toHaveBeenCalled();
    });

    it('先更新 RAG 成功後才寫 DB', async () => {
      givenOwnedConversation();
      serviceClient.updateProtagonistRAG.mockResolvedValue({ status: 'success' });

      const result = await conversationService.updateProtagonist(OWNER, CONV_ID, '阿明', '一名旅人');

      expect(serviceClient.updateProtagonistRAG).toHaveBeenCalledWith(CONV_ID, '一名旅人');
      expect(conversationRepository.update).toHaveBeenCalledWith(CONV_ID, {
        protagonistName: '阿明',
        protagonistBackground: '一名旅人',
      });
      expect(result).toEqual({ protagonistName: '阿明', protagonistBackground: '一名旅人' });
    });

    it('RAG 更新失敗 → DB 不動（與刪除的順序原則一致）', async () => {
      givenOwnedConversation();
      serviceClient.updateProtagonistRAG.mockRejectedValue(new Error('SERVICE_ERROR: RAG 不可用'));

      await expect(conversationService.updateProtagonist(OWNER, CONV_ID, '阿明', '背景')).rejects.toThrow('SERVICE_ERROR');
      expect(conversationRepository.update).not.toHaveBeenCalled();
    });

    it('空值正規化為 null', async () => {
      givenOwnedConversation();
      serviceClient.updateProtagonistRAG.mockResolvedValue({ status: 'success' });

      const result = await conversationService.updateProtagonist(OWNER, CONV_ID, '', '');

      expect(serviceClient.updateProtagonistRAG).toHaveBeenCalledWith(CONV_ID, '');
      expect(result).toEqual({ protagonistName: null, protagonistBackground: null });
    });
  });
});

// ========== 職責 5：AI 生成狀態機 ==========
//
// mock 的 config：summary.threshold = 100、summary.shortTermLimit = 2、
// ai.timeouts.generateResponse = 60000（殭屍鎖時限 = 60000 + 30000）

/** 讓 sendMessageToConversation 一路走到背景生成：擁有權過關、搶到鎖、AI 正常回覆 */
function givenGenerationCanStart() {
  const conversation = givenOwnedConversation();
  generationStatusRepository.tryAcquireLock.mockResolvedValue(true);
  serviceClient.generateResponse.mockResolvedValue({ message: 'AI 回覆' });
  messageRepository.create.mockResolvedValue(makeMessage(9));
  return conversation;
}

describe('職責 5：AI 生成狀態機', () => {
  describe('sendMessageToConversation', () => {
    it('對話屬於別人 → FORBIDDEN', async () => {
      givenOwnedConversation({ userId: 'user_other' });
      await expect(conversationService.sendMessageToConversation(OWNER, CONV_ID, 'hi')).rejects.toThrow('FORBIDDEN');
    });

    it('先授權再驗輸入：無權限者即使沒帶 text 也是收到 FORBIDDEN 而非 MISSING_TEXT', async () => {
      givenOwnedConversation({ userId: 'user_other' });

      // 400 vs 403 的差異本身就是一種資訊洩漏，這個順序不能被拆檔改掉
      await expect(conversationService.sendMessageToConversation(OWNER, CONV_ID, '')).rejects.toThrow('FORBIDDEN');
      expect(generationStatusRepository.tryAcquireLock).not.toHaveBeenCalled();
    });

    it('有權限但缺 text → MISSING_TEXT，且不搶鎖', async () => {
      givenOwnedConversation();
      await expect(conversationService.sendMessageToConversation(OWNER, CONV_ID, '')).rejects.toThrow('MISSING_TEXT');
      expect(generationStatusRepository.tryAcquireLock).not.toHaveBeenCalled();
    });

    it('搶鎖失敗（別人正在生成）→ AI_GENERATION_IN_PROGRESS', async () => {
      givenOwnedConversation();
      generationStatusRepository.tryAcquireLock.mockResolvedValue(false);

      await expect(conversationService.sendMessageToConversation(OWNER, CONV_ID, 'hi')).rejects.toThrow('AI_GENERATION_IN_PROGRESS');
      expect(messageRepository.findUnsummarized).not.toHaveBeenCalled();
    });

    it('搶鎖時一併寫入本回合的 tempUserId（前端輪詢靠它分辨回合身分）', async () => {
      givenGenerationCanStart();
      messageRepository.findUnsummarized.mockResolvedValue([]);

      await conversationService.sendMessageToConversation(OWNER, CONV_ID, 'hi', 'temp_abc');

      expect(generationStatusRepository.tryAcquireLock).toHaveBeenCalledWith(
        CONV_ID,
        90000, // config.ai.timeouts.generateResponse(60000) + 30000
        { tempUserId: 'temp_abc' }
      );
    });

    it('成功受理 → 立即回 accepted（AI 回覆在背景生成）', async () => {
      givenGenerationCanStart();
      messageRepository.findUnsummarized.mockResolvedValue([]);

      const result = await conversationService.sendMessageToConversation(OWNER, CONV_ID, 'hi', 'temp_abc');

      expect(result).toEqual({
        status: 'accepted',
        message: 'Message received, AI generation in progress',
      });
    });

    it('上鎖後前置流程失敗 → 先解鎖再拋出（否則聊天室會被永久鎖死）', async () => {
      givenOwnedConversation();
      generationStatusRepository.tryAcquireLock.mockResolvedValue(true);
      messageRepository.findUnsummarized.mockRejectedValue(new Error('DB_ERROR'));

      await expect(conversationService.sendMessageToConversation(OWNER, CONV_ID, 'hi')).rejects.toThrow('DB_ERROR');
      expect(generationStatusRepository.releaseLock).toHaveBeenCalledWith(CONV_ID);
    });

    it('內部請求（isInternalRequest）跳過擁有權比對', async () => {
      givenOwnedConversation({ userId: 'user_other' });
      generationStatusRepository.tryAcquireLock.mockResolvedValue(true);
      serviceClient.generateResponse.mockResolvedValue({ message: 'AI 回覆' });
      messageRepository.create.mockResolvedValue(makeMessage(9));
      messageRepository.findUnsummarized.mockResolvedValue([]);

      await expect(
        conversationService.sendMessageToConversation(null, CONV_ID, 'hi', undefined, { isInternalRequest: true })
      ).resolves.toMatchObject({ status: 'accepted' });
    });
  });

  describe('_generateAIResponseAsync（背景生成）', () => {
    it('成功 → 原子性保存「使用者訊息 + AI 回覆」，並寫入臨時 ID 配對資訊', async () => {
      const conversation = makeConversation();
      const userMessage = makeMessage('user', { id: 'msg_real_user_id' });
      const assistantMessage = makeMessage('ai', { id: 'msg_real_ai_id', role: 'assistant' });
      serviceClient.generateResponse.mockResolvedValue({ message: 'AI 回覆' });
      messageRepository.create
        .mockResolvedValueOnce(userMessage)
        .mockResolvedValueOnce(assistantMessage);

      await conversationService._generateAIResponseAsync(conversation, [], '你好', 'temp_abc');

      expect(messageRepository.create).toHaveBeenNthCalledWith(1, {
        conversationId: CONV_ID,
        role: 'user',
        text: '你好',
      });
      expect(messageRepository.create).toHaveBeenNthCalledWith(2, {
        conversationId: CONV_ID,
        role: 'assistant',
        text: 'AI 回覆',
        status: 'completed',
      });
      expect(generationStatusRepository.setCompleted).toHaveBeenCalledWith(CONV_ID, {
        tempUserId: 'temp_abc',
        userMessageId: 'msg_real_user_id',
        assistantMessageId: 'msg_real_ai_id',
      });
    });

    it('AI 生成失敗 → 兩則訊息都不保存，只記錄 failed 狀態', async () => {
      const conversation = makeConversation();
      serviceClient.generateResponse.mockRejectedValue(new Error('SERVICE_ERROR: ai-service 逾時'));

      await conversationService._generateAIResponseAsync(conversation, [], '你好', 'temp_abc');

      expect(messageRepository.create).not.toHaveBeenCalled();
      expect(generationStatusRepository.setCompleted).not.toHaveBeenCalled();
      expect(generationStatusRepository.setFailed).toHaveBeenCalledWith(CONV_ID, 'SERVICE_ERROR: ai-service 逾時');
    });

    it('送給 ai-service 的請求含角色快照與本回合使用者訊息', async () => {
      const conversation = makeConversation({ protagonistName: '阿明' });
      serviceClient.generateResponse.mockResolvedValue({ message: 'AI 回覆' });
      messageRepository.create.mockResolvedValue(makeMessage(9));

      await conversationService._generateAIResponseAsync(conversation, [makeMessage(1)], '你好', undefined);

      expect(serviceClient.generateResponse).toHaveBeenCalledWith({
        conversation_id: CONV_ID,
        character_info: { name: '小狼', gender: 'female', tags: ['狼娘'] },
        conversation_history: [
          { role: 'user', text: '訊息 1' },
          { role: 'user', text: '你好' },
        ],
        protagonist_name: '阿明',
      });
    });
  });

  describe('getAIGenerationStatus', () => {
    it('對話屬於別人 → FORBIDDEN', async () => {
      givenOwnedConversation({ userId: 'user_other' });
      await expect(conversationService.getAIGenerationStatus(OWNER, CONV_ID)).rejects.toThrow('FORBIDDEN');
    });

    it('無記錄 → unknown', async () => {
      givenOwnedConversation();
      generationStatusRepository.get.mockReturnValue(null);

      await expect(conversationService.getAIGenerationStatus(OWNER, CONV_ID)).resolves.toEqual({
        status: 'unknown',
        message: 'No generation status record',
      });
    });

    it('completed → 回傳完整的臨時 ID 配對資訊供前端替換氣泡', async () => {
      givenOwnedConversation();
      const updatedAt = new Date('2026-07-30T10:00:00Z');
      generationStatusRepository.get.mockReturnValue({
        status: 'completed',
        error: null,
        tempUserId: 'temp_abc',
        userMessageId: 'msg_real_user_id',
        assistantMessageId: 'msg_real_ai_id',
        updatedAt,
      });

      await expect(conversationService.getAIGenerationStatus(OWNER, CONV_ID)).resolves.toEqual({
        status: 'completed',
        error: undefined,
        tempUserId: 'temp_abc',
        userMessageId: 'msg_real_user_id',
        assistantMessageId: 'msg_real_ai_id',
        timestamp: updatedAt.getTime(),
      });
    });

    it('failed → 保留 tempUserId（前端靠它判斷失敗屬於哪一回合）', async () => {
      givenOwnedConversation();
      generationStatusRepository.get.mockReturnValue({
        status: 'failed',
        error: 'ai-service 逾時',
        tempUserId: 'temp_abc',
        updatedAt: new Date('2026-07-30T10:00:00Z'),
      });

      const result = await conversationService.getAIGenerationStatus(OWNER, CONV_ID);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('ai-service 逾時');
      expect(result.tempUserId).toBe('temp_abc');
    });
  });

  describe('clearAIGenerationStatus', () => {
    it('對話屬於別人 → FORBIDDEN', async () => {
      givenOwnedConversation({ userId: 'user_other' });
      await expect(conversationService.clearAIGenerationStatus(OWNER, CONV_ID)).rejects.toThrow('FORBIDDEN');
    });

    it('有記錄 → 重置', async () => {
      givenOwnedConversation();
      generationStatusRepository.get.mockReturnValue({ status: 'failed' });

      await conversationService.clearAIGenerationStatus(OWNER, CONV_ID);

      expect(generationStatusRepository.reset).toHaveBeenCalledWith(CONV_ID);
    });

    it('無記錄 → 不做任何事', async () => {
      givenOwnedConversation();
      generationStatusRepository.get.mockReturnValue(null);

      await conversationService.clearAIGenerationStatus(OWNER, CONV_ID);

      expect(generationStatusRepository.reset).not.toHaveBeenCalled();
    });
  });
});

// ========== 職責 3：摘要機制 ==========
//
// 觸發條件（依 mock 的 config）：未摘要訊息數 > shortTermLimit(2)，
// 且「排除最新 2 則後」的剩餘訊息總字數 >= threshold(100)

describe('職責 3：摘要機制', () => {
  /** 產生一則超過閾值長度的訊息 */
  function makeLongMessage(id) {
    return makeMessage(id, { text: '長'.repeat(120) });
  }

  it('訊息數未超過短期記憶上限 → 不觸發摘要', async () => {
    givenGenerationCanStart();
    messageRepository.findUnsummarized.mockResolvedValue([makeLongMessage(1), makeLongMessage(2)]);

    await conversationService.sendMessageToConversation(OWNER, CONV_ID, 'hi');

    expect(serviceClient.generateSummary).not.toHaveBeenCalled();
    expect(messageRepository.findUnsummarized).toHaveBeenCalledTimes(1);
  });

  it('訊息數夠但字數未達閾值 → 不觸發摘要', async () => {
    givenGenerationCanStart();
    messageRepository.findUnsummarized.mockResolvedValue([makeMessage(1), makeMessage(2), makeMessage(3)]);

    await conversationService.sendMessageToConversation(OWNER, CONV_ID, 'hi');

    expect(serviceClient.generateSummary).not.toHaveBeenCalled();
  });

  it('字數達閾值 → 生成摘要、存入向量庫、標記已摘要，並重撈未摘要訊息', async () => {
    givenGenerationCanStart();
    const longMsg = makeLongMessage(1);
    messageRepository.findUnsummarized
      .mockResolvedValueOnce([longMsg, makeMessage(2), makeMessage(3)])
      .mockResolvedValueOnce([makeMessage(2), makeMessage(3)]);
    serviceClient.generateSummary.mockResolvedValue('這是摘要內容');
    serviceClient.addSummary.mockResolvedValue('sum_new');

    await conversationService.sendMessageToConversation(OWNER, CONV_ID, 'hi');

    // 提示詞裡要帶上被摘要的那則訊息（排除最新 2 則之後的候選）
    expect(serviceClient.generateSummary).toHaveBeenCalledWith(CONV_ID, expect.stringContaining(longMsg.text));
    expect(serviceClient.addSummary).toHaveBeenCalledWith(CONV_ID, '這是摘要內容');
    // 被摘要的訊息要記下涵蓋它的 summaryId，供日後回溯刪除時精準配對
    expect(messageRepository.update).toHaveBeenCalledWith(longMsg.id, {
      summarized: true,
      summaryId: 'sum_new',
    });
    // 摘要完成後重撈，確保送給 AI 的是摘要後的短期記憶窗口
    expect(messageRepository.findUnsummarized).toHaveBeenCalledTimes(2);
  });

  it('摘要過程失敗 → 解鎖並拋出（不留下鎖死的聊天室）', async () => {
    givenOwnedConversation();
    generationStatusRepository.tryAcquireLock.mockResolvedValue(true);
    messageRepository.findUnsummarized.mockResolvedValue([makeLongMessage(1), makeMessage(2), makeMessage(3)]);
    serviceClient.generateSummary.mockRejectedValue(new Error('SERVICE_ERROR: 摘要生成失敗'));

    await expect(conversationService.sendMessageToConversation(OWNER, CONV_ID, 'hi')).rejects.toThrow('SERVICE_ERROR');
    expect(generationStatusRepository.releaseLock).toHaveBeenCalledWith(CONV_ID);
  });
});
