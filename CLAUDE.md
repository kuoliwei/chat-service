# chat-service

聊天訊息服務，負責存儲和管理用戶與 AI 角色之間的對話記錄，並協調 RAG 記憶（角色背景、few-shot、歷史摘要）與非同步 AI 回覆生成。Port 6000。

## 平台架構總覽

| 服務 | 角色 | Port |
|------|------|------|
| auth-service | 認證 | 3000 |
| user-service | 使用者資料 | 4000 |
| character-service | 角色管理 | 5000 |
| **chat-service**（本專案） | 聊天訊息存儲 + RAG 協調 | 6000 |
| ai-service | LLM 生成 + RAG 向量庫 | （經 gateway 轉發） |
| api-gateway | 統一 API 入口，JWT 驗證 | 8000 |

流程：前端請求經 api-gateway，gateway 驗證 JWT 後注入 `x-user-id` header 轉發。chat-service 對外呼叫 ai-service 一律也經過 gateway 的 `/internal/*` 路由（`src/lib/serviceClient.js`），不直連。

## 技術棧

Node.js + Express 5 + Prisma（SQLite）+ axios（服務間呼叫）

⚠️ 目前沒有任何測試框架整合、沒有 `*.test.js` 檔案（`package.json` 原本的 `"test": "jest"` 因 jest
從未安裝而必定失敗，已於 `simplify-chat-service` change 移除該 script，避免誤導）。驗證僅靠
`test.http` 手動整合測試。

## 目前狀態（已實裝）

- Express 5 + Prisma ORM + SQLite，雙資料模型：Conversation（含角色/主角快照欄位）+ Message
- 聊天室建立採**非同步 + 輪詢**：`getOrCreateConversation` 先回 `202 preparing`，背景任務 `_prepareAndCreateConversation` 發起 RAG 初始化並輪詢其狀態，完成才寫 DB；記憶體 Map（`creationJobs`）追蹤建立中/失敗狀態
- 發送訊息也是**非同步**：`sendMessageToConversation` 立即回 `201 accepted`，背景 `_generateAIResponseAsync` 呼叫 ai-service 生成回覆，成功才**原子性**存用戶訊息＋AI 回覆；記憶體 Map（`aiGenerationStatus`）追蹤 generating/completed/failed，供前端輪詢
- 摘要機制：未摘要訊息字數達閾值（`config.summary.threshold`）時，先摘要較舊訊息（呼叫 ai-service 生成摘要 + 存入 Qdrant），標記 `summarized`/`summaryId`，短期記憶只留最新 N 條（`shortTermLimit`）
- 訊息回溯刪除（`deleteMessageAndSubsequent`）：刪除某則用戶訊息會連帶刪除其後所有訊息；若刪除範圍涉及已摘要訊息，會連動刪除對應 Qdrant 摘要，並把刪除點之前、被同一摘要涵蓋的訊息標回未摘要
- 對話刪除 / 依角色刪除對話：**先清 RAG（失敗即中斷、DB 不動）→ 成功才刪 DB**
- 主角人設（使用者扮演角色）讀取/更新，更新採**先寫 RAG 再寫 DB**
- 「重啟聊天室」已移除專用端點，前端改複用「刪除 + 建立」既有管線
- 並行防護：同一聊天室已有 AI 生成任務進行中時拒絕新訊息（含殭屍鎖逾時保險）與拒絕刪除訊息
- 集中的擁有權檢查 `assertConversationOwnership`（`conversationService.js`）：所有以 `conversationId` 為主鍵的方法都先過這關，修正過去 4 處方法各自漏寫 userId 驗證的漏洞（跨帳號讀取/寫入）
- Controller 的錯誤碼→HTTP 映射改用共用 `ERROR_MAP` 查表（與 auth/user/character 三服務風格一致）；`sendMessage`（依 characterId）對話不存在時已統一為 404（原為 400，`simplify-chat-service` 唯一的可觀察行為變更）

### 已知限制（`simplify-chat-service` change 已於 2026-07-25 處理清理項，本輪未處理項如下）

- **大量除錯用 `console.log`**（含明顯的 `🐛 [DEBUG]` 前綴），散布在 controller 與 service 全層——本輪確認暫緩，非本輪範圍
- 記憶體 Map（`creationJobs`、`aiGenerationStatus`）屬進程內狀態，重啟服務即遺失——12-Factor Processes（無狀態）的已知限制，本輪確認不處理（牽涉是否改用持久化儲存的架構決策，影響範圍較大，留待日後獨立評估）
- `src/config/config.txt`：`config.json` 的說明文件（非程式碼），內容包含已知未使用的 `rag.topK`/`rag.threshold` 欄位，非本輪範圍
- `conversationService.js` 直接依賴具體 repository/serviceClient，非抽象介面（SOLID-DIP）——JS 環境下屬約定俗成，確認不處理

