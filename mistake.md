# chat-service 設計稽核記錄（mistake.md）

> **這是什麼**：拿平台的《後端系統設計原則》逐條對照 chat-service 的現況（依據 openspec 的
> `changes/conversations-foundation/proposal.md`、`design.md` 與 `specs/conversations/spec.md`），
> 找出不符原則之處。
>
> **原則**：符合的也如實標出，不硬湊違反；每項標示把握程度（高/中/低）。
> **用途**：作為後續「優化 change」的依據——每個確認的違反點，會轉成一筆規格變更來驅動修正。
> **稽核時間**：2026-07-25。

---

## A. 通用軟體設計原則

| 原則 | 判定 | 依據 |
|------|------|------|
| KISS | ⚠️ **部分違反（中把握）** | 非同步建立聊天室與非同步發送訊息各自是一套「內存 Map 狀態機 + 輪詢」，這是為了配合 RAG 初始化/AI 生成耗時而必要的複雜度（非過度設計），但兩套狀態機各自獨立實作、無共用抽象，讀懂全流程需要同時追蹤兩個 Map 與多個函式間的隱含狀態轉移，認知負擔偏高 |
| DRY | ❌ **違反（高把握）** | `conversationController.js` 20 支方法各自寫一串 `if (error.message === 'XXX')` 判斷式映射 HTTP status，錯誤碼與 HTTP 狀態碼的對應關係散落重複；`character-service`/`user-service`/`auth-service` 三個服務都已在各自優化輪次中改用共用 `ERROR_MAP` 查表，本服務尚未跟進，是四個 Node 服務中風格不一致的一個 |
| YAGNI | ❌ **違反（高把握）** | `src/app.js.backup` 是舊版 Express app 進入點，已被 `src/app.js` 完全取代（無任何檔案 import 它），是純粹的死代碼殘留 |
| SSOT | ⚠️ **部分違反（中把握）** | `prisma.config.ts`（專案根目錄）定義了一份使用 `@prisma/adapter-libsql` 的獨立 PrismaClient 設定，但執行期實際生效的是 `src/lib/prisma.js`（無 adapter 的 `new PrismaClient()`）；兩份 Prisma client 設定並存但只有一份真正被使用，是否為死代碼或 Prisma CLI 必要慣例待查證，先如實記錄「有兩個看似互斥的設定來源」這個事實 |

## B. 模組與物件設計

| 原則 | 判定 | 依據 |
|------|------|------|
| 關注點分離 SoC | ❌ **違反（高把握）** | Controller 與 Service 全層有大量除錯用 `console.log`（含明顯的 `🐛 [DEBUG]` 前綴），把「除錯」這個關注點混進了「HTTP 處理」與「業務邏輯」；密度遠高於其他三個 Node 服務（單一方法內常見 5+ 行 log，含逐筆列印訊息內容） |
| 資訊隱藏 | ✅ 符合 | `conversationRepository.js` 把 Prisma 操作藏在純 CRUD 介面（`conversationRepository`/`messageRepository`）後，service 不直接碰 Prisma；`serviceClient.js` 把對其他微服務的 HTTP 呼叫細節封裝起來，service 層只呼叫語意化方法 |
| 高內聚 / 低耦合 | ⚠️ **部分違反（中把握）** | 同 DRY-錯誤碼：新增一種錯誤語意時得同時改 controller 每一支相關方法的 if/else 鏈，改動會漣漪擴散到多處 |
| SOLID-SRP | ⚠️ 輕微（低把握） | `conversationService.js` 單一檔案身兼「對話 CRUD」「訊息 CRUD」「摘要機制」「建立狀態機」「AI 生成狀態機」「擁有權驗證」多重職責，檔案長度（1081 行）明顯偏大；但這些職責高度相關（都圍繞同一個 aggregate：一次對話的完整生命週期），拆分是否必要見仁見智，故標低把握 |
| SOLID-OCP | ⚠️ **部分違反（中把握）** | 與 DRY 錯誤碼問題同根：controller 用連續 if/else 判斷 `error.message`，新增錯誤碼必須改既有程式碼而非新增設定項 |
| SOLID-DIP | ⚠️ 輕微（低把握） | `conversationService.js` 直接 import 具體的 `conversationRepository`/`messageRepository`/`serviceClient`，非抽象介面；JS 動態語言下這類違反較鬆，且前三個服務的稽核已多次確認「使用者判定此為 JS 環境下約定俗成、不處理」，本服務性質相同 |
| LSP / ISP | 不適用 | 無繼承、無正式介面 |

## C. The Twelve-Factor App

