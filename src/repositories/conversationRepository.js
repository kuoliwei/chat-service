import { prisma } from '../lib/prisma.js';
import { config } from '../config/index.js';

export const conversationRepository = {
  async findFirst(where, include = {}) {
    return await prisma.conversation.findFirst({
      where,
      include,
    });
  },

  async findMany(where, orderBy = {}, include = {}) {
    return await prisma.conversation.findMany({
      where,
      orderBy,
      include,
    });
  },

  async create(data) {
    return await prisma.conversation.create({
      data,
      include: { messages: true },
    });
  },

  async update(id, data) {
    return await prisma.conversation.update({
      where: { id },
      data,
    });
  },

  async delete(id) {
    return await prisma.conversation.delete({
      where: { id },
    });
  },

  async deleteByCharacterId(characterId, userId = null) {
    const where = { characterId };
    if (userId) {
      where.userId = userId;
    }
    return await prisma.conversation.deleteMany({ where });
  },
};

export const messageRepository = {
  async findMany(where, orderBy = {}) {
    return await prisma.message.findMany({
      where,
      orderBy,
    });
  },

  async findFirst(where) {
    return await prisma.message.findFirst({
      where,
    });
  },

  async findUnsummarized(conversationId, orderBy = { createdAt: 'asc' }) {
    return await prisma.message.findMany({
      where: {
        conversationId,
        summarized: false,
      },
      orderBy,
    });
  },

  async create(data) {
    return await prisma.message.create({
      data,
    });
  },

  async update(id, data) {
    return await prisma.message.update({
      where: { id },
      data,
    });
  },

  async delete(id) {
    return await prisma.message.delete({
      where: { id },
    });
  },

  // 🆕 批量刪除指定 ID 的訊息（用於「刪除訊息及其後所有訊息」）
  async deleteManyByIds(ids) {
    return await prisma.message.deleteMany({
      where: { id: { in: ids } },
    });
  },
};

// 聊天室建立流程的狀態追蹤（原本是進程內記憶體 Map `creationJobs`，改為持久化）。
// config.persistence.enableCreationJobs === false 時改回進程內記憶體 Map（僅供本機測試，
// 服務重啟即遺失所有 job 狀態，不要在正式環境關閉——見 config.txt 說明）。
const memoryJobs = new Map();
const jobKey = (userId, characterId) => `${userId}:${characterId}`;

export const conversationCreationJobRepository = {
  async findByKey(userId, characterId) {
    if (!config.persistence?.enableCreationJobs) {
      return memoryJobs.get(jobKey(userId, characterId)) || null;
    }
    return await prisma.conversationCreationJob.findUnique({
      where: { userId_characterId: { userId, characterId } },
    });
  },

  async upsert(userId, characterId, data) {
    if (!config.persistence?.enableCreationJobs) {
      const key = jobKey(userId, characterId);
      const now = new Date();
      const existing = memoryJobs.get(key);
      const record = {
        userId,
        characterId,
        createdAt: existing?.createdAt || now,
        ...existing,
        ...data,
        updatedAt: now,
      };
      memoryJobs.set(key, record);
      return record;
    }
    return await prisma.conversationCreationJob.upsert({
      where: { userId_characterId: { userId, characterId } },
      create: { userId, characterId, ...data },
      update: data,
    });
  },

  async delete(userId, characterId) {
    if (!config.persistence?.enableCreationJobs) {
      const existed = memoryJobs.delete(jobKey(userId, characterId));
      return { count: existed ? 1 : 0 };
    }
    // 目標紀錄可能已不存在（例如重複清除），用 deleteMany 避免 P2025 例外
    return await prisma.conversationCreationJob.deleteMany({
      where: { userId, characterId },
    });
  },
};

// AI 生成狀態（Conversation 表的 generationStatus 等 6 個欄位，同時兼作並行生成鎖）。
// config.persistence.enableGenerationStatus === false 時改回進程內記憶體 Map（等同
// 持久化之前的舊版行為），僅供本機測試，服務重啟即遺失所有生成中/剛完成的狀態，
// 不要在正式環境關閉——見 config.txt 說明。
const memoryGenerationStatus = new Map();

