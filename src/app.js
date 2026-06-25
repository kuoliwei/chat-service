import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { authMiddleware } from './middlewares/authMiddleware.js';
import { conversationController } from './controllers/conversationController.js';

const app = express();
const port = process.env.PORT || 6000;

app.use(cors());
app.use(express.json());

// 健康檢查
app.get('/health', (req, res) => {
  return res.status(200).json({
    status: 'ok',
    service: 'chat-service',
  });
});

// 【取得或建立對話】查詢該用戶與該角色的最新對話，若無則建立新對話
app.get('/api/v1/conversations/character/:characterId', authMiddleware, conversationController.getOrCreateConversation);

// 【取得對話摘要】查詢該用戶的所有對話摘要（輕量版，只含 ID、角色名、更新時間）
app.get('/api/v1/conversations/summary', authMiddleware, conversationController.getConversationsSummary);

// 【取得所有對話】查詢該用戶的所有對話
app.get('/api/v1/conversations', authMiddleware, conversationController.getAllConversations);

// 【取得對話訊息】查詢某對話的訊息列表
app.get('/api/v1/conversations/character/:characterId/messages', authMiddleware, conversationController.getMessages);

// 【發送訊息】發送訊息到某角色的最新對話
app.post('/api/v1/conversations/character/:characterId/messages', authMiddleware, conversationController.sendMessage);

// 【發送訊息】直接發送訊息到指定對話
app.post('/api/v1/conversations/:conversationId/messages', authMiddleware, conversationController.sendMessageToConversation);

// 【刪除對話】刪除單個對話
app.delete('/api/v1/conversations/:conversationId', authMiddleware, conversationController.deleteConversation);

// 【刪除角色對話】刪除該角色的所有對話
app.delete('/api/v1/conversations/character/:characterId', authMiddleware, conversationController.deleteConversationsByCharacter);

// 【重啟聊天室】根據 characterId 找到使用者與該角色的最新聊天室，刪除後建立新聊天室
app.post('/api/v1/conversations/character/:characterId/restart', authMiddleware, conversationController.restartConversation);

// 【重啟聊天室】直接用 conversationId 刪除並建立新聊天室（推薦：前端已有 ID）
app.post('/api/v1/conversations/:conversationId/restart', authMiddleware, conversationController.restartConversationById);

app.listen(port, () => {
  console.log(`===============================================`);
  console.log(`  Chat-Service 伺服器已成功啟動！`);
  console.log(`  正在監聽連接埠：http://localhost:${port}`);
  console.log(`===============================================`);
});
