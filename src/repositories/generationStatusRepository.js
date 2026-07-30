import { prisma } from '../lib/prisma.js';
import { config } from '../config/index.js';
import { conversationRepository } from './conversationRepository.js';

// ========== AI 生成狀態 / 並行生成鎖 ==========
//
// ⚠️ 這個檔案雖然叫 repository，但它不是單純的 CRUD——`tryAcquireLock`／`releaseLock`
// 是一套**並行控制協定**，語意上比旁邊那些 findFirst/create 微妙得多（競態、殭屍鎖逾時、
// 回合身分）。這也是它從 conversationRepository.js 抽出來獨立成檔的原因：
// 種類不同的東西不該混在一起，這裡的每一行都需要被當成鎖來讀，而不是當成查詢。
//
// 狀態存在 Conversation 表的 generationStatus 等 6 個欄位，`generating` 同時兼作鎖。
// config.persistence.enableGenerationStatus === false 時改回進程內記憶體 Map（等同
// 持久化之前的舊版行為），僅供本機測試，服務重啟即遺失所有生成中/剛完成的狀態，
// 不要在正式環境關閉——見 config.txt 說明。
const memoryGenerationStatus = new Map();

export const generationStatusRepository = {
  // 讀取目前的生成狀態。enabled 時直接從已抓到的 conversation 物件取欄位（不額外查詢），
  // disabled 時從記憶體 Map 讀。回傳 null 代表目前沒有生成狀態記錄。
  get(conversation) {
    if (!config.persistence?.enableGenerationStatus) {
      const record = memoryGenerationStatus.get(conversation.id);
      // status 欄位為空即視為「沒有生成狀態記錄」，與 DB 分支的判斷規則一致
      // （releaseLock/reset 會把 status 設回 null 但不刪除整筆記錄，靠這裡統一收斂語意）
      return record?.status ? record : null;
    }
    if (!conversation.generationStatus) {
      return null;
    }
    return {
      status: conversation.generationStatus,
      error: conversation.generationError,
      tempUserId: conversation.generationTempUserId,
      userMessageId: conversation.generationUserMessageId,
      assistantMessageId: conversation.generationAssistantMessageId,
      updatedAt: conversation.generationUpdatedAt,
    };
  },

  // 原子性搶鎖：目前沒有生成中、或生成中但已超過殭屍鎖時限 → 上鎖並回傳 true；
  // 否則回傳 false（別人正持有有效的鎖）。
  // enabled 時用 DB updateMany 的 where 條件做「檢查後更新」保證原子性；
  // disabled 時利用 Node 單執行緒特性，同步檢查後立刻寫入 Map，中間不 await，
  // 天然不會被其他請求插隊（與持久化之前的舊版邏輯相同）。
  //
  // 🔑 【回合身分】上鎖 = 「本回合開始」的唯一原子性時間點，因此這裡必須順手做兩件事：
  //   1. 寫入本回合的 tempUserId（前端樂觀更新的臨時訊息 ID）
  //   2. 把 userMessageId / assistantMessageId 清成 null
  // 否則這三個欄位會一路留著「上一回合」setCompleted 寫進去的值（只有 setCompleted
  // 會寫它們），使 generating 狀態變成「狀態碼是新的、訊息 ID 是舊的」的混合體。
  // 前端在 POST 尚未抵達本行之前就已開始輪詢，讀到那種混合狀態會誤把剛送出的訊息
  // 換成上一回合的舊訊息並停止輪詢——畫面上兩個氣泡一閃消失。
  // 搶鎖失敗時不得修改任何欄位（否則會污染別人正在進行的回合）。
  async tryAcquireLock(conversationId, staleLimitMs, { tempUserId } = {}) {
    if (!config.persistence?.enableGenerationStatus) {
      const existing = memoryGenerationStatus.get(conversationId);
      if (existing && existing.status === 'generating') {
        const lockAgeMs = Date.now() - (existing.updatedAt?.getTime() || 0);
        if (lockAgeMs < staleLimitMs) {
          return false;
        }
        console.warn(`⚠️  [generationStatusRepository] 偵測到殭屍鎖: 聊天室 ${conversationId} 的 generating 狀態已掛 ${Math.round(lockAgeMs / 1000)} 秒，視為失效並放行`);
      }
      // 整筆覆寫（不 spread existing）：與 DB 分支一樣達成「清空上一回合訊息 ID」的效果
      memoryGenerationStatus.set(conversationId, {
        status: 'generating',
        error: null,
        tempUserId: tempUserId || null,
        userMessageId: null,
        assistantMessageId: null,
        updatedAt: new Date(),
      });
      return true;
    }

    const staleBeforeTimestamp = new Date(Date.now() - staleLimitMs);
    const result = await prisma.conversation.updateMany({
      where: {
        id: conversationId,
        OR: [
          { generationStatus: { not: 'generating' } },
          { generationStatus: null },
          { generationUpdatedAt: { lt: staleBeforeTimestamp } },
        ],
      },
      data: {
        generationStatus: 'generating',
        generationError: null,
        generationTempUserId: tempUserId || null,
        generationUserMessageId: null,
        generationAssistantMessageId: null,
        generationUpdatedAt: new Date(),
      },
    });
    return result.count > 0;
  },

  // 釋放鎖（只清 generationStatus，不動其他欄位）——用於上鎖後、進入背景生成前，
  // 前置流程失敗時的緊急解鎖。
  async releaseLock(conversationId) {
    if (!config.persistence?.enableGenerationStatus) {
      const existing = memoryGenerationStatus.get(conversationId);
      if (existing) {
        memoryGenerationStatus.set(conversationId, { ...existing, status: null });
      }
      return;
    }
    await conversationRepository.update(conversationId, { generationStatus: null });
  },

  async setCompleted(conversationId, { tempUserId, userMessageId, assistantMessageId }) {
    if (!config.persistence?.enableGenerationStatus) {
      memoryGenerationStatus.set(conversationId, {
        status: 'completed',
        error: null,
        tempUserId: tempUserId || null,
        userMessageId,
        assistantMessageId,
        updatedAt: new Date(),
      });
      return;
    }
    await conversationRepository.update(conversationId, {
      generationStatus: 'completed',
      generationError: null,
      generationTempUserId: tempUserId || null,
      generationUserMessageId: userMessageId,
      generationAssistantMessageId: assistantMessageId,
      generationUpdatedAt: new Date(),
    });
  },

  // ⚠️ 【不要清 tempUserId】本回合的 tempUserId 已由 tryAcquireLock 在上鎖時寫入，
  // setFailed 必須原封保留它——前端靠這個欄位判斷「這個 failed 屬於哪一回合」，
  // 才能立刻把佔位符換成失敗氣泡。若為了「清乾淨」而在這裡把它設成 null，
  // 前端的回合守門會擋掉真實失敗，使用者要等滿 120 秒輪詢超時才看得到失敗訊息。
  // （2026-07-30 已補上對應的單元測試守住這個行為，見 conversationRepository.test.js）
  async setFailed(conversationId, errorMessage) {
    if (!config.persistence?.enableGenerationStatus) {
      const existing = memoryGenerationStatus.get(conversationId) || {};
      memoryGenerationStatus.set(conversationId, {
        ...existing,
        status: 'failed',
        error: errorMessage,
        updatedAt: new Date(),
      });
      return;
    }
    await conversationRepository.update(conversationId, {
      generationStatus: 'failed',
      generationError: errorMessage,
      generationUpdatedAt: new Date(),
    });
  },

  // 完整重置（清 status/error/tempUserId/userMessageId/assistantMessageId，
  // 保留 updatedAt——與原本兩處呼叫點的欄位範圍一致）。
  // 用於：訊息回溯刪除後清除舊生成狀態、使用者主動清除生成狀態。
  async reset(conversationId) {
    if (!config.persistence?.enableGenerationStatus) {
      const existing = memoryGenerationStatus.get(conversationId);
      if (existing) {
        memoryGenerationStatus.set(conversationId, {
          ...existing,
          status: null,
          error: null,
          tempUserId: null,
          userMessageId: null,
          assistantMessageId: null,
        });
      }
      return;
    }
    await conversationRepository.update(conversationId, {
      generationStatus: null,
      generationError: null,
      generationTempUserId: null,
      generationUserMessageId: null,
      generationAssistantMessageId: null,
    });
  },
};
