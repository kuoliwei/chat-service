## Why

依《後端系統設計原則》稽核（見 `chat-service/mistake.md`）確認 chat-service 有數處不符，
使用者已逐項核對確認處理範圍（2026-07-25）：

1. **DRY + SOLID-OCP + 高內聚低耦合**：`conversationController.js` 20 支方法各自寫一串
   `if (error.message === 'XXX')` 判斷式映射 HTTP status，無共用查表；auth-service/user-service/
   character-service 三個服務都已改用共用 `ERROR_MAP`，本服務尚未跟進。
2. **YAGNI（死代碼）**：`src/app.js.backup` 是舊版 Express app 進入點，已被 `src/app.js` 完全取代，
   無任何檔案 import 它。
3. **契約一致性**：`sendMessage`（依 characterId 的舊同步端點）與 `sendMessageToConversation`
   （依 conversationId 的新非同步端點）在「對話不存在」時分別回 400 / 404，語意上應一致。
4. **SSOT（死代碼，已查證）**：`prisma.config.ts` 定義了一份 libsql adapter 版 PrismaClient，
   但已確認 Prisma 5.22（本專案安裝版本）的 CLI 完全不讀取此檔案（`prisma.config.ts` 支援是
   Prisma 6.x 才引入的功能），執行期實際生效的只有 `src/lib/prisma.js`；本服務並未升級到
   支援此檔案的 Prisma 版本，此檔案在目前狀態下純粹是死代碼。
5. **多餘設定**：`cors()` 允許所有 origin，但已 grep 前端 `persona-nexus-chat` 確認全部請求皆走
   相對路徑 `/api/...`（經 gateway），無啟用中的瀏覽器直連 :6000 路徑。
6. **契約完整性**：`package.json` 的 `"test": "jest"` script 指向未安裝的套件（jest 不在
   dependencies/devDependencies，`node_modules` 無 jest），且專案內無任何 `*.test.js`，執行必定失敗。
7. **死欄位**：`authMiddleware.js` 寫入 `req.userId`，但現行 controller 全部直接讀
   `req.headers['x-user-id']`，`req.userId` 無人使用。

以下項目經使用者確認**不在本輪範圍**：
- **SoC（除錯 console.log）**：本輪不處理，暫緩。
- **12-Factor VI（無狀態 Map：`creationJobs`/`aiGenerationStatus`）**：本輪不處理，僅在規格中
  記錄為已知限制；牽涉是否改用持久化儲存的架構決策，影響範圍較大，留待日後獨立評估。
- **SOLID-DIP**：JS 環境下屬約定俗成，非缺陷，與前三服務判定一致。

## What Changes

- **錯誤碼查表**：controller 的錯誤碼→HTTP 映射改用單一 `ERROR_MAP`（與 auth/user/character
  三服務風格一致），取代 20 支方法各自的 if/else 鏈。
- **統一 sendMessage 系列的「對話不存在」回應**：`sendMessage`（依 characterId）改為與
  `sendMessageToConversation`（依 conversationId）一致，皆回 HTTP 404 `CONVERSATION_NOT_FOUND`
  （原本 `sendMessage` 回 400，是本次唯一的**可觀察行為變更**）。
- **移除死代碼**：刪除 `src/app.js.backup`、刪除 `prisma.config.ts`。
- **移除 `cors()`**：刪除 `app.use(cors())` 與 cors import。
- **移除斷掉的 test script**：`package.json` 移除 `"test": "jest"`（jest 從未安裝、無測試檔案，
  保留只會誤導使用者以為有測試）。
- **移除死欄位**：`authMiddleware.js` 移除 `req.userId = userId` 這行寫入。

## Impact

**唯一行為變更**：`POST /api/v1/conversations/character/:characterId/messages`（`sendMessage`）
在「對話不存在」時的回應，從 `HTTP 400 { message: "Conversation not found. Please GET ... first." }`
改為 `HTTP 404 { message: "Conversation not found" }`，與 `sendMessageToConversation` 一致。
需在 delta spec 中以 MODIFIED 需求明確記錄。

**其餘皆為行為保留的重構**（對真實呼叫者零行為變更）：
- 錯誤碼→HTTP 映射：`ERROR_MAP` 回傳的 status/message 與原本逐碼比對後完全一致。
- `app.js.backup`、`prisma.config.ts` 移除：兩者皆確認為執行期無人引用的死代碼，移除零影響。
- `cors()` 移除：只影響「瀏覽器直接打 :6000」（已確認無啟用中路徑），透過 gateway 的請求不受影響。
- `test` script 移除：`npm test` 原本必定失敗，移除後不再誤導；不影響任何 API 行為。
- `req.userId` 移除：無任何 controller 讀取此欄位，移除零影響。

**受影響檔案：**
- `src/app.js`（移除 cors）
- `src/controllers/conversationController.js`（移除 20 支方法各自的 if/else，改用共用 `ERROR_MAP`；
  `sendMessage` 的 CONVERSATION_NOT_FOUND 改對應 404）
- `src/middlewares/authMiddleware.js`（移除 `req.userId` 寫入）
- `src/app.js.backup`（刪除）
- `prisma.config.ts`（刪除）
- `package.json`（移除 `test` script）

**規格影響：** 「發送訊息（同步版）」需求的錯誤碼對照需要 MODIFIED delta；其餘變更皆為實作機制
改變、行為不變，僅反映於架構圖與「遺留代碼」段落。

**不在本輪範圍：** 除錯 log 清理（SoC）、記憶體狀態改為持久化儲存（12-Factor VI）、
SOLID-DIP（JS 下屬約定俗成）——皆經使用者確認暫不處理。
