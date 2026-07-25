# Design — conversations-foundation

> 忠實記錄 chat-service **當前的設計結構**。行為（做什麼）在 main spec，本文記錄**結構與決策（怎麼組成的）**。
> 只描述現況，不寫理由、不做評判。

## 三層架構 + 內存狀態（Controller → Service → Repository）

請求依序經過三層：
- `controllers/conversationController.js`：處理 HTTP——讀 body/params/query、設定 status、組回應、
  以各方法各自的 if/else 把 service 拋出的語意錯誤碼映射成 HTTP code（**無共用 ERROR_MAP**，
  20 支方法各自一份判斷式）。散布大量 `console.log`（含 `🐛 [DEBUG]` 前綴）。
- `services/conversationService.js`：業務邏輯，同時持有兩個模組級（module-level）內存 `Map`：
  - `creationJobs`：key 為 `` `${userId}:${characterId}` ``，value 為
    `{ status: 'preparing'|'ready'|'failed', conversationId?, error? }`，追蹤聊天室建立中狀態。
  - `aiGenerationStatus`：key 為 `conversationId`，value 為
    `{ status: 'generating'|'completed'|'failed', error?, tempUserId?, userMessageId?, assistantMessageId?, timestamp }`，
    兼作 AI 生成的並行鎖與前端輪詢資料來源。
  - 共用函式 `assertConversationOwnership(userId, conversationId)`：以 conversationId 為主鍵的方法
    一律先呼叫此函式驗證存在性與擁有權，取代原本各方法各自手刻的驗證（見「歷史修正」一節）。
- `repositories/conversationRepository.js`：匯出兩個物件——`conversationRepository`（Conversation 的
  findFirst/findMany/create/update/delete/deleteByCharacterId）與 `messageRepository`（Message 的
  findMany/findFirst/findUnsummarized/create/update/delete/deleteManyByIds），皆為純 Prisma 呼叫。

## 資料儲存

chat-service 有自己的資料庫（SQLite，`prisma/dev.db`），透過 `lib/prisma.js` 建立的
`new PrismaClient()`（**不帶 adapter**）存取，`DATABASE_URL` 走環境變數。

`Conversation` model：`id`（cuid）、`userId`、`characterId`、`title?`、`createdAt`、`updatedAt`，
外加建立時保存的角色快照欄位（`characterName`/`characterGender`/`characterTags`/`characterIntroduction`/
`characterBackground`/`characterOpening`/`characterFewShots`，後兩個為 JSON 字串）與主角人設欄位
（`protagonistName?`/`protagonistBackground?`）；索引 `userId`、`characterId`。

`Message` model：`id`（cuid）、`conversationId`、`role`、`text`、`status`（預設 `"completed"`）、
`summarized`（預設 `false`）、`summaryId?`；索引 `conversationId`、`createdAt`；`onDelete: Cascade`
關聯到 Conversation。

專案根目錄另有 `prisma.config.ts`，定義了一個使用 `@prisma/adapter-libsql` 的獨立 `PrismaClient`
實例，但專案內沒有任何檔案 import 它——執行期實際生效的是 `src/lib/prisma.js`。

## 非同步建立聊天室的狀態機

`getOrCreateConversation` 不是單次請求-回應，而是「查詢 → 若無則啟動背景任務 → 前端輪詢同一端點」
的狀態機：

1. 查 DB 是否已有 Conversation → 有則直接回 `ready`（此為狀態機的終態，之後不再進入 job 邏輯）。
2. 無 Conversation → 查 `creationJobs` 這個 in-memory Map：
   - 無 job → 建立角色驗證（呼叫 character-service）成功後，寫入 `preparing` 狀態的 job，
     fire-and-forget 呼叫 `_prepareAndCreateConversation()`（不 await），回 `preparing`。
   - job 為 `preparing` → 直接回 `preparing`（輪詢本身不做任何 RAG 查詢或 DB 寫入，
     避免與背景任務對同一資源雙重寫入）。
   - job 為 `failed` → 清除該 job（讓下次請求視為「無 job」重新開始），回 `failed` 並帶錯誤訊息。
