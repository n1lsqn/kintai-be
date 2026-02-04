import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import dotenv from 'dotenv';

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

console.log(`*** IMPORTANT ***`);
console.log(`Discord Redirect URI: ${REDIRECT_URI}`);
console.log(`Please ensure this exact URL is added to your Discord Developer Portal > OAuth2 > Redirects`);
console.log(`*****************`);

app.use(cors());
app.use(express.json());

// --- JSONファイル永続化の設定 ---
// 環境変数 DATA_DIR があればそれを使用、なければカレントディレクトリの data フォルダを使用
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const dbFileName = process.env.DATA_FILENAME || 'kintai.json';
const dbFilePath = path.join(dataDir, dbFileName);

console.log(`Data file: ${dbFilePath}`);

type UserStatus = 'unregistered' | 'working' | 'on_break';
type AttendanceRecordType = 'work_start' | 'work_end' | 'break_start' | 'break_end';

interface DiscordUser {
  id: string;
  username: string;
  avatar: string | null;
}

interface AppState {
  currentUserStatus: UserStatus;
  attendanceLog: {
    type: AttendanceRecordType;
    timestamp: string; // ISO 8601 string
  }[];
  discordUser?: DiscordUser;
}

const defaultState: AppState = {
  currentUserStatus: 'unregistered',
  attendanceLog: [],
};

// データを読み込む関数
function readData(): AppState {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(dbFilePath)) {
        return { ...defaultState };
    }
    const jsonData = fs.readFileSync(dbFilePath, 'utf-8');
    return JSON.parse(jsonData) as AppState;
  } catch (error) {
    // ファイルが存在しない、または壊れている場合はデフォルト値を返す
    console.log('Data file not found or corrupted, returning default state.');
    return { ...defaultState };
  }
}

// データを書き込む関数
function writeData(data: AppState): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Failed to write data to file:', error);
  }
}

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


// 共通の日付リセット処理
function resetStateIfNewDay(state: AppState, currentTimestamp: Date, resetHour: number): AppState {
  if (state.attendanceLog.length > 0) {
    const lastLogTimestamp = state.attendanceLog[state.attendanceLog.length - 1].timestamp;
    const lastLogDateObj = new Date(lastLogTimestamp);

    const logicalLastLogDate = getLogicalDate(lastLogDateObj, resetHour);
    const logicalCurrentDate = getLogicalDate(currentTimestamp, resetHour);

    // 論理的な日付が変わった場合
    if (logicalLastLogDate.toDateString() !== logicalCurrentDate.toDateString()) {
      const lastStatus = state.currentUserStatus;
      
      // 前日の最終状態が「稼働中」だった場合
      if (lastStatus === 'working' || lastStatus === 'on_break') {
        console.log(`論理的な日付が変わり、前日が稼働中だったため、自動的に出勤処理を行います。(リセット時刻: ${resetHour}時)`);
        
        // 新しい日の開始時刻を計算（リセット時刻）
        const newDayStartTime = new Date(currentTimestamp);
        newDayStartTime.setHours(resetHour, 0, 0, 0);

        const newState: AppState = {
          ...state, // 既存のプロパティを保持 (discordUserなど)
          // 状態を 'working' に設定
          currentUserStatus: 'working',
          // ログに自動出勤記録を追加
          attendanceLog: [
            ...state.attendanceLog, 
            { type: 'work_start', timestamp: newDayStartTime.toISOString() }
          ],
        };
        return newState;
      } else {
        // 前日が正常に退勤済みだった場合
        console.log(`論理的な日付が変わったため、状態をリセットしました。(リセット時刻: ${resetHour}時)`);
        // currentUserStatusのみリセット、他は維持
        const newState = { ...state, currentUserStatus: 'unregistered' as UserStatus };
        return newState;
      }
    }
  }
  return state; // 変更なし
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
        
        let state = readData();
        state.discordUser = {
            id: userData.id,
            username: userData.username,
            avatar: userData.avatar
        };
        writeData(state);

        res.send(`
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


app.post('/stamp', (req: Request, res: Response) => {
  const now = new Date();
  let state = readData(); // データを読み込む
  state = resetStateIfNewDay(state, now, resetHour); // 日付リセットチェック
  // リセットされた可能性があるので、一度書き込む
  writeData(state);

  let message = '';
  
  switch (state.currentUserStatus) {
    case 'unregistered':
      state.currentUserStatus = 'working';
      state.attendanceLog.push({ type: 'work_start', timestamp: now.toISOString() });
      message = '出勤しました。';
      break;
    case 'working':
      state.currentUserStatus = 'on_break';
      state.attendanceLog.push({ type: 'break_start', timestamp: now.toISOString() });
      message = '休憩を開始しました。';
      break;
    case 'on_break':
      state.currentUserStatus = 'working';
      state.attendanceLog.push({ type: 'break_end', timestamp: now.toISOString() });
      message = '休憩を終了しました。';
      break;
  }

  writeData(state); // 変更を書き込む
  res.status(200).json({ message, newStatus: state.currentUserStatus });
});

app.post('/clock_out', (req: Request, res: Response) => {
  const now = new Date();
  let state = readData();
  state = resetStateIfNewDay(state, now, resetHour);
  // リセットされた可能性があるので、一度書き込む
  writeData(state);

  let message = '';

  if (state.currentUserStatus === 'working' || state.currentUserStatus === 'on_break') {
    state.currentUserStatus = 'unregistered';
    state.attendanceLog.push({ type: 'work_end', timestamp: now.toISOString() });
    message = '退勤しました。';
  } else {
    res.status(400).json({ message: 'まだ出勤していません。' });
    return;
  }

  writeData(state);
  res.status(200).json({ message, newStatus: state.currentUserStatus });
});

app.get('/status', (req: Request, res: Response) => {
    let state = readData();
    const checkedState = resetStateIfNewDay(state, new Date(), resetHour);
    // 日付リセットが発生した場合、リセット後の状態をファイルに書き戻す
    if (JSON.stringify(state) !== JSON.stringify(checkedState)) {
        writeData(checkedState);
    }
    
    res.status(200).json({
        currentStatus: checkedState.currentUserStatus,
        attendanceLog: checkedState.attendanceLog,
        discordUser: checkedState.discordUser,
        lastLogTimestamp: checkedState.attendanceLog.length > 0 ? checkedState.attendanceLog[checkedState.attendanceLog.length - 1].timestamp : null
    });
});

app.listen(port, listenHost, () => {
  console.log(`Server is running at http://${listenHost}:${port}`);
});