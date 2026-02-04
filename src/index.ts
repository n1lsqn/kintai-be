import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import 'dotenv/config';

const app = express();
const port = parseInt(process.env.PORT || '9393', 10);
const host = process.env.HOST || '0.0.0.0';
const resetHour = parseInt(process.env.RESET_HOUR || '5', 10); // 日替わり時刻を午前5時に設定

// Discord OAuth Config
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${port}/auth/discord/callback`;

app.use(cors());
app.use(express.json());

// --- JSONファイル永続化の設定 ---
const dataDir = path.join('/usr', 'src', 'app', 'data');
const dbFilePath = path.join(dataDir, 'kintai.json');

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

// 認証フロー用のメモリ内ストア (本番環境ではRedisやDB推奨)
// requestState -> { status: 'pending' | 'completed', userData?: DiscordUser }
const authRequests = new Map<string, { status: 'pending' | 'complete', user?: DiscordUser }>();

// データを読み込む関数
function readData(): AppState {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
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

// 1. 認証開始: フロントエンドはここを呼んで redirectUrl を取得するか、
//    あるいは直接ブラウザでこのURLを開く。
//    今回はポーリング方式にするため、フロントエンドで state (uuid) を生成して
//    パラメータとして渡してもらうか、ここで生成して返す。
//    簡単のため、フロントエンドから state を受け取る形、または
//    バックエンドが生成してリダイレクトする形をとる。
//    Tauri (localhost) -> Browser (Discord) -> Backend (Callback) -> Tauri (Poll)

app.get('/auth/discord/login-url', (req: Request, res: Response) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    res.status(500).json({ error: 'Discord credentials not configured' });
    return;
  }
  
  // 簡易的なUUID生成
  const state = crypto.randomUUID();
  authRequests.set(state, { status: 'pending' });

  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify&state=${state}`;

  res.json({ url, state });
});

app.get('/auth/discord/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query;

  if (!state || typeof state !== 'string' || !authRequests.has(state)) {
    res.status(400).send('Invalid state');
    return;
  }

  if (!code || typeof code !== 'string') {
    res.status(400).send('No code provided');
    return;
  }

  try {
    // 1. Access Token 取得
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: CLIENT_ID!,
        client_secret: CLIENT_SECRET!,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!tokenResponse.ok) {
      throw new Error('Failed to fetch token');
    }

    const tokenData = await tokenResponse.json();

    // 2. User Info 取得
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: {
        authorization: `${tokenData.token_type} ${tokenData.access_token}`,
      },
    });

    if (!userResponse.ok) {
      throw new Error('Failed to fetch user');
    }

    const userData = await userResponse.json();

    // 3. メモリに保存
    authRequests.set(state, { 
      status: 'complete', 
      user: {
        id: userData.id,
        username: userData.username,
        avatar: userData.avatar,
      } 
    });

    // 4. データファイルにもユーザー情報を永続化する（シングルユーザー想定）
    let currentState = readData();
    currentState.discordUser = {
        id: userData.id,
        username: userData.username,
        avatar: userData.avatar,
    };
    writeData(currentState);

    res.send('<h1>Authentication successful!</h1><p>You can close this window and return to the app.</p><script>setTimeout(() => window.close(), 2000);</script>');

  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).send('Authentication failed');
  }
});

// ポーリング用
app.get('/auth/poll', (req: Request, res: Response) => {
  const { state } = req.query;
  if (!state || typeof state !== 'string') {
    res.status(400).json({ error: 'Missing state' });
    return;
  }

  const reqData = authRequests.get(state);
  if (!reqData) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }

  if (reqData.status === 'complete' && reqData.user) {
    // 認証完了したらマップから削除（一度きり）
    authRequests.delete(state);
    res.json({ status: 'complete', user: reqData.user });
  } else {
    res.json({ status: 'pending' });
  }
});

app.post('/auth/logout', (req: Request, res: Response) => {
    let state = readData();
    state.discordUser = undefined;
    writeData(state);
    res.json({ message: 'Logged out' });
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

app.listen(port, () => {
  console.log(`Server is running at http://${host}:${port}`);
});
