# conversations Specification

> 本檔是 chat-service **當前實際行為**的規格（as-is），逐條對照原始碼撰寫，不做美化、不寫理想版。
> 已納入 change `simplify-chat-service` 的優化結果（錯誤碼改 `ERROR_MAP` 查表、移除多餘 CORS、
> 清除死代碼 `app.js.backup`/`prisma.config.ts`、移除斷掉的 `test` script、移除死欄位 `req.userId`、
> 統一 `sendMessage` 對話不存在時的回應為 404）。
>
> **後續更新（commit `b509562`，2026-07-25～26）**：依平台級《微服務架構準則/實作spec》稽核後再
> 修正，本檔已同步反映：(1) `authMiddleware.js` 已整檔刪除，改由 service 層 `validateUserId()`
> 把關授權；(2) `creationJobs`／`aiGenerationStatus` 進程內記憶體 Map 已全面改為 Prisma 持久化
> （`ConversationCreationJob` 表、`Conversation` 表的 `generationStatus` 等欄位），2026-07-26 已
> 透過實際重啟服務驗證（K1-K5）狀態存活；(3) `assertConversationOwnership` 新增 `isInternalRequest`
> 旗標，gateway `/internal/conversations*` 轉發的內部請求（`x-internal-request: true`）跳過擁有權
> 比對；(4) 無內容操作類回應統一為 `{ success:true, message }`（不再是 `{status:"success"/"cleared"}`）。
> 最後對照時間：2026-07-26，與 `src/` 現況一致（含 commit `01baf9e` 的跨帳號授權修正）。

## Purpose

chat-service 是 Persona Nexus 平台的**聊天訊息服務**，負責存儲用戶與 AI 角色的對話記錄，
並協調 RAG 記憶（角色背景/few-shot/歷史摘要）與非同步 AI 回覆生成的完整生命週期。
本服務**有自己的資料庫**（SQLite，Prisma + `@prisma/adapter-libsql`），對話與訊息資料的唯一真相在此服務。

### 當前架構圖（as-is）

