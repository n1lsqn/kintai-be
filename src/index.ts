import express, { Request, Response } from 'express';
import path from 'path';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

// NODE_ENVに応じて読み込む.envファイルを切り替え
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ 
    path: path.resolve(process.cwd(), envFile),
    override: true // docker-composeなどの環境変数よりも.envファイルを優先する
});

const app = express();
const port = parseInt(process.env.PORT || '9393', 10);
const host = process.env.HOST || '0.0.0.0'; // Public host name (e.g. localhost)
const listenHost = '0.0.0.0'; // Always listen on all interfaces in Docker
const publicHost = process.env.PUBLIC_HOST || 'localhost'; // Public facing host for redirects
const resetHour = parseInt(process.env.RESET_HOUR || '5', 10); // 日替わり時刻を午前5時に設定

console.log(`--- ENVIRONMENT: ${process.env.NODE_ENV || 'development'} ---`);
console.log(`Loading config from: ${envFile}`);
console.log(`PORT: ${port}`);
console.log(`------------------------------`);

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = `http://${publicHost}:${port}/auth/discord/callback`;

// Prisma Client Initialization
const prisma = new PrismaClient();

console.log(`*** IMPORTANT ***`);
console.log(`Discord Redirect URI: ${REDIRECT_URI}`);
console.log(`Please ensure this exact URL is added to your Discord Developer Portal > OAuth2 > Redirects`);
console.log(`*****************`);

app.use(cors());
app.use(express.json());

// --- Helper Functions ---

// 論理的な日付を取得するヘルパー関数
function getLogicalDate(timestamp: Date, resetHour: number): Date {
  const date = new Date(timestamp);
  // もし現在の時刻がリセット時刻より前なら、日付を1日戻す
  if (date.getHours() < resetHour) {
    date.setDate(date.getDate() - 1);
  }
  date.setHours(0, 0, 0, 0); // 時刻は0時に揃える
  return date;
}

// 共通の日付リセット処理 (ユーザーごと)
async function checkAndResetStateIfNewDay(userId: string, currentTimestamp: Date, resetHour: number): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;

    // 最新のログを取得
    const lastLog = await prisma.attendanceLog.findFirst({
        where: { userId: userId },
        orderBy: { timestamp: 'desc' }
    });

    if (lastLog) {
        const lastLogDateObj = new Date(lastLog.timestamp);
        const logicalLastLogDate = getLogicalDate(lastLogDateObj, resetHour);
        const logicalCurrentDate = getLogicalDate(currentTimestamp, resetHour);

        // 論理的な日付が変わった場合
        if (logicalLastLogDate.toDateString() !== logicalCurrentDate.toDateString()) {
            const lastStatus = user.status;
            
            // 前日の最終状態が「稼働中」だった場合
            if (lastStatus === 'working' || lastStatus === 'on_break') {
                console.log(`User ${userId}: New day detected. Auto work start. (Reset hour: ${resetHour})`);
                
                // 新しい日の開始時刻を計算（リセット時刻）
                const newDayStartTime = new Date(currentTimestamp);
                newDayStartTime.setHours(resetHour, 0, 0, 0);

                // ログに自動出勤記録を追加
                await prisma.attendanceLog.create({
                    data: {
                        userId: userId,
                        type: 'work_start',
                        timestamp: newDayStartTime
                    }
                });
                // ステータスを working に更新
                await prisma.user.update({
                    where: { id: userId },
                    data: { status: 'working' }
                });

            } else {
                // 前日が正常に退勤済みだった場合、ステータスをリセット
                console.log(`User ${userId}: New day detected. Reset status. (Reset hour: ${resetHour})`);
                if (user.status !== 'unregistered') {
                    await prisma.user.update({
                        where: { id: userId },
                        data: { status: 'unregistered' }
                    });
                }
            }
        }
    }
}

// === API エンドポイント ===

// Auth: Initiate Discord Login
app.get('/auth/discord', (req: Request, res: Response) => {
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
        res.status(500).json({ error: 'Discord credentials not configured on server.' });
        return;
    }
    const scope = 'identify';
    const state = 'random_state_string'; // Simplified for this prototype
    const authUrl = `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scope}&state=${state}`;
    
    // Return the URL for the frontend to open
    res.json({ url: authUrl });
});

