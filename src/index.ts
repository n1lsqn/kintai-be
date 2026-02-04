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
        console.error(e);
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

        // Note: clock_out happens AFTER the log is added in this implementation, 
        // so todayMs already includes the session that just ended.
        // If status was working just before, it's now unregistered.

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
    
    // 自動送信
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

// Helper to format duration
function calculateLogsDuration(logs: any[], resetHour: number): { [date: string]: number } {
    const dailyTotals: { [date: string]: number } = {};

    let lastStartTime: number | null = null;

    // ログは古い順 (asc) であることを前提とする
    for (const log of logs) {
        const time = new Date(log.timestamp).getTime();
        const dateObj = new Date(log.timestamp);
        
        // Calculate logical date string (YYYY-MM-DD)
        const logicalDate = getLogicalDate(dateObj, resetHour);
        const dateKey = logicalDate.toISOString().split('T')[0];

        if (!dailyTotals[dateKey]) dailyTotals[dateKey] = 0;

        if (log.type === 'work_start' || log.type === 'break_end') {
            if (lastStartTime === null) {
                lastStartTime = time;
            }
        } else if (log.type === 'work_end' || log.type === 'break_start') {
            if (lastStartTime !== null) {
                // 開始時刻が属する日の合計に加算する（簡易ロジック）
                // ※厳密には日付を跨ぐ場合分割すべきだが、今回は開始日ベースとする
                const startLogDate = new Date(lastStartTime);
                const startLogicalDate = getLogicalDate(startLogDate, resetHour);
                const startDateKey = startLogicalDate.toISOString().split('T')[0];
                
                if (!dailyTotals[startDateKey]) dailyTotals[startDateKey] = 0;
                
                dailyTotals[startDateKey] += (time - lastStartTime);
                lastStartTime = null;
            }
        }
    }
    
    // 現在進行中の作業時間はここには含めない（確定したログのみ計算）
    return dailyTotals;
}

app.get('/summary', async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
        res.status(400).json({ message: 'User ID is required' });
        return;
    }

    try {
        // Retrieve all logs for the user, sorted by timestamp ASC
        const logs = await prisma.attendanceLog.findMany({
            where: { userId: userId },
            orderBy: { timestamp: 'asc' }
        });

        const dailyTotals = calculateLogsDuration(logs, resetHour);
        
        // --- Aggregation ---
        const summary = {
            daily: [] as { date: string; totalMs: number }[],
            weekly: [] as { weekStart: string; totalMs: number }[],
            monthly: [] as { month: string; totalMs: number }[],
            total: 0
        };

        // 1. Daily Summary
        summary.daily = Object.entries(dailyTotals)
            .map(([date, totalMs]) => ({ date, totalMs }))
            .sort((a, b) => b.date.localeCompare(a.date)); // Newest first

        // 2. Weekly Summary (ISO Week: Monday start)
        const weeklyMap: { [weekStart: string]: number } = {};
        // 3. Monthly Summary
        const monthlyMap: { [month: string]: number } = {};

        Object.entries(dailyTotals).forEach(([dateStr, ms]) => {
            summary.total += ms;

            const date = new Date(dateStr);
            
            // Monthly (YYYY-MM)
            const monthKey = dateStr.substring(0, 7);
            if (!monthlyMap[monthKey]) monthlyMap[monthKey] = 0;
            monthlyMap[monthKey] += ms;

            // Weekly (Find Monday of the week)
            const day = date.getDay();
            const diff = date.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
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

// Discord Notification
app.post('/notify', async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
        res.status(400).json({ message: 'User ID is required' });
        return;
    }

    const botToken = process.env.DISCORD_BOT_TOKEN;
    const channelId = process.env.DISCORD_NOTIFY_CHANNEL_ID;

    if (!botToken || !channelId) {
        res.status(500).json({ message: 'Discord notification not configured on server.' });
        return;
    }

    try {
        const now = new Date();
        await checkAndResetStateIfNewDay(userId, now, resetHour);

        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { attendanceLogs: { orderBy: { timestamp: 'asc' } } }
        });

        if (!user) {
            res.status(404).json({ message: 'User not found' });
            return;
        }

        // Calculate today's work time using logic similar to calculateLogsDuration but strictly for "Today"
        // Reuse the logic: get daily totals
        const dailyTotals = calculateLogsDuration(user.attendanceLogs, resetHour);
        
        // Get today's logical date
        const logicalDate = getLogicalDate(now, resetHour);
        const dateKey = logicalDate.toISOString().split('T')[0];
        
        let todayMs = dailyTotals[dateKey] || 0;

        // Add current session if working
        if (user.status === 'working') {
            // Find last start time
            let lastStartTime = null;
            // Iterate backwards to find the last work_start or break_end that hasn't been closed
            // Since we don't have that state easily available without re-parsing, 
            // let's just re-parse specifically for the current open session.
            // Simplified: If status is working, the last log MUST be a start type.
            const lastLog = user.attendanceLogs[user.attendanceLogs.length - 1];
            if (lastLog) {
                const startTime = new Date(lastLog.timestamp).getTime();
                // If the session started before today's reset hour, we clamp it to reset hour
                const todayResetTime = new Date(logicalDate);
                todayResetTime.setHours(resetHour, 0, 0, 0);
                
                const effectiveStart = Math.max(startTime, todayResetTime.getTime());
                const effectiveEnd = now.getTime();
                
                if (effectiveEnd > effectiveStart) {
                    todayMs += (effectiveEnd - effectiveStart);
                }
            }
        }

        // Format Message
        const hours = Math.floor(todayMs / (1000 * 60 * 60));
        const minutes = Math.floor((todayMs / (1000 * 60)) % 60);
        
        const messageContent = `📊 **日報**\n**${user.username}** さんの本日の作業時間: **${hours}時間 ${minutes}分**`;

        // Send to Discord
        const discordRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bot ${botToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                content: messageContent,
            }),
        });

        if (!discordRes.ok) {
            const err = await discordRes.json();
            console.error('Discord API Error:', err);
            throw new Error('Failed to send message to Discord');
        }

        res.json({ message: 'Notification sent!' });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to send notification' });
    }
});

app.listen(port, listenHost, () => {
  console.log(`Server is running at http://${listenHost}:${port}`);
});
