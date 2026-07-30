import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';

// ========== Mock 設定 ==========
//
// 只 mock 最底層的 Prisma client 與 config，repository 本身的邏輯全部真實執行。
// 這樣才測得到「持久化開關」兩種模式的行為差異——那正是本層最容易出錯的地方。

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    conversation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    message: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    conversationCreationJob: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

// persistence 旗標在「呼叫時」讀取（不是 import 時），所以測試可以逐案切換
vi.mock('../config/index.js', () => ({
  config: {
    persistence: { enableCreationJobs: true, enableGenerationStatus: true },
  },
}));

import { prisma } from '../lib/prisma.js';
import { config } from '../config/index.js';
import {
  conversationRepository,
  messageRepository,
  conversationCreationJobRepository,
  generationStatusRepository,
} from './conversationRepository.js';

const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
afterAll(() => consoleWarnSpy.mockRestore());

beforeEach(() => {
  vi.clearAllMocks();
  // 每個測試都從「持久化開啟」的正式設定出發
  config.persistence.enableCreationJobs = true;
  config.persistence.enableGenerationStatus = true;
});

// 記憶體模式的 Map 是模組級狀態、無法在測試間重置，
// 因此每個記憶體模式測試都用獨立的 id 避免互相污染
let memoryIdSeq = 0;
const nextMemoryId = () => `conv_mem_${++memoryIdSeq}`;

// ========== conversationRepository ==========

describe('conversationRepository', () => {
  it('findFirst 把 where 與 include 原樣傳給 Prisma', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv_1' });

    await conversationRepository.findFirst({ id: 'conv_1' }, { messages: true });

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: { id: 'conv_1' },
      include: { messages: true },
    });
  });

  it('create 一併帶回 messages（新建對話尚無訊息，回空陣列）', async () => {
    prisma.conversation.create.mockResolvedValue({ id: 'conv_1', messages: [] });

    await conversationRepository.create({ id: 'conv_1', userId: 'user_1' });

    expect(prisma.conversation.create).toHaveBeenCalledWith({
      data: { id: 'conv_1', userId: 'user_1' },
      include: { messages: true },
    });
  });

  it('deleteByCharacterId 未帶 userId 時刪除該角色的全部對話', async () => {
    await conversationRepository.deleteByCharacterId('char_1');

    expect(prisma.conversation.deleteMany).toHaveBeenCalledWith({
      where: { characterId: 'char_1' },
    });
  });

  it('deleteByCharacterId 帶 userId 時限縮在該使用者（避免誤刪他人對話）', async () => {
    await conversationRepository.deleteByCharacterId('char_1', 'user_1');

    expect(prisma.conversation.deleteMany).toHaveBeenCalledWith({
      where: { characterId: 'char_1', userId: 'user_1' },
    });
  });
});

// ========== messageRepository ==========

describe('messageRepository', () => {
  it('findUnsummarized 自動加上 summarized: false 條件', async () => {
    prisma.message.findMany.mockResolvedValue([]);

    await messageRepository.findUnsummarized('conv_1');

    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv_1', summarized: false },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('deleteManyByIds 用 in 條件批次刪除', async () => {
    prisma.message.deleteMany.mockResolvedValue({ count: 3 });

    const result = await messageRepository.deleteManyByIds(['m1', 'm2', 'm3']);

    expect(prisma.message.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['m1', 'm2', 'm3'] } },
    });
    expect(result).toEqual({ count: 3 });
  });

  it('update 依 id 更新指定欄位', async () => {
    await messageRepository.update('m1', { summarized: true, summaryId: 'sum_1' });

    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { summarized: true, summaryId: 'sum_1' },
    });
  });
});

// ========== conversationCreationJobRepository（兩種模式） ==========

describe('conversationCreationJobRepository', () => {
  describe('持久化模式（正式環境設定）', () => {
    it('findByKey 用 userId+characterId 複合主鍵查詢', async () => {
      prisma.conversationCreationJob.findUnique.mockResolvedValue({ status: 'preparing' });

      await conversationCreationJobRepository.findByKey('user_1', 'char_1');

      expect(prisma.conversationCreationJob.findUnique).toHaveBeenCalledWith({
        where: { userId_characterId: { userId: 'user_1', characterId: 'char_1' } },
      });
    });

    it('delete 用 deleteMany 而非 delete，避免紀錄不存在時拋 P2025', async () => {
      await conversationCreationJobRepository.delete('user_1', 'char_1');

      expect(prisma.conversationCreationJob.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user_1', characterId: 'char_1' },
      });
    });
  });

  describe('記憶體模式（本機測試設定）', () => {
    beforeEach(() => {
      config.persistence.enableCreationJobs = false;
    });

    it('完整的 upsert → findByKey → delete 流程不碰 Prisma', async () => {
      const characterId = `char_mem_${++memoryIdSeq}`;

      expect(await conversationCreationJobRepository.findByKey('user_1', characterId)).toBeNull();

      await conversationCreationJobRepository.upsert('user_1', characterId, { status: 'preparing' });
      const job = await conversationCreationJobRepository.findByKey('user_1', characterId);
      expect(job.status).toBe('preparing');

      const deleted = await conversationCreationJobRepository.delete('user_1', characterId);
      expect(deleted).toEqual({ count: 1 });
      expect(await conversationCreationJobRepository.findByKey('user_1', characterId)).toBeNull();

      expect(prisma.conversationCreationJob.findUnique).not.toHaveBeenCalled();
      expect(prisma.conversationCreationJob.upsert).not.toHaveBeenCalled();
    });

    it('delete 不存在的 job 回 count: 0（與持久化模式語意一致）', async () => {
      const result = await conversationCreationJobRepository.delete('user_1', `char_mem_${++memoryIdSeq}`);
      expect(result).toEqual({ count: 0 });
    });
  });
});

