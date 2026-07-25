import { prisma } from '../lib/prisma.js';

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
export const conversationCreationJobRepository = {
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
