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

// 聊天室建立流程的狀態追蹤。DB 版持久化在 ConversationCreationJob 表，服務重啟不遺失；
// 記憶體版退回進程內 Map（原始舊版行為），服務重啟即遺失所有 job 狀態，僅供本機測試
// ——config.persistence.enableCreationJobs === false 時啟用，見 config.txt 說明。
//
// 兩種模式拆成獨立物件（dbCreationJobRepository / memoryCreationJobRepository），
// 選擇只在檔案底部發生一次（模組載入時決定），不再是每個方法各自寫一份
// if (!config.persistence...) 分支——理由與同層的 generationStatusRepository.js 一致。

const dbCreationJobRepository = {
  async findByKey(userId, characterId) {
    return await prisma.conversationCreationJob.findUnique({
      where: { userId_characterId: { userId, characterId } },
    });
  },

  async upsert(userId, characterId, data) {
    return await prisma.conversationCreationJob.upsert({
      where: { userId_characterId: { userId, characterId } },
      create: { userId, characterId, ...data },
      update: data,
    });
  },

  async delete(userId, characterId) {
    // 目標紀錄可能已不存在（例如重複清除），用 deleteMany 避免 P2025 例外
    return await prisma.conversationCreationJob.deleteMany({
      where: { userId, characterId },
    });
  },
};

const memoryJobs = new Map();
const jobKey = (userId, characterId) => `${userId}:${characterId}`;

const memoryCreationJobRepository = {
  async findByKey(userId, characterId) {
    return memoryJobs.get(jobKey(userId, characterId)) || null;
  },

  async upsert(userId, characterId, data) {
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
  },

  async delete(userId, characterId) {
    const existed = memoryJobs.delete(jobKey(userId, characterId));
    return { count: existed ? 1 : 0 };
  },
};

export const conversationCreationJobRepository = config.persistence?.enableCreationJobs
  ? dbCreationJobRepository
  : memoryCreationJobRepository;

// 供測試直接指定模式驗證兩套實作各自的行為，不需要透過 config 開關動態切換
// （見 conversationRepository.test.js）。
export { dbCreationJobRepository, memoryCreationJobRepository };
