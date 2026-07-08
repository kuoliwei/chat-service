// 除錯工具：以 JSON 輸出某聊天室的所有訊息（含 summaryId 配對資訊）
// 用法: node scripts/dump-messages.js conv_xxxxxxxxx
// 供 list-summaries.ps1 呼叫，用於摘要與訊息的配對顯示
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const conversationId = process.argv[2];
if (!conversationId) {
  console.error('Usage: node scripts/dump-messages.js <conversationId>');
  process.exit(1);
}

const prisma = new PrismaClient();

const messages = await prisma.message.findMany({
  where: { conversationId },
  select: {
    id: true,
    role: true,
    summarized: true,
    summaryId: true,
    text: true,
    createdAt: true,
  },
  orderBy: { createdAt: 'asc' },
});

console.log(JSON.stringify(messages));
await prisma.$disconnect();
