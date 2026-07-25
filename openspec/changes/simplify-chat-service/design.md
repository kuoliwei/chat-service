# Design — simplify-chat-service

> 記錄本次優化**改動後**的結構。只描述變更點，不重述未動的部分。

## 錯誤碼映射（controller）：改用共用 ERROR_MAP

原本 20 支方法各自用一串 `if (error.message === 'XXX')` 比對後回應。改為模組層級單一 `ERROR_MAP`：

```
變更前                                                  變更後
─────────                                               ─────────
20 支方法各自 if/else 判斷 error.message          →      ERROR_MAP 查表（模組層級，全體共用）
```

```js
const ERROR_MAP = {
  UNAUTHORIZED:               { status: 401, message: 'Unauthorized' },
  MISSING_CHARACTER_ID:       { status: 400, message: 'Missing characterId' },
  MISSING_CONVERSATION_ID:    { status: 400, message: 'Missing conversationId' },
  MISSING_PARAMS:             { status: 400, message: 'Missing conversationId or messageId' },
  MISSING_TEXT:                { status: 400, message: 'Invalid request' },
  INVALID_ROLE:                { status: 400, message: 'Invalid request' },
  CHARACTER_NOT_FOUND:         { status: 404, message: 'Character not found' },
  CONVERSATION_NOT_FOUND:      { status: 404, message: 'Conversation not found' },
  MESSAGE_NOT_FOUND:           { status: 404, message: 'Message not found' },
  FORBIDDEN:                   { status: 403, message: 'Access denied' },
  NOT_USER_MESSAGE:            { status: 400, message: '只能刪除自己發出的訊息' },
  AI_GENERATION_IN_PROGRESS:   { status: 409, message: '...視端點而定，見下方例外' },
  NO_FAILED_JOB:                { status: 404, message: 'No failed job found for this character' },
  JOB_NOT_FAILED:               { status: 409, message: 'Job is not in failed state' },
};
```

部分錯誤碼在不同端點下訊息或附帶欄位不同（例如 `AI_GENERATION_IN_PROGRESS` 在
`sendMessageToConversation` 是「上一條訊息仍在處理中…」、在 `deleteMessageAndSubsequent` 是
「AI 正在回覆中…」；`AI_SERVICE_UNAVAILABLE:`/`SERVICE_ERROR:` 前綴錯誤需要動態組出 message），
這類**帶動態內容或依端點語意不同的錯誤碼**維持原本個別處理，不勉強塞入單一靜態查表——
`ERROR_MAP` 只收斂「結果單純為固定 status + 固定 message」的錯誤碼，其餘沿用現有的個別判斷式，
但一律採用 `respondWithError()` 風格的統一 catch 結構降低重複。

## sendMessage 的 CONVERSATION_NOT_FOUND 對應碼統一

```
變更前                                             變更後
─────────                                          ─────────
sendMessage:              CONVERSATION_NOT_FOUND → 400   CONVERSATION_NOT_FOUND → 404（與 ERROR_MAP 一致）
sendMessageToConversation: CONVERSATION_NOT_FOUND → 404   （不變）
```

這是本次**唯一的可觀察行為變更**：呼叫 `POST /api/v1/conversations/character/:characterId/messages`
且對話不存在時，回應狀態碼從 400 改為 404。訊息文字同步簡化為與 `sendMessageToConversation`
一致的 `"Conversation not found"`（原本是 `"Conversation not found. Please GET ... first."`）。

## 死代碼移除

- 刪除 `src/app.js.backup`：舊版 Express app 進入點，`src/app.js` 已完全取代，無檔案 import 它。
- 刪除 `prisma.config.ts`：定義了一份 `@prisma/adapter-libsql` 版 PrismaClient，但已查證 Prisma
  5.22（本專案安裝版本）CLI 完全不讀取此檔案，執行期無任何作用；`src/lib/prisma.js`
  （無 adapter 版）才是實際生效的 Prisma client，維持不動。

## CORS 移除

刪除 `app.js` 的 `import cors` 與 `app.use(cors())`。chat-service 目前無啟用中的瀏覽器直連路徑
（已 grep 前端 `persona-nexus-chat` 確認，見 proposal.md），移除後對 gateway 轉發的請求零影響。

## 移除斷掉的 test script

`package.json` 的 `"test": "jest"` 因 jest 從未安裝且無任何 `*.test.js` 而必定執行失敗，移除該
script。不新增測試框架（本輪範圍之外）。

## 移除死欄位 req.userId

`authMiddleware.js` 移除 `req.userId = userId` 這行寫入；`userId` header 的存在性檢查
（`if (!userId) return res.status(401)...`）維持不變。
