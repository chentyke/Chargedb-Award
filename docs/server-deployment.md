# 服务端部署指南

本服务端为 Express + Notion API 代理，负责：
- 读取投票项目数据库
- 校验 key_db 中的投票密码（一次性）
- 写入投票结果 JSON（存到 key_db 的文本字段）

## 运行环境
- Node.js 18+（建议 20+）
- 可访问 Notion API 的网络

## 环境变量
在生产环境中通过系统环境变量或 `.env` 文件提供：

必填：
- `NOTION_API_KEY`：Notion Integration 的 API Key
- `NOTION_DATABASE_ID`：投票项目数据库 ID
- `KEY_DB`：投票密码数据库 ID

可选：
- `PORT`：服务端口（默认 5175）
- `NOTION_VOTE_PROPERTY`：投票计数字段名（数字类型）
- `KEY_DB_KEY_PROPERTY`：key_db 的密码字段名（默认匹配“投票密码”）
- `KEY_DB_USED_PROPERTY`：key_db 的使用状态字段名（默认匹配“是否已经使用？”）
- `KEY_DB_RESULT_PROPERTY`：key_db 的投票结果字段名（默认匹配“投票结果”）

## 部署步骤（Node 服务器）
1. 安装依赖
   ```bash
   npm ci
   ```

2. 设置环境变量
   ```bash
   export NOTION_API_KEY=...
   export NOTION_DATABASE_ID=...
   export KEY_DB=...
   export PORT=5175
   ```

3. 启动服务
   ```bash
   npm run start
   ```

4. 健康检查
   ```bash
   curl http://localhost:5175/api/health
   ```

## 前端对接（同域或跨域）
- 同域部署：前端请求会走同域，无需设置 `VITE_API_BASE`。
- 跨域部署：前端构建时设置 `VITE_API_BASE=https://your-api.example.com`。

注意：`server/index.js` 当前 CORS 仅允许 `http://localhost:5173`，生产环境请修改允许的域名列表。

## 进程守护建议
- 推荐使用 systemd 或 PM2 守护进程。

## 投票结果写入格式
- 服务端会把投票结果 JSON 序列化写入 key_db 的“投票结果”文本字段。
- 示例结构：
  ```json
  {
    "submittedAt": "2025-01-01T12:00:00.000Z",
    "totalVotes": 6,
    "votes": [
      {
        "id": "<notion-page-id>",
        "category": "充电配件",
        "count": 2,
        "title": "双向折叠插脚",
        "brand": "安克",
        "model": "A123",
        "specs": "65W",
        "reason": "小巧便携"
      }
    ]
  }
  ```

