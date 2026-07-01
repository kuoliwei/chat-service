/**
 * Service Client - 內部服務間通訊
 * 負責調用其他微服務的 API
 */

import axios from 'axios';
import { config } from '../config/index.js';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8000';

class ServiceClient {
  /**
   * 驗證角色是否存在
   * @param {string} characterId - 角色 ID
   * @param {string} userId - 用戶 ID（用於驗證權限）
   * @returns {Promise<Object>} 角色數據
   */
  async getCharacter(characterId, userId) {
    try {
      console.log(`📡 [ServiceClient] 驗證角色: characterId=${characterId}, userId=${userId}`);

      const response = await axios.get(
        `${GATEWAY_URL}/internal/characters/${characterId}`,
        {
          timeout: 5000,
          headers: {
            'x-user-id': userId,  // 🆕 傳遞用戶身份
          },
        }
      );

      if (response.status === 200 && response.data.status === 'success') {
        console.log(`✅ [ServiceClient] 角色驗證成功: ${characterId}`);
        return response.data.data;
      } else {
        console.warn(`⚠️ [ServiceClient] 角色不存在: ${characterId}`);
        throw new Error('CHARACTER_NOT_FOUND');
      }
    } catch (error) {
      if (error.response?.status === 404 || error.message === 'CHARACTER_NOT_FOUND') {
        console.warn(`⚠️ [ServiceClient] 角色未找到: ${characterId}`);
        throw new Error('CHARACTER_NOT_FOUND');
      }

      if (error.response?.status === 403) {
        console.warn(`⚠️ [ServiceClient] 無權限訪問角色: ${characterId}`);
        throw new Error('FORBIDDEN');
      }

      console.error(`❌ [ServiceClient] 呼叫 character-service 失敗:`, error.message);
      throw new Error(`SERVICE_ERROR: ${error.message}`);
    }
  }

  /**
   * 獲取用戶信息
   * @param {string} userId - 用戶 ID
   * @returns {Promise<Object>} 用戶數據
   */
  async getUser(userId) {
    try {
      console.log(`📡 [ServiceClient] 獲取用戶: userId=${userId}`);

      const response = await axios.get(
        `${GATEWAY_URL}/internal/users/${userId}`,
        { timeout: 5000 }
      );

      if (response.status === 200 && response.data.status === 'success') {
        console.log(`✅ [ServiceClient] 用戶獲取成功: ${userId}`);
        return response.data.data;
      } else {
        throw new Error('USER_NOT_FOUND');
      }
    } catch (error) {
      console.error(`❌ [ServiceClient] 呼叫 user-service 失敗:`, error.message);
      throw new Error(`SERVICE_ERROR: ${error.message}`);
    }
  }

  /**
   * 初始化聊天室的 RAG 資料
   * @param {Object} data - RAG 初始化資料
   * @param {string} data.conversation_id - 聊天室 ID
   * @param {string} data.character_id - 角色 ID
   * @param {string} data.background - 角色背景文本
   * @param {Array<string>} data.fewshots - Few-Shot 範例列表
   * @returns {Promise<Object>} 初始化結果
   */
  async initializeRAG(data) {
    try {
      console.log(`📡 [ServiceClient] 初始化 RAG: conversationId=${data.conversation_id}`);
      console.log(`  ├─ 發起非同步初始化（ai-service 背景執行）`);

      const response = await axios.post(
        `${GATEWAY_URL}/internal/rag/conversations/initialize`,
        data
      );

      // 🆕 接受新的狀態碼：202 Accepted + status: 'accepted'（非同步模式）
      // 或舊的狀態碼：200 OK + status: 'success'（同步模式，已廢棄）
      if ((response.status === 202 && response.data.status === 'accepted') ||
          (response.status === 200 && response.data.status === 'success')) {
        console.log(`✅ [ServiceClient] RAG 初始化請求已發送，ai-service 背景進行中`);
        return response.data;
      } else {
        throw new Error(`Unexpected response: status=${response.status}, data.status=${response.data.status}`);
      }
    } catch (error) {
      console.error(`❌ [ServiceClient] 呼叫 ai-service RAG 初始化失敗:`, error.message);
      throw new Error(`SERVICE_ERROR: ${error.message}`);
    }
  }

  /**
   * 清理聊天室的 RAG 資料
   * @param {string} conversationId - 聊天室 ID
   * @returns {Promise<Object>} 清理結果
   */
  async cleanupRAG(conversationId) {
    try {
      console.log(`📡 [ServiceClient] 清理 RAG: conversationId=${conversationId}`);

      const timeout = config.ai?.timeouts?.cleanupRAG || 10000;

      const response = await axios.delete(
        `${GATEWAY_URL}/internal/rag/conversations/${conversationId}`,
        { timeout }
      );

      if (response.status === 200 && response.data.status === 'success') {
        console.log(`✅ [ServiceClient] RAG 清理成功: ${conversationId}`);
        return response.data;
      } else {
        throw new Error('RAG_CLEANUP_FAILED');
      }
    } catch (error) {
      console.error(`❌ [ServiceClient] 呼叫 ai-service RAG 清理失敗:`, error.message);
      throw new Error(`SERVICE_ERROR: ${error.message}`);
    }
  }

