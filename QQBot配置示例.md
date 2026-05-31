# QQ Bot 配置示例

## 1. 环境变量配置（最简单）

```bash
# QQ Bot 凭证（必须）
export CC_NODE_CHANNEL_QQBOT_APPID=你的AppID
export CC_NODE_CHANNEL_QQBOT_SECRET=你的AppSecret

# 默认目标（可选，可在工具调用中覆盖）
export CC_NODE_CHANNEL_QQBOT_TARGET_GROUP=你的群OPENID
```

## 2. 配置文件 `~/.claude-code/config.json`

```json
{
  "qqbot": {
    "enabled": true,
    "accounts": {
      "default": {
        "enabled": true,
        "appId": "YOUR_APP_ID",
        "clientSecret": "你的AppSecret",
        "dmPolicy": "open",
        "groupPolicy": "open",
        "allowFrom": ["*"],
        "defaultTargets": {
          "group": "YOUR_GROUP_OPENID"
        }
      }
    },
    "defaultAccount": "default"
  },

  "channels": {
    "qqbot": {
      "enabled": true
    }
  },

  "defaultChannel": "qqbot"
}
```

## 3. 基本使用

### 3.1 发送文本消息（通过工具）

在 cc-node REPL 中调用工具：

```
/工具 qqbot_channel_api
{
  "method": "GET",
  "path": "/users/@me/guilds"
}
```

获取频道列表后，再发送消息到群：

```
/Bash  # 假设获取到 group_openid = ABC123
/工具 qqbot_channel_api
{
  "method": "POST",
  "path": "/v2/groups/ABC123/messages",
  "body": { "content": "大家好，我是 AI 助手！" }
}
```

### 3.2 使用富媒体标签

如果你的 Agent 回复中包含 `<qqmedia>` 标签，系统会自动解析并上传：

```
这是分析结果：
<qqmedia>/home/用户名/.openclaw/media/qqbot/chart.png</qqmedia>
```

**注意**：文件必须放在 `~/.openclaw/media/qqbot/` 或 `~/.openclaw/media/` 目录下。

### 3.3 频道管理

列出机器人所在的群/频道：

```
/工具 qqbot_list_guilds
{
  "limit": 100
}
```

获取某个频道的子频道：

```
/工具 qqbot_list_channels
{
  "guildId": "频道的ID"
}
```

获取频道成员列表：

```
/工具 qqbot_list_members
{
  "guildId": "频道的ID",
  "limit": 100,
  "after": "0"
}
```

---

## 4. 安全与权限

### 4.1 权限策略

- `dmPolicy`: `"open"`（所有人可私聊）, `"allowlist"`（仅白名单）, `"disabled"`
- `groupPolicy`: 同 `dmPolicy`
- `allowFrom`: 白名单列表，`["*"]` 表示允许所有

### 4.2 白名单格式

```json
"allowFrom": [
  "qqbot:USER_OPENID",           // 用户 OpenID
  "qqbot:GROUP_OPENID",          // 群级别（整群允许）
  "qqbot:group:GROUP_OPENID:USER_OPENID"  // 群内特定成员
]
```

---

## 5. 多账户管理

```json
{
  "qqbot": {
    "defaultAccount": "main",
    "accounts": {
      "main": {
        "enabled": true,
        "appId": "YOUR_APP_ID",
        "clientSecret": "密钥A",
        "defaultTargets": { "group": "群A的OPENID" }
      },
      "helper": {
        "enabled": true,
        "appId": "1904021872",
        "clientSecret": "密钥B",
        "dmPolicy": "allowlist",
        "allowFrom": ["qqbot:USER_OPENID"]
      }
    }
  }
}
```

在工具调用中指定 `accountId` 使用特定账户：

```json
{
  "method": "GET",
  "path": "/users/@me/guilds",
  "accountId": "helper"
}
```

---

## 6. WebSocket 消息监听（自动回复）

启动 cc-node 时，`QQBotChannel` 会在后台建立 WebSocket 连接，接收 QQ 消息并转发给 AI 处理。

**启用监听**：在配置中启用通道即可自动开始监听。

**消息流程**：
1. 用户在 QQ 发消息 → QQ Bot API → WebSocket
2. `QQBotChannel` 接收到消息，调用 `onMessage` 回调
3. 主引擎处理，生成回复
4. 回复内容中若含 `<qqmedia>` 标签，自动上传并发送
5. 最终消息发送回 QQ

---

## 7. 常见问题

**Q: 令牌失效怎么办？**
A: Token 自动续期，如频繁失败请检查 AppID/Secret 是否匹配机器人应用。

**Q: 文件上传失败？**
A: 检查：
- 文件路径是否为绝对路径
- 文件是否在 `~/.openclaw/media/qqbot/` 下
- 文件大小是否超限（图片30MB, 视频100MB, 文件100MB, 语音20MB）

**Q: 收不到群消息？**
A: 检查：
- 群策略 `groupPolicy` 是否为 `open`
- `allowFrom` 是否包含群 OpenID
- 机器人是否已加入该群

**Q: 如何调试？**
A: 启动 cc-node 时加 `-v` 查看详细日志。

---

## 8. 待完成

- `qqbot_remind` 定时提醒工具（依赖项目调度系统）
- 流式响应支持（`streaming.c2cStreamApi`）
- 更多工具：qqbot_channel 的成员管理、公告、日程操作一键函数

---

## 9. 与 OpenClaw 的能力对齐

| 功能 | OpenClaw | claude-code-node（当前） |
|------|---------|------------------------|
| 多账户管理 | ✅ | ✅ |
| 权限控制 | ✅ | ✅ |
| 文本发送 | ✅ | ✅ |
| 图片/文件上传 | ✅ | ✅ |
| WebSocket 监听 | ✅ | ✅ |
| `<qqmedia>` 标签 | ✅ | ✅ |
| 频道 API 工具 | ✅ | ✅（通用通道） |
| 定时提醒 | ✅ | ⏳（占位） |
| 流式响应 | ✅ | ⏳ |

---

完成时间：2025-05-31  
集成者：吊炸天