```
瀏覽器                          ai-service（經 gateway，內部呼叫）
  │                                          │
  ▼                                          ▼
api-gateway :8000 ── /api/v1/conversations/* ──┐  ── /internal/conversations/* ──┐
                                                ▼ (proxy)                        ▼ (x-internal-request: true)
                                              chat-service :6000
                                                      │
   ┌──────────────────────────────────────────────────┴───────────────────────────────────────┐
   │  src/app.js                                                                                │
   │   • express.json() 解析 body（無 CORS 中介層、無獨立授權 middleware——                     │
   │     authMiddleware.js 已整檔刪除；同一批路由同時服務外部與內部請求）                       │
   │   • 21 條路由 → controller 對應方法（見下方 API 一覽）                                     │
   │   • PORT = process.env.PORT || 6000                                                        │
   └──────────────────────────────────────────────────┬───────────────────────────────────────┘
                                       ▼
   controllers/conversationController.js … HTTP 進出；讀 `x-user-id`/`x-internal-request` header；
                                          共用模組層級 `ERROR_MAP` 查表把固定 status+message 的
                                          錯誤碼轉 HTTP status；帶動態內容的錯誤碼
                                          （AI_GENERATION_IN_PROGRESS、
                                          AI_SERVICE_UNAVAILABLE:/SERVICE_ERROR: 前綴等）
                                          維持個別處理
                                       ▼
   services/conversationService.js … 業務邏輯；`validateUserId()` 做基本授權檢查；
       共用擁有權檢查 assertConversationOwnership(userId, conversationId, {isInternalRequest})
       （以 conversationId 為主鍵的方法都先過這關；isInternalRequest 時跳過 userId 比對）；
       建立中/失敗狀態與 AI 生成中/完成/失敗狀態已改為 Prisma 持久化（見下方資料模型），
       不再是進程內記憶體 Map
                                       ▼
   repositories/conversationRepository.js（conversationRepository + messageRepository +
       conversationCreationJobRepository，純 Prisma CRUD）
                                       ▼
   lib/prisma.js（PrismaClient，無 adapter；唯一生效的 Prisma client 設定）
                                       ▼
                                 SQLite（prisma/dev.db：Conversation + ConversationCreationJob + Message）

   lib/serviceClient.js … 呼叫 ai-service / character-service，一律經 gateway `/internal/*` 路由：
       getCharacter、checkAIServiceHealth（目前呼叫點已註解停用）、initializeRAG、checkRAGStatus、
       cleanupRAG、generateResponse、generateSummary、addSummary、deleteSummaries、updateProtagonistRAG
```

## Requirements

### Requirement: 取得或建立對話（非同步 + 輪詢）
系統 SHALL 提供依 `characterId` 取得對話的端點；若對話已存在直接回傳 `ready`；不存在則啟動背景建立流程
並立即回傳 `preparing`，前端 MUST 輪詢同一端點直到取得 `ready` 或 `failed`。角色存在性 MUST 先向
character-service 驗證（經 `serviceClient.getCharacter`，並傳遞 `userId`）。

背景建立流程（`_prepareAndCreateConversation`）SHALL：先呼叫 ai-service 發起 RAG 初始化，
輪詢其狀態最多 120 秒（每秒一次），成功後才寫入 Conversation（含角色快照欄位）與開場白 Message、
並刪除 `ConversationCreationJob` 記錄（DB 已有 Conversation 記錄即代表就緒，不需額外的 `ready`
中繼狀態）；任一步驟失敗則將 job 記錄的 `status` 更新為 `failed` 並記錄錯誤訊息。

#### Scenario: 對話已存在
- **WHEN** 收到 `GET /api/v1/conversations/character/:characterId`，`x-user-id` 存在，該 `userId`+`characterId`
  已有 Conversation 記錄
- **THEN** 回傳 HTTP 200，body 為 `{ status:"ready", conversationId, messages, title, createdAt, updatedAt }`

#### Scenario: 對話不存在，首次請求
- **WHEN** 對話不存在，且 `ConversationCreationJob` 表無對應記錄
- **THEN** 系統產生 `conv_<timestamp>` id、寫入 `preparing` 狀態的 `ConversationCreationJob` 記錄、
  fire-and-forget 啟動背景建立流程，立即回傳 HTTP 202 與 `{ status:"preparing" }`

#### Scenario: 建立中，前端輪詢
- **WHEN** `ConversationCreationJob` 記錄狀態為 `preparing`
- **THEN** 回傳 HTTP 202 與 `{ status:"preparing" }`（輪詢本身不查詢 RAG 狀態、不寫 DB，
  全交由背景任務處理，避免雙重寫入撞 unique constraint）

#### Scenario: 建立失敗
- **WHEN** `ConversationCreationJob` 記錄狀態為 `failed`
- **THEN** 刪除該 job 記錄（允許之後重新嘗試），回傳 HTTP 503 與 `{ status:"failed", message:<失敗原因> }`

#### Scenario: 未帶 x-user-id
- **WHEN** 缺少 `x-user-id` header
- **THEN** service 層 `validateUserId()` 拋出 `UNAUTHORIZED`，controller 經 `ERROR_MAP` 回傳
  HTTP 401 與 `{ error:"UNAUTHORIZED", message:"Unauthorized" }`（無獨立授權 middleware 攔截）

#### Scenario: characterId 缺失
- **WHEN** `characterId` 為空
- **THEN** service 拋出 `MISSING_CHARACTER_ID`，controller 回傳 HTTP 400

#### Scenario: 角色不存在
- **WHEN** character-service 回報角色不存在
- **THEN** service 拋出 `CHARACTER_NOT_FOUND`，controller 回傳 HTTP 404

#### Scenario: 角色驗證遭拒
- **WHEN** character-service 回報無權限存取該角色
- **THEN** service 拋出 `FORBIDDEN`，controller 回傳 HTTP 403

### Requirement: 重試聊天室建立
系統 SHALL 允許使用者在建立失敗後清除失敗狀態以便重試。

#### Scenario: 成功清除失敗 job
- **WHEN** 收到 `POST /api/v1/conversations/character/:characterId/retry`，該 `userId:characterId` 有
  `ConversationCreationJob` 記錄且狀態為 `failed`
- **THEN** 刪除該 job 記錄，回傳 HTTP 200 與 `{ success:true, message:"..." }`

#### Scenario: 無失敗 job
- **WHEN** 該 `userId:characterId` 無對應 `ConversationCreationJob` 記錄
- **THEN** 回傳 HTTP 404（`NO_FAILED_JOB`）

#### Scenario: job 狀態非 failed
- **WHEN** `ConversationCreationJob` 記錄存在但狀態不是 `failed`（例如仍在 `preparing`）
- **THEN** 回傳 HTTP 409（`JOB_NOT_FAILED`）

### Requirement: 查詢對話列表
系統 SHALL 提供兩種對話列表查詢：完整版（含每個對話最新一則訊息）與輕量摘要版（僅 ID/角色名/更新時間）。

#### Scenario: 取得完整對話列表
- **WHEN** 收到 `GET /api/v1/conversations`
- **THEN** 回傳該 `userId` 全部對話，依 `updatedAt` 降冪排序，每筆含最新一則訊息（`take:1`）

#### Scenario: 取得對話摘要列表
- **WHEN** 收到 `GET /api/v1/conversations/summary`
- **THEN** 回傳 `[{ conversationId, characterId, characterName, updatedAt }]`，依 `updatedAt` 降冪排序，
  不含訊息內容

### Requirement: 查詢訊息
系統 SHALL 支援依 `characterId`（舊方法）或 `conversationId`（新方法）查詢訊息，皆支援 `limit`/`offset` 分頁
（預設 `limit=50, offset=0`），依 `createdAt` 升冪排序。以 `conversationId` 查詢 MUST 驗證擁有權。

#### Scenario: 依 characterId 查詢（舊方法）
- **WHEN** 收到 `GET /api/v1/conversations/character/:characterId/messages`，對應對話存在
- **THEN** 回傳該對話的訊息陣列（分頁後）

#### Scenario: 依 characterId 查詢，對話不存在
- **WHEN** 該 `userId`+`characterId` 無對話
- **THEN** service 拋出 `CONVERSATION_NOT_FOUND`，controller 回傳 HTTP 404

#### Scenario: 依 conversationId 查詢（新方法）
- **WHEN** 收到 `GET /api/v1/conversations/:conversationId/messages`，`conversationId` 存在且屬於呼叫者
- **THEN** 回傳該對話的訊息陣列（分頁後）

#### Scenario: 依 conversationId 查詢，非擁有者
- **WHEN** `conversationId` 存在但 `conversation.userId !== 呼叫者 userId`
- **THEN** service 拋出 `FORBIDDEN`，controller 回傳 HTTP 403
  （修正前此方法完全不驗證 userId，任何登入者可讀取他人對話全部訊息）

#### Scenario: 查詢單一訊息
- **WHEN** 收到 `GET /api/v1/conversations/:conversationId/messages/:messageId`，對話存在、屬於呼叫者、
  訊息存在
- **THEN** 回傳 `{ id, role, text, status, createdAt, updatedAt }`（供前端輪詢 AI 完成狀態使用）

#### Scenario: 查詢單一訊息，訊息不存在
- **WHEN** `messageId` 在該對話中查無記錄
- **THEN** service 拋出 `MESSAGE_NOT_FOUND`，controller 回傳 HTTP 404

### Requirement: 發送訊息（同步版，依 characterId）
系統 SHALL 提供同步發送訊息的端點：直接保存訊息、無 AI 生成、無摘要機制。對話不存在時回傳 HTTP 404，
與 `sendMessageToConversation` 對「對話不存在」的回應風格一致。

#### Scenario: 成功發送
- **WHEN** 收到 `POST /api/v1/conversations/character/:characterId/messages`，body 含合法 `role`
  （`"user"` 或 `"assistant"`）與非空 `text`，對應對話存在
- **THEN** 建立 Message、更新 Conversation 的 `updatedAt`，回傳 HTTP 201 與
  `{ id, role, text, createdAt }`

#### Scenario: 缺少必要欄位
- **WHEN** `text` 為空，或 `role` 缺失/不是 `"user"`/`"assistant"`
- **THEN** service 拋出 `MISSING_TEXT` 或 `INVALID_ROLE`，controller 回傳 HTTP 400

#### Scenario: 對話不存在
- **WHEN** 該 `userId`+`characterId` 無對話
- **THEN** service 拋出 `CONVERSATION_NOT_FOUND`，controller 回傳 HTTP 404 與
  `{ message: "Conversation not found" }`（`simplify-chat-service` 之前為 HTTP 400，見
  `changes/simplify-chat-service` 的 MODIFIED delta）

### Requirement: 發送訊息（非同步版，依 conversationId，含 AI 生成）
系統 SHALL 提供非同步發送訊息的端點：立即回應「已接受」，背景生成 AI 回覆並在成功時原子性保存
用戶訊息與 AI 回覆；失敗時兩者皆不持久化。同一對話同時只能有一個生成任務進行中。

發送前 MUST 先驗證對話擁有權（早於輸入驗證，避免用 400/403 的差異洩漏對話是否存在的資訊）。

#### Scenario: 成功接受並背景生成
- **WHEN** 收到 `POST /api/v1/conversations/:conversationId/messages`，擁有權驗證通過，`text` 非空，
  該對話目前無生成中任務
- **THEN** 立即上鎖（Conversation 的 `generationStatus` 欄位原子性更新為 `generating`，
  `updateMany` 的 `where` 條件兼作「檢查後更新」，取代原本 in-memory Map 的單執行緒同步區塊），
  回傳 HTTP 201 與 `{ status:"accepted", message:"Message received, AI generation in progress" }`；
  背景任務組裝 AI 請求（含角色快照、未摘要訊息歷史、主角人設）並呼叫 ai-service

#### Scenario: 背景生成成功
- **WHEN** 背景任務取得 AI 回覆
- **THEN** 原子性依序建立用戶訊息與 AI 訊息（皆為新記錄），Conversation 的 `generationStatus` 等
  欄位更新為 `{ generationStatus:"completed", generationTempUserId, generationUserMessageId,
  generationAssistantMessageId, generationUpdatedAt }`，供前端輪詢配對真實 ID（此狀態持久化在 DB，
  服務重啟不遺失）

#### Scenario: 背景生成失敗
- **WHEN** 呼叫 ai-service 失敗（逾時、服務不可用等）
- **THEN** 用戶訊息與 AI 訊息皆不寫入 DB，Conversation 的 `generationStatus` 更新為 `failed`
  並記錄 `generationError`、`generationUpdatedAt`

#### Scenario: 並行生成防護
- **WHEN** 該對話的 `generationStatus` 為 `generating` 且鎖齡（`Date.now() - generationUpdatedAt`）
  小於逾時上限（`config.ai.timeouts.generateResponse + 30000` 毫秒）
- **THEN** service 拋出 `AI_GENERATION_IN_PROGRESS`，controller 回傳 HTTP 409

#### Scenario: 殭屍鎖逾時放行
- **WHEN** 該對話的 `generationStatus` 為 `generating` 但 `generationUpdatedAt` 鎖齡已超過逾時上限
- **THEN** 視為失效鎖，`updateMany` 的 `where` 條件涵蓋此情形而放行新請求（新鎖覆寫舊鎖）

#### Scenario: 摘要機制觸發
- **WHEN** 該對話未摘要訊息（排除最新 `shortTermLimit` 條後）總字數達 `config.summary.threshold`
- **THEN** 背景任務先執行摘要（呼叫 ai-service 生成摘要文本、存入向量資料庫取得 `summaryId`、
  標記候選訊息 `summarized=true` 並記錄 `summaryId`），再重新查詢未摘要訊息用於組裝 AI 請求

#### Scenario: 對話不存在或非擁有者
- **WHEN** `conversationId` 不存在，或存在但不屬於呼叫者
- **THEN** 分別拋出 `CONVERSATION_NOT_FOUND`（404）或 `FORBIDDEN`（403）

#### Scenario: 缺少必要欄位
- **WHEN** `conversationId` 缺失或 `text` 為空
- **THEN** 拋出 `MISSING_CONVERSATION_ID` 或 `MISSING_TEXT`，controller 回傳 HTTP 400

### Requirement: AI 生成狀態查詢與清除
系統 SHALL 允許前端查詢與清除某對話的 AI 生成狀態（用於輪詢完成/失敗，以及使用者手動重試）。
兩者皆 MUST 先驗證對話擁有權。

#### Scenario: 查詢生成狀態
- **WHEN** 收到 `GET /api/v1/conversations/:conversationId/ai-generation-status`，擁有權驗證通過
- **THEN** 若 Conversation 的 `generationStatus` 欄位有值則回傳
  `{ status, error?, tempUserId?, userMessageId?, assistantMessageId?, timestamp? }`；
  否則回傳 `{ status:"unknown", message:"No generation status record" }`
  （`status` 為業務語意欄位，非本檔錯誤格式的 error/message 包裹）

#### Scenario: 清除生成狀態
- **WHEN** 收到 `DELETE /api/v1/conversations/:conversationId/ai-generation-status`，擁有權驗證通過
- **THEN** 清除 Conversation 的 `generationStatus` 等欄位（設回 `null`），回傳 HTTP 200 與
  `{ success:true, message:"AI generation status cleared" }`

#### Scenario: 非擁有者查詢或清除
- **WHEN** `conversationId` 存在但不屬於呼叫者
- **THEN** 拋出 `FORBIDDEN`，controller 回傳 HTTP 403
  （修正前此二方法完全不驗證 userId，任何登入者可查詢/清除他人對話的生成狀態）

### Requirement: 回溯式刪除訊息
系統 SHALL 允許使用者刪除自己發出的某則訊息，並連帶刪除該訊息之後的所有訊息（不論角色）。
刪除範圍若涉及已摘要訊息，MUST 連動刪除對應的向量資料庫摘要，並將刪除點之前、被同一摘要涵蓋的
訊息標回未摘要狀態。AI 生成中時 MUST 拒絕刪除。

#### Scenario: 成功刪除
- **WHEN** 收到 `DELETE /api/v1/conversations/:conversationId/messages/:messageId`，擁有權驗證通過，
  該對話目前無生成中任務，`messageId` 存在、屬於該對話、且 `role==="user"`
- **THEN** 依 `createdAt` 排序找出目標訊息位置，刪除該訊息與其後全部訊息；若刪除範圍內有訊息帶
  `summaryId`，先呼叫 ai-service 刪除對應 Qdrant 摘要（失敗則拋錯中止、DB 不動），成功後將刪除點前
  被同一 `summaryId` 涵蓋的訊息標回 `summarized:false, summaryId:null`；最後刪除 DB 訊息記錄，
  清除該對話的 `generationStatus` 等欄位；回傳 HTTP 200 與
  `{ success:true, message:"<N> 則訊息已刪除", deletedCount, deletedIds }`

#### Scenario: 生成中拒絕刪除
- **WHEN** 該對話 `generationStatus` 為 `generating`
- **THEN** 拋出 `AI_GENERATION_IN_PROGRESS`，controller 回傳 HTTP 409

#### Scenario: 缺少參數
- **WHEN** `conversationId` 或 `messageId` 缺失
- **THEN** 拋出 `MISSING_PARAMS`，controller 回傳 HTTP 400
  （此檢查 MUST 先於擁有權檢查，否則 `messageId` 缺失會被誤判為 `MESSAGE_NOT_FOUND`）

#### Scenario: 訊息不存在
- **WHEN** `messageId` 在該對話中查無記錄
- **THEN** 拋出 `MESSAGE_NOT_FOUND`，controller 回傳 HTTP 404

#### Scenario: 嘗試刪除非用戶訊息
- **WHEN** 目標訊息 `role !== "user"`
- **THEN** 拋出 `NOT_USER_MESSAGE`，controller 回傳 HTTP 400 與「只能刪除自己發出的訊息」

### Requirement: 刪除對話
系統 SHALL 允許刪除單一對話，或刪除使用者與某角色的所有對話。刪除 MUST 先清理該對話在向量資料庫的
RAG 資料，成功後才刪除 DB 記錄（訊息因 `onDelete: Cascade` 自動一併刪除）；RAG 清理失敗 MUST 中止刪除、
DB 保持完好。

#### Scenario: 刪除單一對話成功
- **WHEN** 收到 `DELETE /api/v1/conversations/:conversationId`，擁有權驗證通過，RAG 清理成功
- **THEN** 刪除該 Conversation（級聯刪除 Message，`generationStatus` 等欄位隨整筆記錄一併刪除），
  回傳 HTTP 200 與 `{ success:true, message:"Conversation deleted successfully" }`

#### Scenario: RAG 清理失敗
- **WHEN** 呼叫 ai-service 清理 RAG 失敗
- **THEN** 拋出 `SERVICE_ERROR: <detail>`，controller 回傳 HTTP 503，DB 對話記錄未被刪除

#### Scenario: 刪除角色的所有對話成功
- **WHEN** 收到 `DELETE /api/v1/conversations/character/:characterId`，角色驗證通過，該
  `userId`+`characterId` 至少有一筆對話
- **THEN** 依序清理每個對話的 RAG 資料（任一失敗即中止，之前已清理的不回復），全部成功後才批次刪除
  DB 對話記錄（`generationStatus` 等欄位隨每筆記錄一併刪除），回傳 HTTP 200 與
  `{ success:true, message:"...", deletedCount }`

#### Scenario: 無對話可刪
- **WHEN** 該 `userId`+`characterId` 無任何對話
- **THEN** 拋出 `NO_CONVERSATIONS_FOUND`，controller 回傳 HTTP 404

### Requirement: 主角人設（讀取/更新）
系統 SHALL 允許使用者為每個聊天室設定「主角」（使用者扮演的人設）的名稱與背景，預設為空、不強制填寫。
更新 MUST 先更新 RAG（向量資料庫的主角背景切片），成功後才寫入 DB。

#### Scenario: 讀取主角人設
- **WHEN** 收到 `GET /api/v1/conversations/:conversationId/protagonist`，擁有權驗證通過
- **THEN** 回傳 `{ protagonistName, protagonistBackground }`（未設定為 `null`）

#### Scenario: 更新主角人設成功
- **WHEN** 收到 `PUT /api/v1/conversations/:conversationId/protagonist`，擁有權驗證通過
- **THEN** 先呼叫 ai-service 更新 RAG 主角背景切片（成功），才寫入 Conversation 的
  `protagonistName`/`protagonistBackground`（空字串正規化為 `null`），回傳 HTTP 200 與
  `{ protagonistName, protagonistBackground }`（直接回傳資源物件，無額外包裹）

#### Scenario: RAG 更新失敗
- **WHEN** 呼叫 ai-service 更新 RAG 失敗
- **THEN** 拋出 `SERVICE_ERROR: <detail>`，controller 回傳 HTTP 503，DB 主角欄位未被修改

### Requirement: 認證與服務間通信
系統 SHALL 信任 gateway 注入的 `x-user-id` header，不自行驗證 JWT，且沒有獨立的授權 middleware
（`authMiddleware.js` 已刪除）——授權檢查下沉到 service 層的 `validateUserId()`。系統呼叫 ai-service 或
character-service 一律 MUST 經 gateway 的 `/internal/*` 路由，不直連對方服務。

#### Scenario: 缺少認證 header
- **WHEN** 任一受保護端點收到請求但無 `x-user-id` header，且非內部請求（`x-internal-request` 不為 `true`）
- **THEN** service 層 `validateUserId()` 拋出 `UNAUTHORIZED`，controller 經 `ERROR_MAP` 回傳 HTTP 401
  與 `{ error:"UNAUTHORIZED", message:"Unauthorized" }`

#### Scenario: 內部請求跳過擁有權檢查
- **WHEN** gateway 的 `/internal/conversations` 或 `/internal/conversations/:id/messages` 路由轉發請求，
  帶 `x-internal-request: true`（供 ai-service 呼叫）
- **THEN** `assertConversationOwnership(userId, conversationId, { isInternalRequest: true })` 跳過
  `validateUserId()` 與 `conversation.userId !== userId` 的比對，只驗證該 `conversationId` 是否存在

#### Scenario: 服務間呼叫路徑
- **WHEN** chat-service 需要驗證角色、初始化/清理/查詢 RAG、生成回覆或摘要
- **THEN** 一律呼叫 `${GATEWAY_URL}/internal/...`（`serviceClient.js`），而非直接呼叫 ai-service 或
  character-service 的實際 port

### Requirement: 跨帳號擁有權檢查
以 `conversationId` 為主鍵存取資料的方法 SHALL 先呼叫共用的 `assertConversationOwnership()` 驗證
該對話存在且屬於呼叫者，才可繼續操作。

#### Scenario: 集中檢查涵蓋的方法
- **WHEN** 呼叫 `sendMessageToConversation`、`getMessagesByConversationId`、`deleteConversation`、
  `getProtagonist`、`updateProtagonist`、`deleteMessageAndSubsequent`、`getMessageById`、
  `getAIGenerationStatus`、`clearAIGenerationStatus` 任一方法
- **THEN** 皆先呼叫 `assertConversationOwnership(userId, conversationId)`，對話不存在拋
  `CONVERSATION_NOT_FOUND`（404），存在但非本人拋 `FORBIDDEN`（403）
