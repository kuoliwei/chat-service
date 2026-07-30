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
>
> **後續更新（2026-07-25～26，commit `b509562`）**：第 4 點「12-Factor VI（無狀態）」原本標記
> 「本輪不處理」，之後在平台級《微服務架構準則/實作spec》稽核中被處理——`creationJobs`／
> `aiGenerationStatus` 記憶體 Map 已改為持久化（`ConversationCreationJob` 表 + `Conversation`
> 表的 `generationStatus` 等欄位），並於 2026-07-26 以實際重啟服務驗證（K1-K5）狀態存活。
> 下表第 4 列的「⏸️ 本輪不處理」是本次稽核當下的判定，如實保留；狀態已在後續輪次改變，見
> `CLAUDE.md`「已知限制」段落的最新描述。

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

---

## 2026-07-30 追加稽核：程式碼層面優化（第二輪）

> **這是什麼**：上方是 2026-07-25 的架構層級稽核（SOLID/DRY/12-Factor），已全數處理完畢。
> 本節是對齊 auth-service / user-service / character-service 三個服務已完成的**程式碼層面**
> 優化（JSDoc、區段註解、命名），依《程式撰寫設計原則.md》六大維度重新掃描。
> 兩輪稽核角度不同，互不重複。

### 稽核範圍

| 檔案 | 行數 | 備註 |
|------|------|------|
| `src/services/conversationService.js` | 1069 | 主要問題來源 |
| `src/controllers/conversationController.js` | 454 | ERROR_MAP 已集中化，品質良好 |
| `src/repositories/conversationRepository.js` | 322 | 含 4 個 repository |
| `src/lib/serviceClient.js` | 382 | JSDoc 已完整，**免修改** |
| `src/app.js` / `src/config/index.js` | 76 / 19 | **免修改** |

### 🔴 高優先度

**1. `conversationService.js` 1069 行，遠超 800 行警戒線，職責混雜且無區段分割（A1/A2 違反）**

檔案內至少 7 個職責平鋪在一起，無任何 `// ========== ==========` 區段註解分隔：
對話建立、對話查詢/列表、訊息 CRUD、對話刪除、主角人設、建立重試、AI 生成狀態查詢/清除；
加上摘要機制、RAG 清理、AI 請求組裝、擁有權檢查等共用 helper。

這與上方 2026-07-25 稽核「SOLID-SRP：⚠️ 輕微（低把握），建議列為觀察項而非強制處理」的結論
一致——本輪維持「不拆檔，僅補區段註解緩解導航成本」的判斷（見下方「拆檔決策」）。

**2. 匯出的 17 個 public 方法幾乎全數缺少 JSDoc，本末倒置（F2/B3 違反）**

檔案內私有 helper（`assertConversationOwnership`、`calculateHistoryLength`、
`checkIfNeedsSummary`、`buildAIServiceRequest`、`cleanupConversationRAG`、`executeSummary`）
都有完整 JSDoc，但 `conversationService` 物件底下 17 個 public 方法——controller 實際呼叫的
API 介面——只有 3 個帶簡短行內註解，其餘完全沒有 JSDoc。依前三服務標準，這些才是最需要
JSDoc（@param/@returns/@throws）的對象。

### 🟡 中優先度

**3. `conversationRepository.js` 的基礎 CRUD 方法缺少 JSDoc**

`conversationRepository`（6 方法）與 `messageRepository`（7 方法）共 13 個方法皆無 JSDoc，
對齊前三服務的 userRepository/characterRepository 標準應補上。
`conversationCreationJobRepository`、`generationStatusRepository` 已有優質行內註解說明設計
動機，但缺正式 JSDoc 格式。

### 🟢 低優先度 / 維持不動

- `assertConversationOwnership`、`tryAcquireLock`、`setFailed` 上方的長段落註解（說明歷史
  bug、回合身分設計、殭屍鎖邏輯）屬高品質「為什麼」型註解，**不應簡化**，予以保留。
- `conversationController.js` 的 try/catch/ERROR_MAP 樣板重複，但與其他三服務既有 controller
  風格一致，不在本輪處理範圍。

### 📋 已知限制（不在本輪處理範圍）

- console.log 除錯訊息氾濫——已於 2026-07-25 輪確認暫緩。
- SOLID-DIP（service 直接依賴具體 repository）——已於 2026-07-25 輪確認不處理。

### 拆檔決策：本輪不拆 `conversationService.js`（✅ 已於同日稍後推翻並完成）

**當時的理由**：
1. 本服務無測試框架，拆檔若打斷共用狀態（`generationStatusRepository`、
   `assertConversationOwnership` 跨方法共用）沒有自動化網可攔截回歸
2. 2026-07-25 輪 SOLID-SRP 判定已是「低把握、建議列為觀察項」，非明確缺陷
3. 前三服務的優化範圍皆為「補文件、簡化註解」，不涉及拆檔，維持一致慣例

