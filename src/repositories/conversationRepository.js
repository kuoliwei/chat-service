import { prisma } from '../lib/prisma.js';
import { config } from '../config/index.js';

export const conversationRepository = {
  /**
   * 查詢單一對話
   * @param {Object} where - Prisma where 條件
   * @param {Object} [include={}] - Prisma include 條件（如 { messages: {...} }）
   * @returns {Promise<Object|null>} 對話物件，不存在時回 null
   */
  async findFirst(where, include = {}) {
    return await prisma.conversation.findFirst({
      where,
      include,
    });
  },

  /**
   * 查詢多筆對話
   * @param {Object} where - Prisma where 條件
   * @param {Object} [orderBy={}] - 排序條件
   * @param {Object} [include={}] - Prisma include 條件
   * @returns {Promise<Array<Object>>} 對話陣列，無符合結果時回 []
   */
  async findMany(where, orderBy = {}, include = {}) {
    return await prisma.conversation.findMany({
      where,
      orderBy,
      include,
    });
  },

  /**
   * 建立新對話
   * @param {Object} data - 對話資料（含角色快照欄位）
   * @returns {Promise<Object>} 已建立的對話物件（含空的 messages 陣列）
   */
  async create(data) {
    return await prisma.conversation.create({
      data,
      include: { messages: true },
    });
  },

  /**
   * 更新對話
   * @param {string} id - 對話 ID
   * @param {Object} data - 要更新的欄位
   * @returns {Promise<Object>} 更新後的對話物件
   * @throws {Error} Prisma P2025 若對話不存在
   */
  async update(id, data) {
    return await prisma.conversation.update({
      where: { id },
      data,
    });
  },

  /**
   * 刪除對話（訊息因 onDelete: Cascade 自動一併刪除）
   * @param {string} id - 對話 ID
   * @returns {Promise<Object>} 已刪除的對話物件
   * @throws {Error} Prisma P2025 若對話不存在
   */
  async delete(id) {
    return await prisma.conversation.delete({
      where: { id },
    });
  },

  /**
   * 依角色 ID（可選再限定 userId）批量刪除對話
   * @param {string} characterId - 角色 ID
   * @param {string} [userId=null] - 使用者 ID，提供時只刪除該使用者的對話
   * @returns {Promise<{count: number}>} 刪除筆數
   */
  async deleteByCharacterId(characterId, userId = null) {
    const where = { characterId };
    if (userId) {
      where.userId = userId;
    }
    return await prisma.conversation.deleteMany({ where });
  },
};

export const messageRepository = {
  /**
   * 查詢多筆訊息
   * @param {Object} where - Prisma where 條件
   * @param {Object} [orderBy={}] - 排序條件
   * @returns {Promise<Array<Object>>} 訊息陣列，無符合結果時回 []
   */
  async findMany(where, orderBy = {}) {
    return await prisma.message.findMany({
      where,
      orderBy,
    });
  },

  /**
   * 查詢單一訊息
   * @param {Object} where - Prisma where 條件
   * @returns {Promise<Object|null>} 訊息物件，不存在時回 null
   */
  async findFirst(where) {
    return await prisma.message.findFirst({
      where,
    });
  },

  /**
   * 查詢某對話所有未摘要的訊息（summarized === false）
   * @param {string} conversationId - 對話 ID
   * @param {Object} [orderBy={createdAt: 'asc'}] - 排序條件
   * @returns {Promise<Array<Object>>} 訊息陣列，依 createdAt 遞增排序
   */
  async findUnsummarized(conversationId, orderBy = { createdAt: 'asc' }) {
    return await prisma.message.findMany({
      where: {
        conversationId,
        summarized: false,
      },
      orderBy,
    });
  },

  /**
   * 建立新訊息
   * @param {Object} data - 訊息資料 { conversationId, role, text, status? }
   * @returns {Promise<Object>} 已建立的訊息物件
   */
  async create(data) {
    return await prisma.message.create({
      data,
    });
  },

  /**
   * 更新訊息
   * @param {string} id - 訊息 ID
   * @param {Object} data - 要更新的欄位
   * @returns {Promise<Object>} 更新後的訊息物件
   * @throws {Error} Prisma P2025 若訊息不存在
   */
  async update(id, data) {
    return await prisma.message.update({
      where: { id },
      data,
    });
  },

  /**
   * 刪除單一訊息
   * @param {string} id - 訊息 ID
   * @returns {Promise<Object>} 已刪除的訊息物件
   * @throws {Error} Prisma P2025 若訊息不存在
   */
  async delete(id) {
    return await prisma.message.delete({
      where: { id },
    });
  },

  /**
   * 批量刪除指定 ID 的訊息（用於「刪除訊息及其後所有訊息」的回溯式刪除）
   * @param {Array<string>} ids - 訊息 ID 陣列
   * @returns {Promise<{count: number}>} 刪除筆數
   */
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
  //
  // 🔑 【回合身分】上鎖 = 「本回合開始」的唯一原子性時間點，因此這裡必須順手做兩件事：
  //   1. 寫入本回合的 tempUserId（前端樂觀更新的臨時訊息 ID）
  //   2. 把 userMessageId / assistantMessageId 清成 null
  // 否則這三個欄位會一路留著「上一回合」setCompleted 寫進去的值（只有 setCompleted
  // 會寫它們），使 generating 狀態變成「狀態碼是新的、訊息 ID 是舊的」的混合體。
  // 前端在 POST 尚未抵達本行之前就已開始輪詢，讀到那種混合狀態會誤把剛送出的訊息
  // 換成上一回合的舊訊息並停止輪詢——畫面上兩個氣泡一閃消失。
  // 搶鎖失敗時不得修改任何欄位（否則會污染別人正在進行的回合）。
  async tryAcquireLock(conversationId, staleLimitMs, { tempUserId } = {}) {
    if (!config.persistence?.enableGenerationStatus) {
      const existing = memoryGenerationStatus.get(conversationId);
      if (existing && existing.status === 'generating') {
        const lockAgeMs = Date.now() - (existing.updatedAt?.getTime() || 0);
        if (lockAgeMs < staleLimitMs) {
          return false;
        }
        console.warn(`⚠️  [generationStatusRepository] 偵測到殭屍鎖: 聊天室 ${conversationId} 的 generating 狀態已掛 ${Math.round(lockAgeMs / 1000)} 秒，視為失效並放行`);
      }
      // 整筆覆寫（不 spread existing）：與 DB 分支一樣達成「清空上一回合訊息 ID」的效果
      memoryGenerationStatus.set(conversationId, {
        status: 'generating',
        error: null,
        tempUserId: tempUserId || null,
        userMessageId: null,
        assistantMessageId: null,
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
        generationTempUserId: tempUserId || null,
        generationUserMessageId: null,
        generationAssistantMessageId: null,
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

  // ⚠️ 【不要清 tempUserId】本回合的 tempUserId 已由 tryAcquireLock 在上鎖時寫入，
  // setFailed 必須原封保留它——前端靠這個欄位判斷「這個 failed 屬於哪一回合」，
  // 才能立刻把佔位符換成失敗氣泡。若為了「清乾淨」而在這裡把它設成 null，
  // 前端的回合守門會擋掉真實失敗，使用者要等滿 120 秒輪詢超時才看得到失敗訊息，
  // 而且沒有任何自動化測試會抓到（本服務零測試框架）。
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