| Factor | 判定 | 依據 |
|--------|------|------|
| III. Config | ✅ 符合（值得肯定） | `PORT`、`DATABASE_URL`、`GATEWAY_URL` 皆走 env，`.env`/`.env.example` 一致，無寫死問題 |
| IV. Backing Services | ✅ 符合 | DB 透過 `DATABASE_URL`、ai-service/character-service 透過 `GATEWAY_URL` 皆為可抽換的附加資源設定 |
| VI. Processes（無狀態） | ❌ **違反（中把握）** | `creationJobs`、`aiGenerationStatus` 是模組級（進程內）記憶體 `Map`，服務重啟即遺失所有建立中/生成中狀態；正在輪詢的前端會卡在過期狀態、正在生成的 AI 回覆會遺失且無法恢復。與 KISS 條目提到的複雜度是同一組程式碼，但這裡指出的是**架構層級的無狀態違反**，而非單純的可讀性問題——多實例部署或服務重啟會直接導致功能性 bug，不只是程式碼風格 |
| II. Dependencies | ✅ 符合 | `package.json` 明確宣告依賴，但 `"test": "jest"` script 指向未安裝的套件，屬宣告與實際不符（見下方「其他觀察」） |
| XI. Logs | ⚠️ 輕微（低把握） | 用 `console.log`/`console.error` 直接輸出而非結構化日誌串流，與其他三服務相同，非本服務獨有問題 |

## 其他觀察

- **CORS**：`app.js` 使用 `cors()`（允許所有 origin）。已 grep 前端 `persona-nexus-chat` 確認：
  `src/chat.js` 全部請求皆使用相對路徑 `/api/...`（經 gateway 代理），**沒有任何檔案直接呼叫
  `localhost:6000` 或 chat-service 的實際 port**。與 user-service/character-service 當初判定同理，
  目前沒有真實瀏覽器直連路徑觸發 CORS，`cors()` 屬多餘設定（近似 YAGNI），非安全漏洞。
- **`package.json` 的 `"test": "jest"` 是斷的**：jest 不在 dependencies/devDependencies，
  `node_modules` 沒有 jest，且專案內沒有任何 `*.test.js` 檔案——這個 script 執行必定失敗，
  是文件與現實不一致的另一種形式（`npm test` 給人一種「有測試」的錯覺，實際上完全沒有）。
  這不完全是「設計原則」違反，但屬於 Design by Contract 的變體：`package.json` 對外承諾了一個
  不存在的能力。
- **`test.http` 過時內容**：第 5 節「發送訊息」的註解寫「支持完整流程：摘要+AI生成」但範例本身是
  舊版同步發送語意描述（提到「AI 佔位訊息」），與現行「原子性保存」機制的實際回應（`accepted` +
  背景生成）不符——Phase 9 測試前需要更新，這是 SOP 標準步驟，非本輪額外新增的待辦。

## D. 契約設計（Design by Contract）

| 判定 | 依據 |
|------|------|
| ⚠️ **部分違反（中把握）** | `sendMessage`（舊同步端點，依 characterId）與 `sendMessageToConversation`（新非同步端點，依 conversationId）在「對話不存在」時的回應不一致：前者回 400、後者回 404；兩者都叫「發送訊息」，呼叫方無法從語意上預期一致的錯誤碼行為。這與 character-service 稽核中「`listCharacters` 回應風格不一致」是同類問題 |
| ⚠️ 輕微（低把握） | `authMiddleware.js` 寫入 `req.userId` 但無任何 controller 方法讀取，形成一個「看似有用、實際上是死路」的欄位；這是否構成契約問題見仁見智（更接近死代碼／YAGNI），故獨立於上方 YAGNI 項另記一筆低把握觀察，避免與 `app.js.backup` 的高把握判定混淆 |

---

## 稽核結論：確認的違反點（按把握度排序）

> **✅ 已完成**：使用者已逐項核對確認處理範圍（2026-07-25），並由 change `simplify-chat-service`
> 完成實作與驗證（手動整合測試，2026-07-25）。詳見各項「處理狀態」欄。

