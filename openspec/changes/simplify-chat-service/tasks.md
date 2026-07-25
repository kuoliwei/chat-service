# Tasks — simplify-chat-service

> 唯一的行為變更（`sendMessage` 的 CONVERSATION_NOT_FOUND 對應碼）先做並優先驗證；
> 其餘為行為保留的重構，後做。每項完成後打勾。

## 1. 行為變更：統一 sendMessage 的「對話不存在」回應（優先）

- [x] 1.1 `src/controllers/conversationController.js` 的 `sendMessage`：`CONVERSATION_NOT_FOUND`
      分支改回傳 HTTP 404 與 `{ message: "Conversation not found" }`（原為 400 +
      `"Conversation not found. Please GET ... first."`）
- [x] 1.2 更新 `test.http` 對應情境的預期狀態碼註解（若有提及 400）

## 2. 錯誤碼→HTTP 改用共用 ERROR_MAP（DRY + OCP + 高內聚低耦合，行為不變）

- [x] 2.1 於 `conversationController.js` 模組層級定義 `ERROR_MAP`，涵蓋「固定 status + 固定
      message」的錯誤碼：`UNAUTHORIZED`(401)、`MISSING_CHARACTER_ID`(400)、
      `MISSING_CONVERSATION_ID`(400)、`MISSING_PARAMS`(400)、`MISSING_TEXT`(400)、
      `INVALID_ROLE`(400)、`CHARACTER_NOT_FOUND`(404)、`CONVERSATION_NOT_FOUND`(404)、
      `MESSAGE_NOT_FOUND`(404)、`FORBIDDEN`(403)、`NOT_USER_MESSAGE`(400)、
      `NO_FAILED_JOB`(404)、`JOB_NOT_FAILED`(409)
- [x] 2.2 20 支方法逐一改用 `ERROR_MAP` 查表取代對應的 if/else 分支；動態內容錯誤碼
      （`AI_GENERATION_IN_PROGRESS`、`AI_SERVICE_UNAVAILABLE:`前綴、`SERVICE_ERROR:`前綴）
      維持個別處理，不勉強塞入靜態查表
- [x] 2.3 確認每支方法 status/message 與變更前**逐碼比對後完全一致**（除任務 1 明確變更的
      `sendMessage` 之 CONVERSATION_NOT_FOUND 外）

## 3. 移除死代碼（YAGNI，行為不變）

- [x] 3.1 刪除 `src/app.js.backup`
- [x] 3.2 刪除 `prisma.config.ts`（已查證 Prisma 5.22 CLI 不讀取此檔案）

## 4. 移除多餘 cors()（已驗證安全，行為不變）

- [x] 4.1 `src/app.js`：移除 `import cors` 與 `app.use(cors())`

## 5. 移除斷掉的 test script（契約完整性，行為不變）

- [x] 5.1 `package.json`：移除 `"test": "jest"`

## 6. 移除死欄位 req.userId（行為不變）

- [x] 6.1 `src/middlewares/authMiddleware.js`：移除 `req.userId = userId` 這行

## 7. 驗證（測試前先徵得同意；先核對測試腳本是否過時）

- [x] 7.1 更新 `test.http`：修正第 5 節「發送訊息」過時的「AI 佔位訊息」描述，改為符合現行
      「立即 accepted + 背景原子性保存」語意；涵蓋全部 spec scenario（成功/失敗路徑、
      sendMessage 與 sendMessageToConversation 的行為差異對照）
- [x] 7.2 手動驗證（使用者重啟服務後）：全部情境涵蓋，含本次 CONVERSATION_NOT_FOUND 行為變更的
      新舊對照（確認 sendMessage 現在回 404）
- [x] 7.3 grep 全 `src/` 確認無殘留對已移除符號（`cors`、`app.js.backup`、`prisma.config.ts`、
      `req.userId`）的引用
- [x] 7.4 因本服務無任何單元測試框架整合（本輪不新增），本階段僅執行手動整合測試

## 8. 更新規格

- [x] 8.1 將 delta（MODIFIED「發送訊息（同步版，依 characterId）」）同步進 main spec
- [x] 8.2 更新 main spec 架構圖（移除 cors 註記、controller 註記改為 ERROR_MAP 查表、移除
      `app.js.backup`/`prisma.config.ts` 相關描述）與 `config.yaml` 的已知遺留代碼段落
- [x] 8.3 更新 `CLAUDE.md`：反映 ERROR_MAP、CORS 移除、死代碼已清除、test script 移除、
      `req.userId` 移除、測試現況（僅手動整合測試）
- [x] 8.4 於 `mistake.md` 標記第 1、2、5、6、7、8、10 點已處理，第 6 點（prisma.config.ts）
      標記查證結果與處理方式；第 3、4、9 點標記維持不處理並記錄理由

## 備註

- 第 3 點（除錯 console.log 清理）、第 4 點（無狀態記憶體 Map）、第 9 點（SOLID-DIP）
  經使用者確認不在本輪範圍。
