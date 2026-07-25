## Why

> 這是一份**回溯性提案（retrospective proposal）**：chat-service 已經實作完成並運作，
> 本文反推「當初若有正式提案，會怎麼寫」，補上行為規格（main spec）沒有記錄的**動機與範圍**。

Persona Nexus 平台是類 Character.ai 的 AI 角色扮演平台，使用者與 AI 角色的每一句對話都需要持久化，
並且需要記憶機制（RAG）讓角色「記得」更早之前發生過的事——單純存訊息、逐字塞給模型會讓上下文
無限增長。chat-service 是這條記憶管線的協調者：它決定何時觸發摘要、何時清理向量資料庫、
如何在 AI 生成失敗時避免留下孤立資料。

為什麼要獨立成一個服務？

- **單一職責**：對話與訊息的持久化、記憶生命週期管理，是與角色定義（character-service）、
  帳號資料（user-service）、實際 LLM 推論（ai-service）都不同的關注點。
- **獨立資料所有權**：對話與訊息量會隨使用量線性成長，獨立資料庫讓它可單獨擴展、備份。
- **非同步協調角色**：本服務同時是多個外部呼叫（RAG 初始化、AI 生成、摘要生成/存儲/刪除）的
  唯一協調點，把這些跨服務的多步驟流程集中在一處，前端只需輪詢單一狀態端點。

## What Changes

建立 chat-service，提供並僅提供以下能力：

- **對話生命週期**：依角色取得或建立對話（非同步 + 輪詢，含 RAG 初始化）、查詢對話列表（完整版/摘要版）、
  刪除單一對話或依角色刪除所有對話（先清 RAG 再刪 DB）、重試失敗的建立流程。
- **訊息生命週期**：發送訊息（同步版與非同步 AI 生成版兩種）、依角色或依對話 ID 查詢訊息、
  查詢單一訊息、回溯式刪除訊息（連動清理已摘要的向量資料）。
- **記憶管理**：未摘要訊息字數達閾值時自動觸發摘要（呼叫 ai-service 生成 + 存入向量資料庫）、
  短期記憶窗口控制（只保留最新 N 條原文）。
- **主角人設**：使用者可為每個聊天室設定自己扮演的「主角」名稱與背景，寫入 RAG 供生成時參考。
- **AI 生成狀態追蹤**：進程內記憶體 Map 追蹤每個對話的生成中/完成/失敗狀態，供前端輪詢；
  同對話同時只允許一個生成任務（含逾時保險，避免殭屍鎖永久卡住對話）。

**刻意不做（非本服務範圍）：**

- **不驗證 JWT**：身份驗證交給 api-gateway 集中處理，本服務只信任 gateway 注入的 `x-user-id` header。
- **不做實際 LLM 推論或向量檢索**：生成回覆、生成摘要、RAG 檢索/儲存皆委派給 ai-service，
  本服務只負責組裝請求與協調呼叫時機。
- **不做即時通訊（WebSocket）**：前端以輪詢取得 AI 生成結果，非推播。
- **不做訊息編輯、訊息搜尋**：目前只有刪除（含回溯刪除），沒有編輯或全文搜尋端點。

## Impact

**新增對外 API 契約：** 詳見 `openspec/specs/conversations/spec.md`（現況基準線規格），涵蓋
`/api/v1/conversations/*` 共 15 條路由（對話 CRUD、訊息 CRUD、主角人設、AI 生成狀態）。

**新增外部依賴：**
- **SQLite**（`DATABASE_URL`，本機檔案）— 本服務自有資料庫，Prisma + `@prisma/adapter-libsql`。
- **api-gateway** — 上游轉發方，也是呼叫 ai-service/character-service 的**唯一路徑**
  （一律經 `/internal/*`，不直連）。
- **ai-service（經 gateway）** — RAG 初始化/清理/查詢狀態、生成回覆、生成摘要、存取/刪除摘要、
  更新主角背景切片。
- **character-service（經 gateway）** — 建立對話前驗證角色存在性與存取權限。

**新增環境變數：**
- `PORT` — 監聽埠，預設 6000。
- `DATABASE_URL` — SQLite 檔案路徑。
- `GATEWAY_URL` — api-gateway 位址，預設 `http://localhost:8000`。

**技術棧：**
- Node.js（ESM）/ Express 5 / Prisma 5（`@prisma/adapter-libsql`）/ SQLite / axios（服務間呼叫）。
- ⚠️ 無測試框架整合（`package.json` 的 `test` script 指向未安裝的 jest，沒有任何測試檔案）。

**行為契約詳見** `openspec/specs/conversations/spec.md`（現況基準線規格）。
**架構決策與取捨詳見** 同目錄 `design.md`。