// ========== generationStatusRepository（並行鎖協定，本層最微妙的部分） ==========

describe('generationStatusRepository', () => {
  const STALE_LIMIT_MS = 90000;

  describe('get', () => {
    it('持久化模式：直接從已查到的 conversation 物件取欄位，不額外查 DB', () => {
      const updatedAt = new Date('2026-07-30T10:00:00Z');
      const result = generationStatusRepository.get({
        id: 'conv_1',
        generationStatus: 'completed',
        generationError: null,
        generationTempUserId: 'temp_abc',
        generationUserMessageId: 'msg_u',
        generationAssistantMessageId: 'msg_a',
        generationUpdatedAt: updatedAt,
      });

      expect(result).toEqual({
        status: 'completed',
        error: null,
        tempUserId: 'temp_abc',
        userMessageId: 'msg_u',
        assistantMessageId: 'msg_a',
        updatedAt,
      });
      expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    });

    it('持久化模式：generationStatus 為空 → 視為無記錄，回 null', () => {
      expect(generationStatusRepository.get({ id: 'conv_1', generationStatus: null })).toBeNull();
    });

    it('記憶體模式：status 被清空的記錄也視為無記錄（與持久化模式語意一致）', async () => {
      config.persistence.enableGenerationStatus = false;
      const id = nextMemoryId();

      await generationStatusRepository.tryAcquireLock(id, STALE_LIMIT_MS, {});
      await generationStatusRepository.releaseLock(id);

      // releaseLock 只把 status 設成 null、不刪整筆，靠 get 統一收斂語意
      expect(generationStatusRepository.get({ id })).toBeNull();
    });
  });

  describe('tryAcquireLock（原子性搶鎖）', () => {
    it('持久化模式：用 updateMany 的 where 做「檢查後更新」，count > 0 才算搶到', async () => {
      prisma.conversation.updateMany.mockResolvedValue({ count: 1 });

      const acquired = await generationStatusRepository.tryAcquireLock('conv_1', STALE_LIMIT_MS, { tempUserId: 'temp_abc' });

      expect(acquired).toBe(true);
      const call = prisma.conversation.updateMany.mock.calls[0][0];
      // where 需涵蓋「目前不是 generating」與「是 generating 但已超過殭屍鎖時限」
      expect(call.where.id).toBe('conv_1');
      expect(call.where.OR).toEqual([
        { generationStatus: { not: 'generating' } },
        { generationStatus: null },
        { generationUpdatedAt: { lt: expect.any(Date) } },
      ]);
    });

    it('持久化模式：count = 0（別人正持有有效鎖）→ 搶鎖失敗', async () => {
      prisma.conversation.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        generationStatusRepository.tryAcquireLock('conv_1', STALE_LIMIT_MS, {})
      ).resolves.toBe(false);
    });

    it('🔑 上鎖時寫入本回合 tempUserId，並清掉上一回合殘留的訊息 ID', async () => {
      // 這是「聊天氣泡一閃消失」競態的修正核心：generating 狀態若帶著上一回合的
      // userMessageId/assistantMessageId，前端輪詢會誤把剛送出的訊息換成舊訊息
      prisma.conversation.updateMany.mockResolvedValue({ count: 1 });

      await generationStatusRepository.tryAcquireLock('conv_1', STALE_LIMIT_MS, { tempUserId: 'temp_new' });

      expect(prisma.conversation.updateMany.mock.calls[0][0].data).toMatchObject({
        generationStatus: 'generating',
        generationError: null,
        generationTempUserId: 'temp_new',
        generationUserMessageId: null,
        generationAssistantMessageId: null,
      });
    });

    it('記憶體模式：鎖仍在有效期內 → 搶鎖失敗，且不得污染既有回合的欄位', async () => {
      config.persistence.enableGenerationStatus = false;
      const id = nextMemoryId();

      expect(await generationStatusRepository.tryAcquireLock(id, STALE_LIMIT_MS, { tempUserId: 'temp_first' })).toBe(true);
      expect(await generationStatusRepository.tryAcquireLock(id, STALE_LIMIT_MS, { tempUserId: 'temp_second' })).toBe(false);

      // 搶鎖失敗不得改動任何欄位，否則會破壞別人正在進行的回合
      expect(generationStatusRepository.get({ id }).tempUserId).toBe('temp_first');
    });

    it('記憶體模式：偵測到殭屍鎖（超過時限）→ 放行並接管', async () => {
      config.persistence.enableGenerationStatus = false;
      const id = nextMemoryId();

      await generationStatusRepository.tryAcquireLock(id, STALE_LIMIT_MS, { tempUserId: 'temp_zombie' });
      // staleLimit 設為 0，讓既有的鎖立刻被視為過期
      expect(await generationStatusRepository.tryAcquireLock(id, 0, { tempUserId: 'temp_taker' })).toBe(true);
      expect(generationStatusRepository.get({ id }).tempUserId).toBe('temp_taker');
    });

    it('記憶體模式：重新上鎖時整筆覆寫，清掉上一回合的訊息 ID', async () => {
      config.persistence.enableGenerationStatus = false;
      const id = nextMemoryId();

      await generationStatusRepository.tryAcquireLock(id, STALE_LIMIT_MS, { tempUserId: 'temp_1' });
      await generationStatusRepository.setCompleted(id, {
        tempUserId: 'temp_1',
        userMessageId: 'msg_old_u',
        assistantMessageId: 'msg_old_a',
      });
      await generationStatusRepository.tryAcquireLock(id, STALE_LIMIT_MS, { tempUserId: 'temp_2' });

      const status = generationStatusRepository.get({ id });
      expect(status.tempUserId).toBe('temp_2');
      expect(status.userMessageId).toBeNull();
      expect(status.assistantMessageId).toBeNull();
    });
  });

  describe('releaseLock（前置流程失敗時的緊急解鎖）', () => {
    it('持久化模式：只清 generationStatus，不動其他欄位', async () => {
      await generationStatusRepository.releaseLock('conv_1');

      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 'conv_1' },
        data: { generationStatus: null },
      });
    });
  });

  describe('setCompleted', () => {
    it('持久化模式：寫入「臨時 ID ↔ 真實 ID」配對資訊供前端替換氣泡', async () => {
      await generationStatusRepository.setCompleted('conv_1', {
        tempUserId: 'temp_abc',
        userMessageId: 'msg_u',
        assistantMessageId: 'msg_a',
      });

      expect(prisma.conversation.update.mock.calls[0][0].data).toMatchObject({
        generationStatus: 'completed',
        generationError: null,
        generationTempUserId: 'temp_abc',
        generationUserMessageId: 'msg_u',
        generationAssistantMessageId: 'msg_a',
      });
    });

    it('未提供 tempUserId 時正規化為 null', async () => {
      await generationStatusRepository.setCompleted('conv_1', {
        tempUserId: undefined,
        userMessageId: 'msg_u',
        assistantMessageId: 'msg_a',
      });

      expect(prisma.conversation.update.mock.calls[0][0].data.generationTempUserId).toBeNull();
    });
  });

  describe('setFailed', () => {
    it('⚠️ 不得清掉 tempUserId——前端靠它判斷失敗屬於哪一回合', async () => {
      // 若這裡為了「清乾淨」而把 tempUserId 設成 null，前端的回合守門會擋掉真實失敗，
      // 使用者要等滿輪詢超時才看得到失敗訊息。程式碼註解特別標註「沒有任何自動化測試
      // 會抓到」——這則測試就是補上那個缺口。
      await generationStatusRepository.setFailed('conv_1', 'ai-service 逾時');

      const data = prisma.conversation.update.mock.calls[0][0].data;
      expect(data).toMatchObject({
        generationStatus: 'failed',
        generationError: 'ai-service 逾時',
      });
      expect(data).not.toHaveProperty('generationTempUserId');
    });

    it('記憶體模式同樣保留 tempUserId', async () => {
      config.persistence.enableGenerationStatus = false;
      const id = nextMemoryId();

      await generationStatusRepository.tryAcquireLock(id, STALE_LIMIT_MS, { tempUserId: 'temp_keep' });
      await generationStatusRepository.setFailed(id, '生成失敗');

      const status = generationStatusRepository.get({ id });
      expect(status.status).toBe('failed');
      expect(status.error).toBe('生成失敗');
      expect(status.tempUserId).toBe('temp_keep');
    });
  });

  describe('reset（完整重置）', () => {
    it('持久化模式：清掉 status/error/三個 ID，保留 updatedAt', async () => {
      await generationStatusRepository.reset('conv_1');

      const data = prisma.conversation.update.mock.calls[0][0].data;
      expect(data).toEqual({
        generationStatus: null,
        generationError: null,
        generationTempUserId: null,
        generationUserMessageId: null,
        generationAssistantMessageId: null,
      });
      expect(data).not.toHaveProperty('generationUpdatedAt');
    });

    it('記憶體模式：重置後 get 回 null', async () => {
      config.persistence.enableGenerationStatus = false;
      const id = nextMemoryId();

      await generationStatusRepository.tryAcquireLock(id, STALE_LIMIT_MS, { tempUserId: 'temp_x' });
      await generationStatusRepository.reset(id);

      expect(generationStatusRepository.get({ id })).toBeNull();
    });
  });
});
