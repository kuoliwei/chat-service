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

  async create(data) {
    return await prisma.message.create({
      data,
    });
  },

  async delete(id) {
    return await prisma.message.delete({
      where: { id },
    });
  },
};
