# ベースイメージとして公式のNode.js 18イメージを使用
FROM node:18

# アプリケーションの作業ディレクトリを作成
WORKDIR /usr/src/app

# package.jsonとpackage-lock.jsonをコピー
COPY package*.json ./

# 依存関係をインストール
RUN npm install

# アプリケーションのソースコードをコピー
COPY . .

# TypeScriptをコンパイル
RUN npm run build

# アプリケーションがリッスンするポートを公開
EXPOSE 3000

# 開発時は`docker-compose.yml`で上書きされる
CMD ["npm", "start"]
