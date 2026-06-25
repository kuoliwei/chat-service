import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';

const app = express();
const port = process.env.PORT || 6000;
const prisma = new PrismaClient();

// 中介層
app.use(cors());
app.use(express.json());

// 認證檢查中介層
const requireUserId = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ message: 'Missing x-user-id header' });
  }
  req.userId = userId;
  next();
};

// 健康檢查
app.get('/health', (req, res) => {
  return res.status(200).json({
    status: 'ok',
    service: 'chat-service',
  });
});

// 獲取或建立角色對話（前端 API）
app.get('/api/v1/conversations/character/:characterId', requireUserId, async (req, res) => {
  try {
    const { characterId } = req.params;
    const userId = req.userId;

    console.log(`📡 [chat-service] GET /conversations/character/${characterId}, userId: ${userId}`);

    // 查詢該用戶與該角色的最新對話
    let conversation = await prisma.conversation.findFirst({
      where: {
        userId,
        characterId,
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // 如果沒有對話，建立新對話
    if (!conversation) {
      console.log(`➕ [chat-service] 建立新對話`);
      conversation = await prisma.conversation.create({
        data: {
          userId,
          characterId,
          title: null,
        },
        include: {
          messages: true,
        },
      });
    }

    // 返回對話內容（不包含 conversationId 和 characterId）
    return res.status(200).json({
      messages: conversation.messages,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    });
  } catch (error) {
    console.error('❌ [chat-service] Error in GET /conversations/character:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// 獲取角色對話的訊息（可選，用於分頁等）
app.get('/api/v1/conversations/character/:characterId/messages', requireUserId, async (req, res) => {
  try {
    const { characterId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    const userId = req.userId;

    // 查詢該用戶與該角色的最新對話
    const conversation = await prisma.conversation.findFirst({
      where: {
        userId,
        characterId,
      },
    });

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    // 獲取訊息
    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
      skip: parseInt(offset),
      take: parseInt(limit),
    });

    return res.status(200).json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// 發送訊息到角色對話（前端 API）
app.post('/api/v1/conversations/character/:characterId/messages', requireUserId, async (req, res) => {
  try {
    const { characterId } = req.params;
    const { role, text } = req.body;
    const userId = req.userId;

    console.log(`📤 [chat-service] POST /conversations/character/${characterId}/messages`);
    console.log(`   userId: ${userId}, role: ${role}, text: ${text}`);

    if (!text) {
      return res.status(400).json({ message: 'Missing text field' });
    }

    if (!role || !['user', 'assistant'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role field' });
    }

    // 查詢該用戶與該角色的最新對話
    console.log(`🔍 [chat-service] 查詢對話: userId=${userId}, characterId=${characterId}`);
    const conversation = await prisma.conversation.findFirst({
      where: {
        userId,
        characterId,
      },
    });

    console.log(`   對話查詢結果:`, conversation ? `找到 (id: ${conversation.id})` : '未找到');

    if (!conversation) {
      console.log(`❌ [chat-service] 對話不存在`);
      return res.status(400).json({ message: 'Conversation not found. Please GET /conversations/character/{characterId} first.' });
    }

    // 建立訊息
    console.log(`💾 [chat-service] 建立訊息...`);
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role,
        text,
      },
    });

    console.log(`   訊息已建立: id=${message.id}`);

    // 更新對話的 updatedAt
    console.log(`🔄 [chat-service] 更新對話時間...`);
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    console.log(`✅ [chat-service] 訊息已發送`);
    return res.status(201).json({
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    });
  } catch (error) {
    console.error('❌ [chat-service] Error in POST /conversations/character:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// 保留舊 API（向後相容，可選）
app.get('/api/v1/conversations', requireUserId, async (req, res) => {
  try {
    const conversations = await prisma.conversation.findMany({
      where: { userId: req.userId },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return res.status(200).json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// 404 處理
app.use((req, res) => {
  return res.status(404).json({
    message: 'Route not found',
  });
});

// 啟動伺服器
app.listen(port, () => {
  console.log(`chat-service is running on port ${port}`);
});