  /**
   * 生成聊天回應
   * @param {Object} data - 生成請求資料
   * @param {string} data.conversation_id - 聊天室 ID
   * @param {Object} data.character_info - 角色資訊
   * @param {Array} data.conversation_history - 聊天歷史
   * @returns {Promise<Object>} 生成結果 {status, message}
   */
  async generateResponse(data) {
    try {
      console.log(`📡 [ServiceClient] 生成回應: conversationId=${data.conversation_id}`);

      const timeout = config.ai?.timeouts?.generateResponse || 30000;

      const response = await axios.post(
        `${GATEWAY_URL}/internal/chat/generate`,
        data,
        { timeout }
      );

      if (response.status === 200 && response.data.status === 'success') {
        console.log(`✅ [ServiceClient] 回應生成成功`);
        return response.data;
      } else {
        throw new Error('GENERATE_RESPONSE_FAILED');
      }
    } catch (error) {
      console.error(`❌ [ServiceClient] 呼叫 ai-service 生成回應失敗:`, error.message);
      throw new Error(`SERVICE_ERROR: ${error.message}`);
    }
  }

  /**
   * 生成對話摘要
   * @param {string} conversationId - 聊天室 ID
   * @param {string} prompt - 摘要提示詞
   * @returns {Promise<string>} 生成的摘要文本
   */
  async generateSummary(conversationId, prompt) {
    try {
      console.log(`📡 [ServiceClient] 生成摘要: conversationId=${conversationId}`);

      const timeout = config.ai?.timeouts?.generateResponse || 30000;

      const response = await axios.post(
        `${GATEWAY_URL}/internal/chat/summary`,
        {
          conversation_id: conversationId,
          prompt: prompt
        },
        { timeout }
      );

      if (response.status === 200 && response.data.status === 'success') {
        console.log(`✅ [ServiceClient] 摘要生成成功`);
        return response.data.data.summary;
      } else {
        throw new Error('SUMMARY_GENERATION_FAILED');
      }
    } catch (error) {
      console.error(`❌ [ServiceClient] 呼叫 ai-service 生成摘要失敗:`, error.message);
      throw new Error(`SERVICE_ERROR: ${error.message}`);
    }
  }

  /**
   * 將摘要存入向量資料庫
   * @param {string} conversationId - 聊天室 ID
   * @param {string} summary - 摘要文本
   * @returns {Promise<Object>} 存儲結果
   */
  async addSummary(conversationId, summary) {
    try {
      console.log(`📡 [ServiceClient] 存入摘要: conversationId=${conversationId}`);

      const timeout = config.ai?.timeouts?.generateResponse || 30000;

      const response = await axios.post(
        `${GATEWAY_URL}/internal/rag/summaries`,
        {
          conversation_id: conversationId,
          summary: summary
        },
        { timeout }
      );

      if (response.status === 200 && response.data.status === 'success') {
        console.log(`✅ [ServiceClient] 摘要存儲成功`);
        return response.data;
      } else {
        throw new Error('SUMMARY_STORAGE_FAILED');
      }
    } catch (error) {
      console.error(`❌ [ServiceClient] 呼叫 ai-service 存儲摘要失敗:`, error.message);
      throw new Error(`SERVICE_ERROR: ${error.message}`);
    }
  }

  /**
   * 查詢 RAG 初始化狀態
   * @param {string} conversationId - 聊天室 ID
   * @returns {Promise<string>} 狀態 'pending' | 'ready' | 'failed'
   */
  async checkRAGStatus(conversationId) {
    try {
      console.log(`  📡 [ServiceClient] 查詢 RAG 狀態: conversationId=${conversationId}`);

      const timeout = 5000;  // 狀態查詢要快

      const response = await axios.get(
        `${GATEWAY_URL}/internal/rag/conversations/${conversationId}/status`,
        { timeout }
      );

      if (response.status === 200) {
        const status = response.data.status;
        console.log(`  ├─ ✅ RAG 狀態: ${status}`);
        if (status === 'failed') {
          console.log(`  ├─ 錯誤: ${response.data.error || 'unknown'}`);
        }
        return status;
      } else {
        throw new Error('RAG_STATUS_CHECK_FAILED');
      }
    } catch (error) {
      console.error(`  ├─ ❌ 查詢失敗: ${error.message}`);
      throw new Error(`SERVICE_ERROR: ${error.message}`);
    }
  }
}

export const serviceClient = new ServiceClient();
