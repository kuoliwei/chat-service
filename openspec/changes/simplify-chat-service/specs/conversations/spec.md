# conversations (delta) — simplify-chat-service

> 本次優化的可觀察行為變更僅一項：`sendMessage`（依 characterId 的舊同步端點）在對話不存在時的
> HTTP 狀態碼與訊息文字。其餘變更（ERROR_MAP 查表化、刪除死代碼、移除 cors()、移除斷掉的 test
> script、移除死欄位）皆為實作機制改變、行為不變，故不產生對應 delta 需求，僅反映於 main spec
> 架構圖與遺留代碼段落（Phase 10 回寫時處理）。

## MODIFIED Requirements

### Requirement: 發送訊息（同步版，依 characterId）
系統 SHALL 提供同步發送訊息的端點：直接保存訊息、無 AI 生成、無摘要機制。對話不存在時 MUST 回傳
HTTP 404（與 `sendMessageToConversation` 對「對話不存在」的回應風格一致）。

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
- **THEN** service 拋出 `CONVERSATION_NOT_FOUND`，controller 回傳 **HTTP 404**
  與 `{ message: "Conversation not found" }`
  （**變更前**：回傳 HTTP 400 與 `{ message: "Conversation not found. Please GET /conversations/character/{characterId} first." }`）
