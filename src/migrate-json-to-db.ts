import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const dataDir = path.join(process.cwd(), 'data');
// 開発環境と本番環境でファイル名が異なるため、両方チェックするか、引数で受け取る
// ここでは簡易的に .env.development の kintai-dev.json と kintai.json 両方探します
const files = ['kintai-dev.json', 'kintai.json'];

async function main() {
  console.log('Starting migration from JSON to DB...');

  for (const fileName of files) {
    const filePath = path.join(dataDir, fileName);
    if (!fs.existsSync(filePath)) {
      console.log(`Skipping ${fileName}: File not found.`);
      continue;
    }

    console.log(`Processing ${fileName}...`);
    try {
        const jsonData = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(jsonData);
    
        if (!data.discordUser) {
          console.log(`Skipping ${fileName}: No discordUser found (Single user mode data). Cannot migrate without User ID.`);
          // ※必要であればダミーユーザーIDで登録する処理を入れることも可能ですが、
          // Discordログイン前提の設計なので、discordUserがないデータは移行対象外とします。
          continue;
        }
    
        const discordUser = data.discordUser;
    
        // 1. ユーザー作成 (Upsert)
        const user = await prisma.user.upsert({
          where: { id: discordUser.id },
          update: {
            username: discordUser.username,
            avatar: discordUser.avatar,
            status: data.currentUserStatus,
          },
          create: {
            id: discordUser.id,
            username: discordUser.username,
            avatar: discordUser.avatar,
            status: data.currentUserStatus,
          },
        });
        console.log(`Upserted User: ${user.username} (${user.id})`);
    
        // 2. ログ移行
        if (data.attendanceLog && Array.isArray(data.attendanceLog)) {
          console.log(`Found ${data.attendanceLog.length} logs.`);
          
          let newLogCount = 0;
          for (const log of data.attendanceLog) {
            // 重複チェック: 同じユーザー、同じタイプ、同じ時刻のログがあればスキップ
            const exists = await prisma.attendanceLog.findFirst({
              where: {
                userId: user.id,
                type: log.type,
                timestamp: new Date(log.timestamp),
              },
            });
    
            if (!exists) {
              await prisma.attendanceLog.create({
                data: {
                  userId: user.id,
                  type: log.type,
                  timestamp: new Date(log.timestamp),
                },
              });
              newLogCount++;
            }
          }
          console.log(`Imported ${newLogCount} new logs for ${user.username}.`);
        }
    } catch (e) {
        console.error(`Error processing ${fileName}:`, e);
    }
  }

  console.log('Migration completed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