3. `_prepareAndCreateConversation()`（背景執行，與呼叫端的 request-response 週期無關）：
   呼叫 ai-service 發起 RAG 初始化 → 輪詢 RAG 狀態（每秒一次，最多 120 次）→ 成功後寫入
   Conversation（含角色快照）與開場白 Message → 標記 job 為 `ready`；任何一步失敗則標記 job 為
   `failed` 並記下錯誤訊息，不拋出到呼叫端（因為此函式本身沒有呼叫端在等待）。

曾經存在的「不含 RAG 初始化的建立函數」與「重啟聊天室」專用端點/service 方法已被移除
（`app.js` 中以註解記錄移除事實）；前端改為複用「刪除 + 建立」既有管線達成重啟效果。

## 非同步發送訊息與 AI 生成的狀態機

`sendMessageToConversation` 同樣不即時完成，而是「立即回應 accepted → 背景生成 → 前端輪詢生成狀態」：

1. 擁有權驗證（早於欄位驗證，理由見 main spec）。
2. 檢查 `aiGenerationStatus`：若已是 `generating` 且鎖齡未超過逾時上限
   （`config.ai.timeouts.generateResponse + 30000` 毫秒），拋 `AI_GENERATION_IN_PROGRESS`；
   若已是 `generating` 但鎖齡超過上限，視為殭屍鎖、記警告後放行（新鎖覆寫舊鎖）。
   這段「檢查 + 上鎖」在同一個同步區塊完成、中間無 `await`，靠 Node 單執行緒特性避免競態。
3. 撈出未摘要訊息，若達摘要閾值（`checkIfNeedsSummary()`）則先執行摘要（`executeSummary()`：
   呼叫 ai-service 生成摘要文本 → 存入向量資料庫取得 `summaryId` → 逐筆標記候選訊息
   `summarized=true, summaryId=<id>`），再重新查詢未摘要訊息。
4. 立即回應 `{ status: "accepted", ... }`，不 await 呼叫 `_generateAIResponseAsync()`（fire-and-forget）。
5. `_generateAIResponseAsync()`：組裝 AI 請求（角色快照 + 未摘要訊息 + 新訊息 + 主角人設）→
   呼叫 ai-service 生成回覆 → 成功則**依序**（先用戶訊息、後 AI 訊息）建立兩筆 Message，
   標記 `aiGenerationStatus` 為 `completed`（含 `tempUserId`/`userMessageId`/`assistantMessageId`
   供前端替換樂觀更新的臨時訊息）；失敗則兩筆訊息都不寫入，標記為 `failed`。

`sendMessage`（依 characterId 的舊端點）走另一條完全同步、不含 AI 生成、不含摘要邏輯的路徑，
直接呼叫 `messageRepository.create()`。

## 記憶（摘要）機制

`checkIfNeedsSummary(messages, threshold, shortTermLimit)`：
- `threshold`、`shortTermLimit` 預設讀自 `config.summary`（`config.json`）。
- 若未摘要訊息數 ≤ `shortTermLimit`，不觸發。
- 否則排除最新 `shortTermLimit` 條，計算其餘（候選）訊息的字數總和，達 `threshold` 才觸發。

`executeSummary()` 產出的 `summaryId` 即 ai-service/Qdrant 那端的 point id，寫回每筆被摘要訊息的
`summaryId` 欄位——這個配對關係是後續「回溯刪除訊息時需連動刪除摘要」的依據。

## 回溯刪除訊息與記憶清理的連動

`deleteMessageAndSubsequent()`：
1. 依 `createdAt` 排序找出目標訊息（必須是 `role==='user'`）的位置，該位置（含）之後全部訊息
   即刪除範圍。
2. 收集刪除範圍內出現過的 `summaryId`（去重、排除 `null`）。若有：
   - 找出「刪除點之前」但被同一批 `summaryId` 涵蓋的訊息（這些訊息的摘要即將被刪，需要標回
     未摘要，否則它們的內容會從模型記憶中徹底消失）。
   - **先**呼叫 ai-service 刪除這些 Qdrant 摘要（失敗即拋錯中止，DB 尚未變動）。
   - 成功後把「刪除點之前」的那批訊息標回 `summarized:false, summaryId:null`。
