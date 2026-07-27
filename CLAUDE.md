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
- 聊天室建立採**非同步 + 輪詢**：`getOrCreateConversation` 先回 `202 preparing`，背景任務 `_prepareAndCreateConversation` 發起 RAG 初始化並輪詢其狀態，完成才寫 DB；建立中/失敗狀態持久化在 `ConversationCreationJob` 表（`userId`+`characterId` 為主鍵），非記憶體 Map，服務重啟不遺失
- 發送訊息也是**非同步**：`sendMessageToConversation` 立即回 `201 accepted`，背景 `_generateAIResponseAsync` 呼叫 ai-service 生成回覆，成功才**原子性**存用戶訊息＋AI 回覆；生成中/完成/失敗狀態持久化在 `Conversation` 表的 `generationStatus`/`generationError`/`generationTempUserId`/`generationUserMessageId`/`generationAssistantMessageId`/`generationUpdatedAt` 欄位（透過 `conversationRepository` 讀寫），非記憶體 Map，供前端輪詢；服務重啟後仍可正確恢復（2026-07-26 已透過重啟服務實測驗證，見 K1-K5）
- **2026-07-27 新增｜持久化可透過 config 切換回記憶體版本（僅供本機測試）**：`config.json` 的 `persistence.enableCreationJobs`／`persistence.enableGenerationStatus` 兩個旗標（預設皆為 `true`，行為與上述兩點一致）。設為 `false` 時，`conversationCreationJobRepository`／`generationStatusRepository`（`src/repositories/conversationRepository.js`）改用進程內記憶體 Map，等同持久化之前的舊版行為——服務重啟狀態立即消失，不需要再等殭屍鎖逾時（`generateResponse` timeout + 30 秒）。動機：手動測試時常需要中途重啟 chat-service（例如驗證其他服務的斷線恢復），持久化開啟時，中斷的 job／生成鎖會殘留在 DB 裡卡住後續操作。兩個旗標各自獨立生效，`get`/`tryAcquireLock`/`releaseLock`/`setCompleted`/`setFailed`/`reset` 等方法的行為在兩種模式下經測試腳本驗證完全一致（14/14 通過）。**不要在正式環境關閉**——關閉後服務重啟會遺失所有進行中/剛完成的狀態，前端輪詢配對會查無記錄。`config.json` 本身有進版控，關閉這兩個旗標屬本機暫時測試設定，不應 commit。
- 摘要機制：未摘要訊息字數達閾值（`config.summary.threshold`）時，先摘要較舊訊息（呼叫 ai-service 生成摘要 + 存入 Qdrant），標記 `summarized`/`summaryId`，短期記憶只留最新 N 條（`shortTermLimit`）
- 訊息回溯刪除（`deleteMessageAndSubsequent`）：刪除某則用戶訊息會連帶刪除其後所有訊息；若刪除範圍涉及已摘要訊息，會連動刪除對應 Qdrant 摘要，並把刪除點之前、被同一摘要涵蓋的訊息標回未摘要
- 對話刪除 / 依角色刪除對話：**先清 RAG（失敗即中斷、DB 不動）→ 成功才刪 DB**
- 主角人設（使用者扮演角色）讀取/更新，更新採**先寫 RAG 再寫 DB**
- 「重啟聊天室」已移除專用端點，前端改複用「刪除 + 建立」既有管線
- 並行防護：同一聊天室已有 AI 生成任務進行中時拒絕新訊息（含殭屍鎖逾時保險）與拒絕刪除訊息
- 集中的擁有權檢查 `assertConversationOwnership`（`conversationService.js`）：所有以 `conversationId` 為主鍵的方法都先過這關，修正過去 4 處方法各自漏寫 userId 驗證的漏洞（跨帳號讀取/寫入）；支援 `{ isInternalRequest }` 選項——gateway 的 `/internal/conversations` 與 `/internal/conversations/:id/messages` 路由轉發過來的內部請求（`x-internal-request: true`）跳過 userId 擁有權比對，供 ai-service 查詢/寫入對話歷史
- Controller 的錯誤碼→HTTP 映射改用共用 `ERROR_MAP` 查表（與 auth/user/character 三服務風格一致）；`sendMessage`（依 characterId）對話不存在時已統一為 404（原為 400，`simplify-chat-service` 唯一的可觀察行為變更）

### 已知限制

- **大量除錯用 `console.log`**（含明顯的 `🐛 [DEBUG]` 前綴），散布在 controller 與 service 全層——`simplify-chat-service` change（2026-07-25）確認暫緩，非該輪範圍，目前仍未處理
- `src/config/config.txt`：`config.json` 的說明文件（非程式碼），內容包含已知未使用的 `rag.topK`/`rag.threshold` 欄位，非本輪範圍
- `conversationService.js` 直接依賴具體 repository/serviceClient，非抽象介面（SOLID-DIP）——JS 環境下屬約定俗成，確認不處理

**已解決（曾是已知限制，現已修正）：**
- ~~記憶體 Map（`creationJobs`、`aiGenerationStatus`）屬進程內狀態，重啟服務即遺失~~ → 已改為持久化：`ConversationCreationJob` 表 + `Conversation` 表的 `generationStatus` 等欄位（Prisma migration `20260725092955_add_persistent_generation_and_creation_job_state`），2026-07-26 已透過實際重啟服務驗證（K1-K5）狀態正確存活，不再是 12-Factor Processes（無狀態）的違反項