| # | 違反的原則 | 事實 | 把握 | 處理狀態 |
|---|-----------|------|------|------|
| 1 | **DRY + SOLID-OCP + 高內聚低耦合** | Controller 20 支方法各自 if/else 映射錯誤碼→HTTP，無共用 `ERROR_MAP`（其餘三服務已有） | 高 | ✅ 已處理——改用共用 `ERROR_MAP` 查表 |
| 2 | **YAGNI** | `src/app.js.backup` 是完全未被引用的舊版 app 死代碼 | 高 | ✅ 已處理——已刪除 |
| 3 | **SoC** | Controller + Service 全層大量除錯 `console.log`（含 `🐛 [DEBUG]` 前綴），密度高於其他服務 | 高 | ⏸️ **本輪不處理**，使用者確認暫緩 |
| 4 | **12-Factor VI（無狀態）** | `creationJobs`／`aiGenerationStatus` 為進程內記憶體 Map，服務重啟即遺失建立中/生成中狀態 | 中 | ⏸️ **本輪不處理**，僅記錄為已知限制——牽涉是否換成外部儲存（DB 欄位或 Redis）的架構決策，影響範圍較大，使用者確認留待日後獨立評估 |
| 5 | **契約一致性** | `sendMessage`（依 characterId）與 `sendMessageToConversation`（依 conversationId）在「對話不存在」時分別回 400 / 404 | 中 | ✅ 已處理——統一回 404（本次唯一的可觀察行為變更，已寫入 MODIFIED delta 並同步至 main spec，手動驗證通過） |
| 6 | **SSOT（已查證）** | `prisma.config.ts` 定義的 PrismaClient 與 `src/lib/prisma.js` 並存 | 中 | ✅ 已查證並處理：Prisma 5.22（本專案安裝版本）CLI 完全不讀取 `prisma.config.ts`（`node_modules/prisma/build/index.js` 內無任何 `prisma.config`/`defineConfig` 相關程式碼），此支援為 Prisma 6.x 才引入的功能。確認為死代碼，**已刪除** |
| 7 | **多餘設定** | CORS 開放所有 origin，但已確認無啟用中的瀏覽器直打 :6000 路徑 | 低 | ✅ 已處理——已移除 `cors()` |
| 8 | **契約完整性** | `package.json` 的 `"test": "jest"` 指向未安裝套件，執行必定失敗 | 低 | ✅ 已處理——已移除該 script（不新增測試框架，本輪範圍之外） |
| 9 | **SOLID-DIP** | `conversationService.js` 直接依賴具體 repository/serviceClient，非抽象介面 | 低 | ⏸️ **不處理**——與前三服務判定一致，JS 環境下屬約定俗成慣例 |
| 10 | **死欄位** | `authMiddleware.js` 寫入 `req.userId` 但無人讀取 | 低 | ✅ 已處理——已移除該行寫入 |

## 做得好、不該動的部分

- 對話/訊息資料的 SSOT（自有資料庫，無副本；`prisma.config.ts` 疑慮是設定檔層級，非資料本身）
- 資訊隱藏（repository 把 Prisma 藏在純 CRUD 介面後，serviceClient 把服務間 HTTP 呼叫細節封裝起來）
- 12-Factor：Config（PORT/DATABASE_URL/GATEWAY_URL 走 env）、Backing Services
- 三層架構的基本框架正確（Controller → Service → Repository 職責邊界清楚）
- 已完成的擁有權檢查集中化（`assertConversationOwnership`）——修正過 4 處跨帳號漏洞，且此次稽核
  未發現新的類似漏洞，是本服務先前已經做對的重要安全修正（`01baf9e`），非本輪待辦
- 刪除對話/更新主角人設「先呼叫外部服務、成功才動 DB」的順序設計，確保資料一致性，是值得保留的模式
- 回溯刪除訊息時連動清理摘要、標回未摘要狀態的邏輯完整，避免了「刪除訊息但 AI 仍記得」的資料不一致

## 延後或不建議處理的項目

- **XI. Logs（console.log 而非結構化日誌）**：全平台學習專案的通案，非本服務特有，本輪不處理。
- **SOLID-SRP（`conversationService.js` 檔案過大）**：職責雖多但高度相關，是否拆分屬架構設計選擇，
  非明確缺陷，建議列為觀察項而非強制處理。

## 誠實提醒

- **第 4 點（無狀態）把握僅中，且影響範圍最大**：這不是單純的程式碼風格問題，而是牽涉「要不要把
  記憶體狀態換成持久化儲存」的架構決策，可能超出「清理型」優化的範疇，需要使用者明確裁示是否本輪處理、
  或僅記錄為已知限制。
- **第 6 點（prisma.config.ts）尚未查證**：稽核階段只發現「兩份 Prisma 設定並存但只有一份生效」的事實，
  尚未確認 `prisma.config.ts` 是否是 Prisma 5.21+ CLI 讀取遷移指令時的慣例檔案（若是，刪除可能導致
  `prisma migrate`/`prisma studio` 等指令失效）。建議列入 Phase 6 任務時先查證再決定刪除或保留。
- **第 1、3 點與其他三服務的模式一致**：這兩點的優化方式在 auth/user/character 三服務已有先例可循，
  風險相對較低；第 4、6 點是本服務獨有的新問題，建議優先處理有先例的項目，新問題視使用者意願決定範圍。
