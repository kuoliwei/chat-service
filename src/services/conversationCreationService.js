import { conversationRepository, messageRepository, conversationCreationJobRepository } from '../repositories/conversationRepository.js';
import { serviceClient } from '../lib/serviceClient.js';
import { validateUserId } from './conversationOwnership.js';

// ========== 職責 4：對話建立狀態機 ==========
//
// 聊天室建立是非同步 + 輪詢模式：前端呼叫 getOrCreateConversation 會立刻拿到
// preparing，真正的建立工作（RAG 初始化 → 等待就緒 → 寫 DB → 存開場白）在背景進行。
// 建立中／失敗的狀態持久化在 ConversationCreationJob 表（原本是進程內記憶體 Map），
// 因此服務重啟不會遺失進行中的建立流程。
//
// 本檔完整封裝 conversationCreationJobRepository——service 層其他地方都不碰它。

function generateConversationId() {
  return `conv_${Date.now()}`;
}

// 🆕 請求追蹤計數器（用於識別並發請求）
let requestCounter = 0;

/**
 * 聊天室建立流程的狀態追蹤（原本是進程內記憶體 Map，改為 conversationCreationJobRepository 持久化）
 * status: 'preparing' | 'failed'
 * 注意：聊天室一旦成功寫入 DB，job 記錄就被刪除（DB 有 Conversation 記錄 = 已就緒，
 * 不再需要標記 'ready' 這個中繼狀態——getOrCreateConversation 的步驟 1 會查到它）
 */

/**
 * 背景發起聊天室建立流程（非同步，fire-and-forget）
 * 流程：發起 RAG 初始化 → 輪詢等待就緒 → 寫 DB → 存開場白 → 刪除 job
 * @param {string} userId - 用戶 ID
 * @param {string} characterId - 角色 ID
 * @param {Object} character - 角色信息對象
 * @param {string} conversationId - 生成的聊天室 ID
 * @returns {Promise<void>} 不拋出異常，失敗時把 job 標記為 failed 供輪詢端讀取
 */
async function _prepareAndCreateConversation(userId, characterId, character, conversationId) {
  console.log(`\n🏗️  [背景任務] 發起聊天室建立`);
  console.log(`  ├─ conversationId: ${conversationId}`);
  console.log(`  ├─ userId: ${userId}`);
  console.log(`  ├─ character: ${character.name}`);
  console.log(`  └─ userId+characterId: ${userId}:${characterId}`);

  try {
    // === 1. 發起 RAG 初始化 ===
    console.log(`\n  🧠 [背景任務] 發起 RAG 初始化`);

    // 轉換 fewShots 格式：[{user, char}] → ["User: user msg\nCharacter: char msg", ...]
    // 🆕 加上說話者標籤（User:/Character: 冒號風格，LLM 訓練語料中最常見的對話標記慣例），
    // 讓 LLM 明確知道範例中哪句是用戶、哪句是角色——標籤在存入 RAG 時就寫進文本
    const fewshotsArray = (character.fewShots || []).map(shot => {
      if (typeof shot === 'string') {
        return shot;
      }
      return `User: ${shot.user}\nCharacter: ${shot.char}`;
    });

    const ragData = {
      conversation_id: conversationId,
      character_id: characterId,
      background: character.background || '',
      fewshots: fewshotsArray
    };
    console.log(`  ├─ 📊 RAG 初始化資料:`);
    console.log(`  ├─   background: ${(ragData.background || '').length} 字`);
    console.log(`  ├─   fewshots: ${ragData.fewshots.length} 個`);

    // 發起初始化（ai-service 立即回 202，背景進行）
    console.log(`  ├─ 📤 呼叫 ai-service POST /conversations/initialize...`);
    await serviceClient.initializeRAG(ragData);
    console.log(`  ✅ [背景任務] RAG 初始化請求已發送`);

    // === 2. 等待 RAG 初始化完成 ===
    console.log(`  ├─ ⏳ 【背景任務】等待 RAG 初始化完成...`);
    let ragStatus = 'pending';
    let checkAttempts = 0;
    const maxAttempts = 120; // 最多等 120 秒

    while (ragStatus !== 'ready' && checkAttempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // sleep 1 秒
      checkAttempts++;

      const statusData = await serviceClient.checkRAGStatus(conversationId);
      ragStatus = statusData;

      if (ragStatus === 'ready') {
        console.log(`  ├─ ✅ 【背景任務】RAG 初始化完成 (${checkAttempts} 秒)`);
        break;
      }

      if (ragStatus === 'failed') {
        throw new Error(`RAG 初始化失敗`);
      }
    }

    if (ragStatus !== 'ready') {
      throw new Error(`RAG 初始化超時（超過 ${maxAttempts} 秒）`);
    }

    // === 3. 直接寫入 DB ===
    console.log(`  ├─ 📝 【背景任務】寫入 DB...`);
    await conversationRepository.create({
      id: conversationId,
      userId,
      characterId,
      title: null,
      characterName: character.name,
      characterGender: character.gender,
      characterTags: JSON.stringify(character.tags || []),
      characterIntroduction: character.introduction,
      characterBackground: character.background,
      characterOpening: character.opening,
      characterFewShots: JSON.stringify(character.fewShots || []),
    });
    console.log(`  ├─ ✅ 【背景任務】DB 寫入成功`);

    // === 4. 保存開場白 ===
    if (character.opening) {
      await messageRepository.create({
        conversationId,
        role: 'assistant',
        text: character.opening,
      });
      console.log(`  ├─ 💬 【背景任務】開場白已保存`);
    }

    // === 5. 成功：刪除 job 記錄（DB 已有 Conversation 記錄 = 已就緒） ===
    await conversationCreationJobRepository.delete(userId, characterId);
    console.log(`  └─ ✅ 【背景任務】job 記錄已清除（DB 記錄即代表就緒）\n`);

  } catch (error) {
    console.error(`\n  ❌ 【背景任務】失敗: ${error.message}`);

    // 失敗 → 標記 job 為 failed
    await conversationCreationJobRepository.upsert(userId, characterId, {
      status: 'failed',
      conversationId,
      error: error.message,
    });
    console.error(`  └─ job 已標記為 failed\n`);
  }
}