// Auth: Callback
app.get('/auth/discord/callback', async (req: Request, res: Response) => {
    const { code } = req.query;
    if (!code) {
        res.status(400).send('No code returned');
        return;
    }

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID!,
                client_secret: DISCORD_CLIENT_SECRET!,
                grant_type: 'authorization_code',
                code: code.toString(),
                redirect_uri: REDIRECT_URI,
            }),
        });

        const tokenData: any = await tokenResponse.json();
        if (!tokenResponse.ok) {
            console.error('Token Error:', tokenData);
            throw new Error('Failed to get token');
        }

        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: {
                authorization: `Bearer ${tokenData.access_token}`,
            },
        });
        
        const userData = await userResponse.json();
        
        // Save user to DB (Upsert)
        await prisma.user.upsert({
            where: { id: userData.id },
            update: {
                username: userData.username,
                avatar: userData.avatar,
                // Do NOT update status here to preserve state
            },
            create: {
                id: userData.id,
                username: userData.username,
                avatar: userData.avatar,
                status: 'unregistered'
            }
        });

        // 簡易的にHTMLでユーザーIDをフロントエンドに渡す仕組み
        // 実際にはJWTなどをCookieにセットするか、カスタムプロトコルスキームを使うのが良い
        // 今回はlocalStorageに保存させるためのスクリプトを埋め込む
        res.send(`
            <html>
                <body style="background-color: #111827; color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif;">
                    <h1>Login Successful</h1>
                    <p>Redirecting...</p>
                    <script>
                        // Send message to parent window (if opened as popup)
                        if (window.opener) {
                            window.opener.postMessage({ type: 'LOGIN_SUCCESS', userId: '${userData.id}' }, '*');
                        }
                        // For Tauri shell open, we can't easily communicate back.
                        // Ideally, we would use a deep link.
                        // For now, assume the user closes this and the app polls /status with userId? No, frontend doesn't know ID yet.
                        
                        // Workaround: Frontend needs to know WHO logged in.
                        // We will rely on the "Latest Logged In User" for this simple app, 
                        // OR we require the frontend to poll an endpoint that returns "Who just logged in?"
                        // For simplicity in this step, we just close.
                        setTimeout(() => window.close(), 1000);
                    </script>
                </body>
            </html>
        `);
    } catch (e) {
        console.error(e);
        res.status(500).send('Login failed');
    }
});

// 暫定API: 最後にログイン（更新）されたユーザーを返す
// フロントエンドが自分のIDを知るためのエンドポイント
app.get('/auth/me/latest', async (req: Request, res: Response) => {
    try {
        const user = await prisma.user.findFirst({
            orderBy: { updatedAt: 'desc' }
        });
        if (user) {
            res.json(user);
        } else {
            res.status(404).json({ message: 'No users found' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});


// Middleware to extract userId from headers or query
const getUserId = (req: Request): string | undefined => {
    const id = req.headers['x-user-id'] as string || req.query.userId as string;
    return id;
};

app.post('/stamp', async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) {
      res.status(400).json({ message: 'User ID is required' });
      return;
  }

  const now = new Date();
  await checkAndResetStateIfNewDay(userId, now, resetHour);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
      res.status(404).json({ message: 'User not found' });
      return;
  }

  let message = '';
  let newStatus = user.status;
  
  switch (user.status) {
    case 'unregistered':
      newStatus = 'working';
      message = '出勤しました。';
      await prisma.attendanceLog.create({
          data: { userId, type: 'work_start', timestamp: now }
      });
      break;
    case 'working':
      newStatus = 'on_break';
      message = '休憩を開始しました。';
      await prisma.attendanceLog.create({
          data: { userId, type: 'break_start', timestamp: now }
      });
      break;
    case 'on_break':
      newStatus = 'working';
      message = '休憩を終了しました。';
      await prisma.attendanceLog.create({
          data: { userId, type: 'break_end', timestamp: now }
      });
      break;
  }

  // Update User Status
  await prisma.user.update({
      where: { id: userId },
      data: { status: newStatus }
  });

  res.status(200).json({ message, newStatus });
});

app.post('/clock_out', async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) {
      res.status(400).json({ message: 'User ID is required' });
      return;
  }

  const now = new Date();
  await checkAndResetStateIfNewDay(userId, now, resetHour);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
      res.status(404).json({ message: 'User not found' });
      return;
  }

  if (user.status === 'working' || user.status === 'on_break') {
    await prisma.user.update({
        where: { id: userId },
        data: { status: 'unregistered' }
    });
    await prisma.attendanceLog.create({
        data: { userId, type: 'work_end', timestamp: now }
    });
    res.status(200).json({ message: '退勤しました。', newStatus: 'unregistered' });
  } else {
    res.status(400).json({ message: 'まだ出勤していません。' });
  }
});

app.get('/status', async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
        res.status(400).json({ message: 'User ID is required' });
        return;
    }

    const now = new Date();
    await checkAndResetStateIfNewDay(userId, now, resetHour);

    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
            attendanceLogs: {
                orderBy: { timestamp: 'asc' } // Oldest first for logs list? Or newest? Frontend reverses it.
            }
        }
    });

    if (!user) {
        res.status(404).json({ message: 'User not found' });
        return;
    }
    
    res.status(200).json({
        currentStatus: user.status,
        attendanceLog: user.attendanceLogs.map(log => ({
            type: log.type,
            timestamp: log.timestamp.toISOString()
        })),
        discordUser: {
            id: user.id,
            username: user.username,
            avatar: user.avatar
        },
        lastLogTimestamp: user.attendanceLogs.length > 0 
            ? user.attendanceLogs[user.attendanceLogs.length - 1].timestamp.toISOString() 
            : null
    });
});

app.listen(port, listenHost, () => {
  console.log(`Server is running at http://${listenHost}:${port}`);
});
