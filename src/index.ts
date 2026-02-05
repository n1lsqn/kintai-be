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
const listenHost = '0.0.0.0'; // Always listen on all interfaces in Docker
const publicHost = process.env.PUBLIC_HOST || 'localhost'; // Public facing host for redirects
const resetHour = parseInt(process.env.RESET_HOUR || '5', 10); // 日替わり時刻を午前5時に設定

console.log(`--- ENVIRONMENT: ${process.env.NODE_ENV || 'development'} ---`);
console.log(`Loading config from: ${envFile}`);
console.log(`PORT: ${port}`);
console.log(`------------------------------`);

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = `http://${publicHost}/auth/discord/callback`;

// Prisma Client Initialization
const prisma = new PrismaClient();

// In-memory store for login states (state -> userId)
const loginStates = new Map<string, string>();

console.log(`*** IMPORTANT ***`);
console.log(`Discord Redirect URI: ${REDIRECT_URI}`);
console.log(`Please ensure this exact URL is added to your Discord Developer Portal > OAuth2 > Redirects`);
console.log(`*****************`);

app.use(cors());
app.use(express.json());

// --- Helper Functions ---
import { getLogicalDate, calculateLogsDuration } from './work-hours-calculator';



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
    const state = req.query.state as string;
    if (!state) {
        res.status(400).json({ error: 'State is required' });
        return;
    }

    const scope = 'identify';
    const authUrl = `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scope}&state=${state}`;
    
    // Return the URL for the frontend to open
    res.json({ url: authUrl });
});

// Auth: Callback
app.get('/auth/discord/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
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
                code: code,
                redirect_uri: REDIRECT_URI,
            }),
        });

        interface TokenResponse {
            access_token: string;
            token_type: string;
            expires_in: number;
            refresh_token: string;
            scope: string;
        }
        const tokenData = await tokenResponse.json() as TokenResponse;
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
            },
            create: {
                id: userData.id,
                username: userData.username,
                avatar: userData.avatar,
                status: 'unregistered'
            }
        });

        // Store the successful login for this specific state
        if (state) {
            loginStates.set(state, userData.id);
            setTimeout(() => loginStates.delete(state), 5 * 60 * 1000);
        }

        res.send(
            `
            <html>
                <body style="background-color: #111827; color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif;">
                    <h1>Login Successful</h1>
                    <p>You can close this window now.</p>
                    <script>
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

// ログイン結果確認API: stateに紐づくユーザー情報を返す
app.get('/auth/me/:state', async (req: Request, res: Response) => {
    const state = Array.isArray(req.params.state) ? req.params.state[0] : req.params.state;
    const userId = loginStates.get(state);
    
    if (!userId) {
        res.status(404).json({ message: 'Login not found or expired' });
        return;
    }

    try {
        const user = await prisma.user.findUnique({
            where: { id: userId }
        });
        if (user) {
            loginStates.delete(state);
            res.json(user);
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Database error' });
    }
});


// Middleware to extract userId from headers or query
const getUserId = (req: Request): string | undefined => {
    const id = req.headers['x-user-id'] || req.query.userId;
    if (Array.isArray(id)) return id[0] as string;
    return id as string | undefined;
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

  await prisma.user.update({
      where: { id: userId },
      data: { status: newStatus }
  });

  res.status(200).json({ message, newStatus });
});

// Discord Notification Logic
async function sendDiscordDailyReport(userId: string) {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    const channelId = process.env.DISCORD_NOTIFY_CHANNEL_ID;

    if (!botToken || !channelId) {
        console.warn('Discord notification not configured. Skipping.');
        return;
    }

    try {
        const now = new Date();
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { attendanceLogs: { orderBy: { timestamp: 'asc' } } }
        });

        if (!user) return;

        const dailyTotals = calculateLogsDuration(user.attendanceLogs, resetHour);
        const logicalDate = getLogicalDate(now, resetHour);
        const dateKey = logicalDate.toISOString().split('T')[0];
        
        let todayMs = dailyTotals[dateKey] || 0;

        const hours = Math.floor(todayMs / (1000 * 60 * 60));
        const minutes = Math.floor((todayMs / (1000 * 60)) % 60);
        const messageContent = `📊 **自動日報**\n**${user.username}** さんが作業を終了しました。\n本日の合計作業時間: **${hours}時間 ${minutes}分**`;

        await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bot ${botToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ content: messageContent }),
        });
        console.log(`Notification sent for user ${userId}`);
    } catch (e) {
        console.error('Failed to send automatic notification:', e);
    }
}

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
    
    sendDiscordDailyReport(userId);

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
                orderBy: { timestamp: 'asc' }
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

app.get('/summary', async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
        res.status(400).json({ message: 'User ID is required' });
        return;
    }

    try {
        const logs = await prisma.attendanceLog.findMany({
            where: { userId: userId },
            orderBy: { timestamp: 'asc' }
        });

        const dailyTotals = calculateLogsDuration(logs, resetHour);
        
        const summary = {
            daily: [] as { date: string; totalMs: number }[],
            weekly: [] as { weekStart: string; totalMs: number }[],
            monthly: [] as { month: string; totalMs: number }[],
            total: 0
        };

        summary.daily = Object.entries(dailyTotals)
            .map(([date, totalMs]) => ({ date, totalMs }))
            .sort((a, b) => b.date.localeCompare(a.date));

        const weeklyMap: { [weekStart: string]: number } = {};
        const monthlyMap: { [month: string]: number } = {};

        Object.entries(dailyTotals).forEach(([dateStr, ms]) => {
            summary.total += ms;
            const monthKey = dateStr.substring(0, 7);
            if (!monthlyMap[monthKey]) monthlyMap[monthKey] = 0;
            monthlyMap[monthKey] += ms;

            const date = new Date(dateStr);
            const day = date.getDay();
            const diff = date.getDate() - day + (day === 0 ? -6 : 1);
            const monday = new Date(date.setDate(diff));
            const weekKey = monday.toISOString().split('T')[0];
            
            if (!weeklyMap[weekKey]) weeklyMap[weekKey] = 0;
            weeklyMap[weekKey] += ms;
        });

        summary.weekly = Object.entries(weeklyMap)
            .map(([weekStart, totalMs]) => ({ weekStart, totalMs }))
            .sort((a, b) => b.weekStart.localeCompare(a.weekStart));

        summary.monthly = Object.entries(monthlyMap)
            .map(([month, totalMs]) => ({ month, totalMs }))
            .sort((a, b) => b.month.localeCompare(a.month));

        res.json(summary);

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to calculate summary' });
    }
});

app.post('/notify', async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
        res.status(400).json({ message: 'User ID is required' });
        return;
    }
    try {
        await sendDiscordDailyReport(userId);
        res.json({ message: 'Notification sent!' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to send notification' });
    }
});

app.listen(port, listenHost, () => {
  console.log(`Server is running at http://${listenHost}:${port}`);
});