// 🆕 createNewConversation（不含 RAG 初始化的舊建立函數）已隨 restart 專用管線一併移除
// 建立聊天室一律走 _prepareAndCreateConversation（含 RAG 初始化）

/**
 * 取得或建立與指定角色的對話（非同步 + 輪詢模式）
 * 對話已存在時直接回傳 ready；不存在時發起背景建立流程（RAG 初始化）並回傳 preparing，
 * 前端需輪詢本方法直到收到 ready 或 failed
 * @param {string} userId - 使用者 ID
 * @param {string} characterId - 角色 ID
 * @returns {Promise<Object>} { status: 'ready', conversationId, messages, title, ... } |
 *   { status: 'preparing' } | { status: 'failed', message }
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 * @throws {Error} 'MISSING_CHARACTER_ID' 若 characterId 缺失
 * @throws {Error} 'CHARACTER_NOT_FOUND' 若角色不存在
 * @throws {Error} 'FORBIDDEN' 若無權限存取該角色
 */
export async function getOrCreateConversation(userId, characterId) {
  // 🆕 為每個請求分配唯一 ID，用於追蹤並發請求
  const requestId = ++requestCounter;
  const timestamp = new Date().toISOString().split('T')[1];
  console.log(`\n📨 [conversationService] 收到建立聊天室請求 #${requestId} (${timestamp}): userId=${userId}, characterId=${characterId}`);

  validateUserId(userId);

  if (!characterId) {
    throw new Error('MISSING_CHARACTER_ID');
  }

  // 🆕 驗證角色是否存在（調用 character-service）
  console.log(`  ├─ 【請求 #${requestId}】驗證角色存在性...`);
  let character;
  try {
    character = await serviceClient.getCharacter(characterId, userId);  // 🆕 傳遞 userId
    console.log(`  ├─ 【請求 #${requestId}】✅ 角色驗證通過: ${character.name}`);
  } catch (error) {
    console.error(`  ├─ 【請求 #${requestId}】❌ 角色驗證失敗:`, error.message);
    if (error.message === 'CHARACTER_NOT_FOUND') {
      throw new Error('CHARACTER_NOT_FOUND');
    }
    throw error;
  }

  // === 步驟 1：查詢現有對話，存在就直接回傳（ready）===
  console.log(`  ├─ 【請求 #${requestId}】[步驟 1] 查詢現有對話...`);
  const conversation = await conversationRepository.findFirst(
    {
      userId,
      characterId,
    },
    {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    }
  );

  if (conversation) {
    console.log(`  ├─ 【請求 #${requestId}】✅ 對話已存在: conversationId=${conversation.id}, 訊息數=${conversation.messages?.length || 0}`);
    console.log(`  └─ 【請求 #${requestId}】回傳 ready\n`);
    return {
      status: 'ready',
      conversationId: conversation.id,
      messages: conversation.messages || [],
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  }

  console.log(`  ├─ 【請求 #${requestId}】對話不存在，進入步驟 2`);

  // === 步驟 2：不存在 → 檢查背景建立 job ===
  const job = await conversationCreationJobRepository.findByKey(userId, characterId);

  console.log(`  ├─ 【請求 #${requestId}】[步驟 2] 檢查 job 狀態: userId=${userId}, characterId=${characterId}`);
  if (job) {
    console.log(`  ├─ 【請求 #${requestId}】⚠️  job 已存在: status=${job.status}, conversationId=${job.conversationId}`);

    if (job.status === 'failed') {
      // 刪除失敗的 job，但返回失敗給用戶
      // 用戶可以手動點擊重試，下次請求就能重新檢查
      console.log(`  ├─ 【請求 #${requestId}】❌ job 已失敗，清除舊 job`);
      console.log(`  ├─ 失敗原因: ${job.error || 'unknown'}`);
      await conversationCreationJobRepository.delete(userId, characterId);
      console.log(`  └─ 【請求 #${requestId}】回傳 503（用戶可重試）\n`);
      return {
        status: 'failed',
        message: job.error || '聊天室建立失敗'
      };
    }

    if (job.status === 'preparing') {
      // 🆕 【單一寫入者設計】輪詢不再查 RAG、也不寫 DB——這些全由背景任務
      //    _prepareAndCreateConversation 包辦（等 RAG → 寫 DB → 刪除 job）。
      //    輪詢只需回報「還在準備中」，讓前端繼續輪詢：
      //      - 背景任務完成 → 寫好 DB + 刪除 job → 下一輪由【步驟 1 查現有對話】查到 → 回 ready
      //      - 背景任務失敗 → job='failed' → 由上面的 failed 分支回 failed
      //    （移除舊的「輪詢也寫 DB」邏輯，避免與背景任務雙重寫入撞 unique constraint）
      console.log(`  ├─ 【請求 #${requestId}】🔄 job 準備中，背景任務處理中，回傳 preparing`);
      return { status: 'preparing' };
    }
  }

  // === 步驟 3：啟動背景建立，立即回傳 preparing ===
  // 註：這裡曾有一段「先檢查 AI Service 健康」的前置健檢，2026-07 實驗性停用後確認
  // 不需要——ai-service 不可用時，背景任務的 initializeRAG/checkRAGStatus 會拋
  // SERVICE_ERROR，job 被標記為 failed，輪詢端下一輪就會收到 failed，錯誤照樣傳得到前端。
  // 既然錯誤傳播路徑已足夠，健檢屬多餘的往返，已於 2026-07-30 連同 checkAIServiceHealth 一併移除。
  const conversationId = generateConversationId();
  await conversationCreationJobRepository.upsert(userId, characterId, { status: 'preparing', conversationId });
  console.log(`  ├─ 【請求 #${requestId}】[步驟 4] ✅ 創建新 job，允許該請求繼續`);
  console.log(`  ├─ conversationId: ${conversationId}`);
  console.log(`  ├─ character: ${character.name}`);
  console.log(`  └─ 發起 RAG 初始化...\n`);
  // fire-and-forget（不 await）
  _prepareAndCreateConversation(userId, characterId, character, conversationId);

  return { status: 'preparing' };
}

/**
 * 清除失敗的建立 job，讓使用者可以重新發起建立聊天室
 * @param {string} userId - 使用者 ID
 * @param {string} characterId - 角色 ID
 * @returns {Promise<{success: true, message: string}>}
 * @throws {Error} 'UNAUTHORIZED' 若 userId 缺失
 * @throws {Error} 'MISSING_CHARACTER_ID' 若 characterId 缺失
 * @throws {Error} 'NO_FAILED_JOB' 若找不到對應的建立 job
 * @throws {Error} 'JOB_NOT_FAILED' 若該 job 狀態不是 failed
 */
export async function retryConversationCreation(userId, characterId) {
  validateUserId(userId);

  if (!characterId) {
    throw new Error('MISSING_CHARACTER_ID');
  }

  const job = await conversationCreationJobRepository.findByKey(userId, characterId);

  if (!job) {
    console.log(`  ⚠️  [conversationService] job 不存在，無需清除: ${userId}:${characterId}`);
    throw new Error('NO_FAILED_JOB');
  }

  if (job.status !== 'failed') {
    console.log(`  ⚠️  [conversationService] job 狀態不是 failed (status=${job.status})，無法重試`);
    throw new Error('JOB_NOT_FAILED');
  }

  // 清除失敗 job，允許重新開始
  console.log(`  🔄 [conversationService] 清除失敗 job，允許重試: ${userId}:${characterId}`);
  await conversationCreationJobRepository.delete(userId, characterId);

  return {
    success: true,
    message: '失敗狀態已清除，請重新開啟聊天室'
  };
}
