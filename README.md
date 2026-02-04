# Kintai Backend API

作業管理アプリケーション「Kintai」のバックエンドサーバーです。
Node.js (Express) と TypeScript で構築されており、Docker コンテナとして動作することを前提に設計されています。
データの永続化にはシンプルに JSON ファイルを使用しています。

## 🚀 動作環境

*   Node.js v20+
*   Docker & Docker Compose

## 🛠 セットアップと起動

### Docker を使用する場合 (推奨)

**開発環境 (Development)**
ホットリロード (nodemon) が有効な状態で起動します。ホスト側のポート **9394** を使用します。

```bash
# be ディレクトリ内で実行
docker compose up
```

**本番環境 (Production)**
最適化された軽量イメージで起動します。ホスト側のポート **9393** を使用します。

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### ローカルで直接実行する場合

Node.js がインストールされている環境で直接実行することも可能です。

```bash
npm install

# 開発モード (ts-node + nodemon)
npm run dev

# ビルド & 実行
npm run build
npm start
```

## ⚙️ 環境変数

`.env` ファイル、または Docker Compose の `environment` で設定します。

| 変数名 | デフォルト | 説明 |
| :--- | :--- | :--- |
| `PORT` | `9393` | サーバーがリッスンするポート番号 |
| `HOST` | `0.0.0.0` | ホスト名 |
| `RESET_HOUR` | `5` | 日付変更処理を行う時刻 (時)。デフォルトは午前5時。 |

## 📡 API エンドポイント

Base URL: `http://localhost:9394` (Dev) / `http://localhost:9393` (Prod)

### 1. 状態取得
現在のユーザーステータスとログを取得します。

*   **URL**: `/status`
*   **Method**: `GET`
*   **Response**:
    ```json
    {
      "currentStatus": "working",
      "attendanceLog": [
        { "type": "work_start", "timestamp": "2024-02-04T09:00:00.000Z" }
      ],
      "discordUser": { ... }, // Optional
      "lastLogTimestamp": "2024-02-04T09:00:00.000Z"
    }
    ```

### 2. スタンプ (状態遷移)
状態を順次切り替えます（トグル動作）。
遷移順序: `unregistered` (開始) → `working` (休憩開始) → `on_break` (休憩終了) → `working` ...

*   **URL**: `/stamp`
*   **Method**: `POST`
*   **Response**:
    ```json
    {
      "message": "出勤しました。",
      "newStatus": "working"
    }
    ```

### 3. 終了 (退勤)
作業を終了し、ステータスを `unregistered` に戻します。

*   **URL**: `/clock_out`
*   **Method**: `POST`
*   **Response**:
    ```json
    {
      "message": "退勤しました。",
      "newStatus": "unregistered"
    }
    ```

## 💾 データ構造と永続化

データは `data/kintai.json` に保存されます。Docker実行時はボリュームマウントによりホスト側の `be/data/` ディレクトリに保持されます。

**データ形式 (TypeScript Interface):**

```typescript
type UserStatus = 'unregistered' | 'working' | 'on_break';

interface AppState {
  currentUserStatus: UserStatus;
  attendanceLog: {
    type: 'work_start' | 'work_end' | 'break_start' | 'break_end';
    timestamp: string; // ISO 8601
  }[];
  discordUser?: {
    id: string;
    username: string;
    avatar: string | null;
  };
}
```

## 🕒 自動日付変更ロジック

`RESET_HOUR` (デフォルト: 午前5時) を基準に「論理的な一日」を判定します。

*   日付変更時刻をまたいでアクセスがあった場合、自動的に処理が走ります。
*   **前日が「作業中/休憩中」だった場合**: 自動的に新しい日の「出勤」ログを追加し、作業を継続させます（深夜残業対応）。
*   **前日が「未稼働（退勤済み）」だった場合**: ステータスをリセットして新しい一日を開始します。