**已清除（本輪處理完成）：**
- ~~`src/app.js.backup`（舊版 Express app 死代碼）~~ → 已刪除
- ~~`authMiddleware.js` 寫入的 `req.userId`（無人讀取的死欄位）~~ → 該行已移除，`authMiddleware.js` 本體之後也已整檔刪除（無獨立授權 middleware，改由 service 層 `validateUserId()` 把關）
- ~~`prisma.config.ts`（已查證 Prisma 5.22 CLI 不讀取，確認為死代碼）~~ → 已刪除
- ~~`cors()` 允許所有 origin~~ → 已移除（已 grep 前端 `persona-nexus-chat` 確認無啟用中直連路徑）
- ~~`package.json` 的 `"test": "jest"`（斷掉的 script）~~ → 已移除

## API 端點

### 公開端點
- `GET /health` — 健康檢查

### 受保護端點（需 `x-user-id` header，由 gateway 注入；以 `conversationId` 為主鍵的路由另有 gateway `/internal/*` 轉發路徑，帶 `x-internal-request: true` 可跳過擁有權檢查，供 ai-service 呼叫）

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
- AI 生成狀態（持久化，取代舊版記憶體 Map）：`generationStatus?`（`generating`/`completed`/`failed`）、`generationError?`、`generationTempUserId?`、`generationUserMessageId?`、`generationAssistantMessageId?`、`generationUpdatedAt?`；`generating` 同時兼作並行生成鎖
- 一對多：`messages`
- 索引：`userId`、`characterId`

### ConversationCreationJob 表
- 主鍵：`userId` + `characterId`（同一用戶對同一角色同時只會有一個建立中的 job）
- `status`（`preparing`/`failed`）、`conversationId?`（已產生、準備寫入的對話 ID）、`error?`、`createdAt`、`updatedAt`
- 追蹤 `getOrCreateConversation` 背景建立流程的狀態，取代舊版記憶體 Map `creationJobs`；聊天室成功寫入 `Conversation` 後這筆 job 記錄會被刪除（DB 有 Conversation 記錄即代表已就緒，不需額外的 `ready` 中繼狀態）

### Message 表
- `id`（cuid）、`conversationId`、`role`（"user"|"assistant"）、`text`
- `status`（預設 "completed"，"pending" 目前未見寫入路徑實際使用 pending 值）
- `summarized`（是否已被摘要覆蓋）、`summaryId?`（涵蓋此訊息的摘要 ID = Qdrant point id）
- `createdAt`、`updatedAt`
- 多對一：`conversation`（`onDelete: Cascade`）
- 索引：`conversationId`、`createdAt`

## 認證流程

1. 前端發送請求 → api-gateway (port 8000) 驗證 JWT → 注入 `x-user-id` header → 轉發 chat-service
2. chat-service 信任 `x-user-id` header，不驗證 JWT；沒有獨立的授權 middleware（`authMiddleware.js` 已刪除），唯一的檢查是 service 層內的 `validateUserId()`（缺 `x-user-id` 拋 `UNAUTHORIZED` → 401）
3. gateway 另有 `/internal/conversations` 與 `/internal/conversations/:id/messages` 路由，供 ai-service 等內部服務呼叫；這類請求帶 `x-internal-request: true` header，`assertConversationOwnership()` 見到此旗標會跳過 userId 擁有權比對
4. chat-service 呼叫 ai-service / character-service 一律經 gateway 的 `/internal/*` 路由（`serviceClient.js`），必要時把 `x-user-id` 一併轉傳

## 演進歷史（節錄自 git log）

依時間序：初始 CRUD → 服務間通訊（呼叫 character-service）→ RAG 整合生成 → 非同步 AI 回覆 + 前端輪詢 → 重啟對話最佳化 → 防止 `error.message` 外洩前端 → AI 生成狀態內存追蹤 + 刪除順序修正 + 摘要被動拋錯 → 訊息回溯刪除 + 摘要配對機制 + 主角人設 + 並行生成鎖 → 移除專用重啟管線 → 摘要機制重構 + 延長 AI timeout → 修正跨帳號授權漏洞 → 依《後端系統設計原則》稽核後以 change `simplify-chat-service` 清理（ERROR_MAP 查表化、刪除死代碼、移除多餘 CORS、統一 sendMessage 錯誤碼，2026-07-25）→ 依《微服務架構準則/實作spec》平台級稽核後修正（合併授權邏輯、刪除 `authMiddleware.js`、新增 `x-internal-request` 內部路由支援、`creationJobs`/`aiGenerationStatus` 記憶體 Map 全面改為 Prisma 持久化，commit `b509562`，2026-07-25～26，含重啟服務實測驗證）

## 現況補充

- 有 git（`main` branch，已與 origin 同步），**與先前文件「沒有 git」的紀錄不符——已更正**
- 沒有測試框架整合（`package.json` 已移除斷掉的 `test` script），驗證僅靠 `test.http` 手動整合測試（2026-07-25 驗證：健康檢查、缺 header、角色不存在、`sendMessage`/`sendMessageToConversation` 對話不存在時皆回 404、缺欄位、job 未找到、依角色刪除對話找不到角色等情境皆通過）
- 沒有 lint 設定檔
- **2026-07-27**：`src/config/config.json`、`src/config/config.txt`、`src/repositories/conversationRepository.js`、`src/services/conversationService.js` 有本機未 commit 的改動（持久化開關功能，見上方「目前狀態」）。`config.json` 目前兩個新旗標皆為 `false`（本機測試設定）——commit 前記得確認要不要改回 `true`，或排除該行不進 commit。