3. 批次刪除 DB 中刪除範圍內的訊息記錄，清除該對話的 `aiGenerationStatus`。

若目標對話當前 `aiGenerationStatus` 為 `generating`，直接拒絕（`AI_GENERATION_IN_PROGRESS`），
避免刪除與背景生成同時寫入同一份訊息集合而互相打架。

## 刪除對話與主角人設更新的一致性順序

刪除對話（單一或依角色批次）與更新主角人設，皆採「先呼叫外部服務（RAG 清理/更新）、
成功才動 DB」的順序——任何一步外部呼叫失敗就拋錯中止，確保不會出現「DB 已改但 RAG 沒改」或
反過來「RAG 已清但 DB 還留著孤兒資料」的不一致狀態。

## 授權模型

Controller 直接從 `req.headers['x-user-id']` 讀取請求者身份，不做任何驗證（信任 gateway 已驗證
JWT 並正確注入）。`authMiddleware.js` 額外把 `userId` 寫入 `req.userId`，但目前沒有任何 controller
方法讀取這個欄位——全部方法都直接重新讀 `req.headers['x-user-id']`。

以 `conversationId` 為主鍵的方法（`sendMessageToConversation`、`getMessagesByConversationId`、
`deleteConversation`、`getProtagonist`、`updateProtagonist`、`deleteMessageAndSubsequent`、
`getMessageById`、`getAIGenerationStatus`、`clearAIGenerationStatus`）全部先呼叫
`assertConversationOwnership()`；以 `characterId` 為主鍵的方法（如 `getMessages`）擁有權檢查
內建在 Prisma 查詢條件（`findFirst({ userId, characterId })`）本身。

## 歷史修正（已完成，非本輪待辦）

commit `01baf9e` 修正了 `getMessagesByConversationId`、`getMessageById`、`getAIGenerationStatus`、
`clearAIGenerationStatus` 四個方法過去完全不驗證 `userId` 的漏洞（任何登入者帶任意
`conversationId` 都能讀取/清除他人對話資料），做法是抽出共用的 `assertConversationOwnership()`
函式，讓之後任何新方法都只有一種寫法可用。

## 現存但無效或存疑的模組

- `src/app.js.backup`：舊版 Express app 進入點（含手刻的 `requireUserId` middleware、
  舊版路由邏輯，例如 `POST /conversations/character/:characterId/messages` 沒有 AI 生成也沒有摘要
  機制），沒有任何檔案 import 它，是否為死代碼待稽核判斷。
- `authMiddleware.js` 寫入的 `req.userId` 無人讀取。
- `src/config/config.txt`：`config.json` 的說明文件（純文字，非程式碼），內容包含已於文件內
  自陳「chat-service 未使用」的 `rag.topK`/`rag.threshold` 欄位。
- `prisma.config.ts`：定義了一個 libsql adapter 版 PrismaClient，但無人 import，與 `lib/prisma.js`
  的關係（是否為 Prisma CLI 慣例載入的設定檔）待釐清。

## 其他現況

- `PORT`（預設 6000）、`DATABASE_URL`、`GATEWAY_URL`（預設 `http://localhost:8000`）皆讀環境變數，
  `.env`/`.env.example` 內容一致。
- CORS 於 `app.js` 使用 `cors()`（無參數，允許所有 origin）。
- 測試：無任何測試框架整合，`package.json` 的 `"test": "jest"` 無法執行（jest 未安裝），
  沒有 `*.test.js` 檔案。`test.http` 有 12 個手動情境涵蓋主要成功/失敗路徑，但內容仍引用已被
  取代的「發送訊息」流程說明（標示為「AI 佔位訊息」，與現行「原子性保存」機制不符），需在
  Phase 9 測試前更新。
- 有 git（已設定 origin 遠端，`main` branch 與 origin 同步），12 筆提交記錄了從初始 CRUD 到
  RAG 整合、非同步生成、回溯刪除、跨帳號授權修正的完整演進。