**已清除（本輪處理完成）：**
- ~~`src/app.js.backup`（舊版 Express app 死代碼）~~ → 已刪除
- ~~`authMiddleware.js` 寫入的 `req.userId`（無人讀取的死欄位）~~ → 已移除
- ~~`prisma.config.ts`（已查證 Prisma 5.22 CLI 不讀取，確認為死代碼）~~ → 已刪除
- ~~`cors()` 允許所有 origin~~ → 已移除（已 grep 前端 `persona-nexus-chat` 確認無啟用中直連路徑）
- ~~`package.json` 的 `"test": "jest"`（斷掉的 script）~~ → 已移除

## API 端點

### 公開端點
- `GET /health` — 健康檢查

### 受保護端點（需 `x-user-id` header，由 gateway 注入）

**對話管理：**
- `GET /api/v1/conversations/character/:characterId` — 取得或建立對話（202 preparing / 200 ready / 503 failed，前端輪詢）
- `GET /api/v1/conversations/summary` — 取得用戶所有對話摘要（輕量版）
- `GET /api/v1/conversations` — 取得用戶所有對話（含最新一則訊息）
- `POST /api/v1/conversations/character/:characterId/retry` — 清除失敗的建立 job，允許重試
- `DELETE /api/v1/conversations/:conversationId` — 刪除單一對話（先清 RAG）
- `DELETE /api/v1/conversations/character/:characterId` — 刪除該角色的所有對話（先清 RAG）

**訊息管理：**
- `GET /api/v1/conversations/character/:characterId/messages` — 依角色查詢訊息（舊方法）
- `GET /api/v1/conversations/:conversationId/messages` — 依對話 ID 查詢訊息（新方法）
- `POST /api/v1/conversations/character/:characterId/messages` — 發送訊息到某角色最新對話（同步保存，無 AI 生成）
- `POST /api/v1/conversations/:conversationId/messages` — 發送訊息到指定對話（非同步 AI 生成，含摘要機制與並行防護）
- `GET /api/v1/conversations/:conversationId/messages/:messageId` — 查詢單一訊息（供輪詢配對）
- `DELETE /api/v1/conversations/:conversationId/messages/:messageId` — 回溯式刪除訊息（含連動摘要清理）

**主角人設：**
- `GET /api/v1/conversations/:conversationId/protagonist`
- `PUT /api/v1/conversations/:conversationId/protagonist`

**AI 生成狀態（輪詢用）：**
- `GET /api/v1/conversations/:conversationId/ai-generation-status`
- `DELETE /api/v1/conversations/:conversationId/ai-generation-status`

## 資料庫模型

### Conversation 表
- `id`（cuid）、`userId`、`characterId`、`title?`、`createdAt`、`updatedAt`
- 角色快照（建立時保存，不受角色後續編輯影響）：`characterName`、`characterGender`、`characterTags`（JSON 字串）、`characterIntroduction`、`characterBackground`、`characterOpening`、`characterFewShots`（JSON 字串）
- 主角人設：`protagonistName?`、`protagonistBackground?`
- 一對多：`messages`
- 索引：`userId`、`characterId`

### Message 表
- `id`（cuid）、`conversationId`、`role`（"user"|"assistant"）、`text`
- `status`（預設 "completed"，"pending" 目前未見寫入路徑實際使用 pending 值）
- `summarized`（是否已被摘要覆蓋）、`summaryId?`（涵蓋此訊息的摘要 ID = Qdrant point id）
- `createdAt`、`updatedAt`
- 多對一：`conversation`（`onDelete: Cascade`）
- 索引：`conversationId`、`createdAt`

## 認證流程

1. 前端發送請求 → api-gateway (port 8000) 驗證 JWT → 注入 `x-user-id` header → 轉發 chat-service
2. chat-service 信任 `x-user-id` header，不再驗證 JWT（`authMiddleware.js`）
3. chat-service 呼叫 ai-service / character-service 一律經 gateway 的 `/internal/*` 路由（`serviceClient.js`），必要時把 `x-user-id` 一併轉傳

## 演進歷史（節錄自 git log）

依時間序：初始 CRUD → 服務間通訊（呼叫 character-service）→ RAG 整合生成 → 非同步 AI 回覆 + 前端輪詢 → 重啟對話最佳化 → 防止 `error.message` 外洩前端 → AI 生成狀態內存追蹤 + 刪除順序修正 + 摘要被動拋錯 → 訊息回溯刪除 + 摘要配對機制 + 主角人設 + 並行生成鎖 → 移除專用重啟管線 → 摘要機制重構 + 延長 AI timeout → 修正跨帳號授權漏洞 → 依《後端系統設計原則》稽核後以 change `simplify-chat-service` 清理（ERROR_MAP 查表化、刪除死代碼、移除多餘 CORS、統一 sendMessage 錯誤碼，2026-07-25，本次優化）

## 現況補充

- 有 git（`main` branch，已與 origin 同步），**與先前文件「沒有 git」的紀錄不符——已更正**
- 沒有測試框架整合（`package.json` 已移除斷掉的 `test` script），驗證僅靠 `test.http` 手動整合測試（2026-07-25 驗證：健康檢查、缺 header、角色不存在、`sendMessage`/`sendMessageToConversation` 對話不存在時皆回 404、缺欄位、job 未找到、依角色刪除對話找不到角色等情境皆通過）
- 沒有 lint 設定檔
