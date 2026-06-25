# chat-service

聊天訊息服務，負責存儲和管理用戶與 AI 角色之間的對話記錄。Port 6000。

## 平台架構總覽

| 服務 | 角色 | Port |
|------|------|------|
| auth-service | 認證 | 3000 |
| user-service | 使用者資料 | 4000 |
| character-service | 角色管理 | 5000 |
| **chat-service**（本專案） | 聊天訊息存儲 | 6000 |
| api-gateway | 統一 API 入口，JWT 驗證 | 8000 |

流程：所有前端請求經過 api-gateway，gateway 驗證 JWT 後，將 user_id 以 `x-user-id` header 注入，轉發給對應微服務。

## 技術棧

Node.js + Express 5 + Prisma + SQLite（與其他後端服務保持一致）

## 目前狀態

### 已實裝 ✅
- Express 5 框架 + Prisma ORM + SQLite 資料庫
- Prisma 遷移初始化完成（`migrations/20260624082000_init/`）
- 兩層資料庫設計：Conversation + Message
- 所有 CRUD 操作邏輯實裝
- 認證檢查中介層（x-user-id header）
- 測試用例（test.http）

### 待實裝
- 訊息刪除功能 `DELETE /api/v1/conversations/:conversationId/messages/:messageId`
- 對話刪除功能 `DELETE /api/v1/conversations/:conversationId`
- 訊息編輯功能
- 訊息搜尋功能（可選）
- WebSocket 實時通訊（可選，長期）
- 單元測試

## API 端點

### 公開端點
- `GET /health` — 健康檢查

### 受保護端點（需 `x-user-id` header，由 gateway 注入）

**對話管理：**
- `GET /api/v1/conversations` — 獲取用戶的所有對話
  - Query params: 無
  - Response: 對話陣列，包含最新一條訊息

- `POST /api/v1/conversations` — 建立新對話
  - Body: `{ characterId: string, title?: string }`
  - Response: `{ id, userId, characterId, title, createdAt, updatedAt }`

**訊息管理：**
- `GET /api/v1/conversations/:conversationId/messages` — 獲取對話的訊息
  - Query params: `limit`（預設 50）、`offset`（預設 0）
  - Response: 訊息陣列

- `POST /api/v1/conversations/:conversationId/messages` — 發送訊息
  - Body: `{ role: "user" | "assistant", text: string }`
  - Response: `{ id, conversationId, role, text, createdAt, updatedAt }`

## 資料庫模型

### Conversation 表
- `id` — 對話 ID（CUID）
- `userId` — 所有者用戶 ID
- `characterId` — 角色 ID
- `title` — 對話標題（可選）
- `createdAt` — 建立時間
- `updatedAt` — 更新時間
- 一對多關聯：messages

**索引：**
- userId（快速查詢用戶的對話）
- characterId
- 支援多個對話：同一用戶可與同一角色建立多個獨立對話

### Message 表
- `id` — 訊息 ID（CUID）
- `conversationId` — 所屬對話 ID（外鍵）
- `role` — 角色（"user" 或 "assistant"）
- `text` — 訊息內容
- `createdAt` — 建立時間
- `updatedAt` — 更新時間

**索引：**
- conversationId（快速查詢對話的訊息）
- createdAt（時間排序）
- CASCADE delete（刪除對話時自動刪除訊息）

## 認證流程

1. 前端 (persona-nexus-chat) 發送聊天訊息
2. 请求經過 api-gateway (port 8000)
3. Gateway 驗證 JWT token（Authorization header）
4. Gateway 驗證成功後，在 header 注入 `x-user-id`
5. Gateway 轉發請求到 chat-service
6. chat-service 信任 x-user-id header，不再驗證 JWT

## 待辦

- [ ] Prisma 遷移初始化
- [ ] 完整的資料庫查詢邏輯
- [ ] 訊息分頁和排序
- [ ] 錯誤處理和驗證
- [ ] 日誌記錄
- [ ] 單元測試
- [ ] WebSocket 實時推送（可選）

## 現況補充

- 沒有 git
- 沒有測試框架整合
- 沒有 lint 設定檔