export const generationStatusRepository = {
  // 讀取目前的生成狀態。enabled 時直接從已抓到的 conversation 物件取欄位（不額外查詢），
  // disabled 時從記憶體 Map 讀。回傳 null 代表目前沒有生成狀態記錄。
  get(conversation) {
    if (!config.persistence?.enableGenerationStatus) {
      const record = memoryGenerationStatus.get(conversation.id);
      // status 欄位為空即視為「沒有生成狀態記錄」，與 DB 分支的判斷規則一致
      // （releaseLock/reset 會把 status 設回 null 但不刪除整筆記錄，靠這裡統一收斂語意）
      return record?.status ? record : null;
    }
    if (!conversation.generationStatus) {
      return null;
    }
    return {
      status: conversation.generationStatus,
      error: conversation.generationError,
      tempUserId: conversation.generationTempUserId,
      userMessageId: conversation.generationUserMessageId,
      assistantMessageId: conversation.generationAssistantMessageId,
      updatedAt: conversation.generationUpdatedAt,
    };
  },

  // 原子性搶鎖：目前沒有生成中、或生成中但已超過殭屍鎖時限 → 上鎖並回傳 true；
  // 否則回傳 false（別人正持有有效的鎖）。
  // enabled 時用 DB updateMany 的 where 條件做「檢查後更新」保證原子性；
  // disabled 時利用 Node 單執行緒特性，同步檢查後立刻寫入 Map，中間不 await，
  // 天然不會被其他請求插隊（與持久化之前的舊版邏輯相同）。
  async tryAcquireLock(conversationId, staleLimitMs) {
    if (!config.persistence?.enableGenerationStatus) {
      const existing = memoryGenerationStatus.get(conversationId);
      if (existing && existing.status === 'generating') {
        const lockAgeMs = Date.now() - (existing.updatedAt?.getTime() || 0);
        if (lockAgeMs < staleLimitMs) {
          return false;
        }
        console.warn(`⚠️  [generationStatusRepository] 偵測到殭屍鎖: 聊天室 ${conversationId} 的 generating 狀態已掛 ${Math.round(lockAgeMs / 1000)} 秒，視為失效並放行`);
      }
      memoryGenerationStatus.set(conversationId, {
        status: 'generating',
        error: null,
        updatedAt: new Date(),
      });
      return true;
    }

    const staleBeforeTimestamp = new Date(Date.now() - staleLimitMs);
    const result = await prisma.conversation.updateMany({
      where: {
        id: conversationId,
        OR: [
          { generationStatus: { not: 'generating' } },
          { generationStatus: null },
          { generationUpdatedAt: { lt: staleBeforeTimestamp } },
        ],
      },
      data: {
        generationStatus: 'generating',
        generationError: null,
        generationUpdatedAt: new Date(),
      },
    });
    return result.count > 0;
  },

  // 釋放鎖（只清 generationStatus，不動其他欄位）——用於上鎖後、進入背景生成前，
  // 前置流程失敗時的緊急解鎖。
  async releaseLock(conversationId) {
    if (!config.persistence?.enableGenerationStatus) {
      const existing = memoryGenerationStatus.get(conversationId);
      if (existing) {
        memoryGenerationStatus.set(conversationId, { ...existing, status: null });
      }
      return;
    }
    await conversationRepository.update(conversationId, { generationStatus: null });
  },

  async setCompleted(conversationId, { tempUserId, userMessageId, assistantMessageId }) {
    if (!config.persistence?.enableGenerationStatus) {
      memoryGenerationStatus.set(conversationId, {
        status: 'completed',
        error: null,
        tempUserId: tempUserId || null,
        userMessageId,
        assistantMessageId,
        updatedAt: new Date(),
      });
      return;
    }
    await conversationRepository.update(conversationId, {
      generationStatus: 'completed',
      generationError: null,
      generationTempUserId: tempUserId || null,
      generationUserMessageId: userMessageId,
      generationAssistantMessageId: assistantMessageId,
      generationUpdatedAt: new Date(),
    });
  },

  async setFailed(conversationId, errorMessage) {
    if (!config.persistence?.enableGenerationStatus) {
      const existing = memoryGenerationStatus.get(conversationId) || {};
      memoryGenerationStatus.set(conversationId, {
        ...existing,
        status: 'failed',
        error: errorMessage,
        updatedAt: new Date(),
      });
      return;
    }
    await conversationRepository.update(conversationId, {
      generationStatus: 'failed',
      generationError: errorMessage,
      generationUpdatedAt: new Date(),
    });
  },

  // 完整重置（清 status/error/tempUserId/userMessageId/assistantMessageId，
  // 保留 updatedAt——與原本兩處呼叫點的欄位範圍一致）。
  // 用於：訊息回溯刪除後清除舊生成狀態、使用者主動清除生成狀態。
  async reset(conversationId) {
    if (!config.persistence?.enableGenerationStatus) {
      const existing = memoryGenerationStatus.get(conversationId);
      if (existing) {
        memoryGenerationStatus.set(conversationId, {
          ...existing,
          status: null,
          error: null,
          tempUserId: null,
          userMessageId: null,
          assistantMessageId: null,
        });
      }
      return;
    }
    await conversationRepository.update(conversationId, {
      generationStatus: null,
      generationError: null,
      generationTempUserId: null,
      generationUserMessageId: null,
      generationAssistantMessageId: null,
    });
  },
};
