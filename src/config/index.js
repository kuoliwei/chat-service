import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, 'config.json');

let config;

try {
  const rawConfig = fs.readFileSync(configPath, 'utf-8');
  config = JSON.parse(rawConfig);
  console.log('✅ [config] 配置文件已加載');
} catch (error) {
  console.error('❌ [config] 無法讀取配置文件:', error.message);
  process.exit(1);
}

export { config };