**當時的緩解方案**：補 JSDoc + 區段註解（`// ========== 職責 X ==========`），達成 A2（內部結構
清晰性），將拆檔列為未來獨立工作項（需先補測試才能安全進行）。

> **後續進展（同日）**：使用者指出「補文件不等於實質優化」，決定直接處理擋在前面的前提條件——
> **先補測試框架，再拆檔**。兩者都已完成，詳見下方「2026-07-30 第三輪」。

---

## 2026-07-30 第三輪：補測試框架 + 依職責拆檔（🔴 高優先度第 1 項已解決）

> 上一節（第二輪）把「1069 行巨型檔案」列為 🔴 高，但只用區段註解緩解，沒有真的解決。
> 本輪把擋路的前提（無測試安全網）一併處理掉，然後真的拆了。

### 步驟 1：導入測試框架（commit `c829512`）

- 引入 Vitest ^4.1.8（對齊 character-service 既有設定，不需額外 config 檔）
- `src/services/conversationService.test.js`：**82 則**單元測試，覆蓋全部 17 個 public 方法
- 三個模組整模組 mock：`conversationRepository.js`（4 個匯出物件）、`serviceClient.js`、`config/index.js`

**關鍵設計**：測試一律透過 `conversationService.X()`（即 controller 用的同一層介面）呼叫，
不打個別內部函式。因此拆檔前後可以用**完全相同、一個字都不改的斷言**驗證行為不變——
這是讓拆檔變安全的核心手法。

**⚠️ 踩到的雷**：`config.json` 未進版控（只有 `config.example.json`），而 `config/index.js`
讀不到檔案會 `process.exit(1)`。測試必須 mock 掉它，否則乾淨環境會整組炸掉、且測試結果
會被本機設定值污染。

**測試順帶抓到的既有缺陷**：第二輪補的 JSDoc 有 5 個方法漏列 `MISSING_CONVERSATION_ID`
（`deleteConversation`／`getProtagonist`／`updateProtagonist`／`getAIGenerationStatus`／
`clearAIGenerationStatus`），已補齊。這證明「寫測試核對文件」確實會抓出光靠閱讀發現不了的落差。

### 步驟 2：依職責拆檔（commit `e85fce8`）

**拆分依據不是行數，而是根目錄《程式撰寫設計原則.md》第 50-57 行針對本檔列出的職責清單**
（該文件正是拿這個檔案當範例寫的，等於作者早就把答案寫好了）：

| 職責 | 新檔案 | 行數 |
|------|--------|------|
| 1. 對話 CRUD（讀取／列表／刪除） | `conversationCrudService.js` | 148 |
| 2. 訊息 CRUD（含回溯式刪除） | `messageService.js` | 308 |
| 3. 摘要機制 | `summaryService.js` | 143 |
| 4. 對話建立狀態機 | `conversationCreationService.js` | 311 |
| 5. AI 生成狀態機 | `aiGenerationService.js` | 300 |
| 6. 擁有權檢查 | `conversationOwnership.js` | 61 |
| 7. 主角人設（文件未列，後來新增的功能） | `protagonistService.js` | 67 |
| — 組裝層（barrel） | `conversationService.js` | 67 |

**1263 行 → 最大檔 311 行。**

### 設計要點

- **`conversationOwnership.js` 必須維持葉節點**（只 import repository，絕不 import 兄弟模組）：
  它被 9 個方法共用，放進任何有其他依賴的模組都會製造循環依賴
- **子模組一律不得 import barrel**，否則形成 `barrel → 子模組 → barrel` 的環
- **`conversationCreationJobRepository` 完整封裝在 `conversationCreationService.js`**，
  service 層其他地方都不再碰它
- **移除 `this._generateAIResponseAsync`**：改為直接呼叫模組內函式，
  不再隱性依賴「barrel 是否把該方法合併進同一個物件」
- **保留 barrel**：controller 的 16 處 `conversationService.X()` 呼叫**零修改**

### 驗證結果

- ✅ 82 則測試全綠，且**測試檔 zero diff**（拆檔前後斷言完全相同）
- ✅ barrel 匯出 17 個方法，全部解析為 function（無循環依賴）
- ✅ controller 零改動、`/health` 正常
- ✅ 純搬移；唯一的邏輯調整是移除 `calculateHistoryLength` 已確認的死參數
  `excludeLatestCount`（唯一呼叫點只傳 1 個引數，且呼叫端自己已先 slice 過）

### 順帶修正：第二輪的區段註解貼錯位置

第二輪加的 `// ========== 主角人設 ==========` 底下實際上還躺著
`deleteMessageAndSubsequent` 和 `getMessageById` 兩個訊息網域的方法——因為它們的實體位置
就在 `updateProtagonist` 之後。標籤與內容不符。拆檔後這些區段註解被真正的檔案邊界取代，
問題自然消失。

**教訓**：區段註解只是「假裝有邊界」，實際上不強制任何約束——方法位置一旦與標籤脫節就會說謊，
而且沒有任何機制會提醒你。真正的檔案邊界則是編譯器層級的約束。
