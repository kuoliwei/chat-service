/**
 * Service Client - 內部服務間通訊
 * 負責調用其他微服務的 API
 */

import axios from 'axios';

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
}

export const serviceClient = new ServiceClient();
