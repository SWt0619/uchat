# Uchat · 自建聊天室

一个**不依赖任何前端框架**的自建聊天室：文字 / Markdown + 公式 / 图片 / 文件、语音与视频通话、屏幕共享、一起听歌、还有两个会聊天的 AI 用户。服务端用 Java 17 + Spring Boot，前端是原生 HTML/CSS/JS，整个部署就是**一个 jar + 一个便携 JDK**。

> 适合：想在**自己电脑/小服务器**上给几个朋友开一个私密聊天室，不依赖任何第三方服务。（默认最大16人，可以自行更改上限）

---

## 功能

**消息**
- 文字（Markdown 渲染 + KaTeX 公式 + highlight.js 代码高亮，全部本地化，断网可用）
- 图片（灯箱预览）、文件（上传下载、50GB 容量上限）、**音频/视频在聊天室直接播放**（HTTP Range，可拖进度）
- 撤回、引用回复、@提及（带在线用户补全）、私聊（含**离线私聊**：对方不在线也收得到）
- 消息可靠性：`msgId` 幂等去重 + 发送队列（localStorage 持久化）+ 断线自动补齐（`sync_since`）

**通话**
- **语音通话**：2 个独立房间（12 人 / 6 人）；**视频通话**：2 个独立房间（8 人 / 6 人）
- 通话中可**换房间**（语音⇄视频、1⇄2 号房）
- **屏幕共享**：4 档画质（480p/720p/1080p/2K）× 4 档帧率（24/36/48/60），共享者看得到「上行占用估算」，观看者看得到「实时延迟 / 丢包 / 解码帧率」，人数以服务端为准
- 自建 **TURN** 服务（含在仓库里，Bun 运行），打不通直连时走中继

**一起听歌**
- 两种音源：网易云链接、或**本地上传**的音频文件
- 真同步：服务端下发起点时间戳，听众按 `serverTime` 对齐；点歌人上报时长用于精确排下一首；放不出来会广播提示并自动跳过

**AI 用户**
- 两个可选机器人，基于 DeepSeek API（或者你也可以自行接入其他模型），@ 触发或按概率插话，带**上下文记忆**（落盘 `bot.history.json`）。**不配 API key 就不启动，不影响聊天室本身**。（注：AI用户也会占用注册人数）

**其它**
- 手机端适配：抽屉式用户列表、行内 @ / 私聊按钮、输入框不被键盘挡、整屏私聊窗口
- **可安装到桌面**（PWA）：Chrome 里打开 → 地址栏「安装」→ 独立窗口、无地址栏
- 主题（浅色/深色）、字体与字号、工具栏按钮自定义、番茄钟、骰子、表情、环境音
- 鉴权：登录 token、邀请码注册（未配置则**禁止注册**）、上传/列表/偏好接口全部校验 token、聊天室存储配额（默认 50GB）
- 静默运行：一条 `静默运行Uchat.vbs` 后台跑服务 + 看门狗 + 托盘状态图标，**0 个可见窗口**

---

## 技术栈

| 层 | 选型 |
|---|---|
| 服务端 | Java 17、Spring Boot 2.7.18（web / websocket）、原生 WebSocket 协议 |
| JSON | Gson |
| 前端 | 原生 HTML/CSS/JS（无框架、无构建步骤）；vendor 目录内本地化 KaTeX / highlight.js / marked |
| 实时音视频 | WebRTC（自建 TURN，Bun + `turn_server.js`） |
| 构建 | Maven（`mvn package` → 可执行 fat jar） |

---

## 目录结构

```
├── src/main/java/com/chatroom2/
│   ├── websocket/ChatWebSocketHandler.java   # 协议中枢：聊天/通话信令/屏幕共享/听歌房/AI
│   ├── controller/                           # 文件、音乐、偏好、番茄钟、TURN、健康检查
│   ├── model/                                # Room / UserManager / PrivateStore / AuthTokenStore / StorageQuota
│   └── config/                               # CORS、WebSocket 注册
├── src/main/resources/
│   ├── application.properties                # 全部配置（敏感项走环境变量）
│   └── static/                               # 前端：index.html + js/ + css/ + vendor/ + icons/ + sw.js
├── bot/  bot2/                               # 两个 AI 用户（Bun + DeepSeek，互相独立）
├── turn/                                     # 自建 TURN 服务（Bun）
├── 启动Uchat.bat 稳定运行Uchat.bat 静默运行Uchat.vbs   # 三种启动方式
├── CHANGELOG.md  DOCS.md  DEPLOY.md          # 变更记录 / 功能细节 / 部署说明
```

---

## 快速开始

**前置**：JDK 17（或把便携 JDK 放到 `java/`，脚本会用它）、Maven 3.9+。

```bash
# 1) 打包（产物 target/uchat.jar）
mvn -B clean package

# 2) 放好本机私密文件（都在 .gitignore 里，见下表）

# 3) 启动
双击 启动Uchat.bat          # 或 稳定运行Uchat.bat（带看门狗）/ 静默运行Uchat.vbs（无窗口）
# 浏览器打开 https://127.0.0.1:8888/
```

### 需要你自己准备的本机文件（都不会进 git）

| 文件 | 作用 | 缺少时 |
|---|---|---|
| `keystore.p12` + `keystore.pwd` | HTTPS 证书与口令（自签也行；手机摄像头/麦克风要求受信任证书） | 服务起不来（fail-closed） |
| `invite.pwd` | 注册邀请码 | **注册功能自动禁用**（不会退化成谁都能注册） |
| `allowed-origins.pwd` | 允许的跨域来源，逗号分隔 | 仅允许本机同源 |
| `admins.pwd` | 管理员昵称，逗号分隔（用户列表高亮/角色） | 没有管理员角色 |
| `turn/turn.pwd` | TURN 共享密钥 | 只走公开中继 |
| `bot/bot_login.pwd`、`bot2/bot_login.pwd` | 两个 AI 账号的登录密码 | 用 `UCHAT_BOT_PASSWORD` 环境变量 |
| `bot/dsapi.txt`（或 `DEEPSEEK_API_KEY`） | DeepSeek API key，第 1 行给 bot1、第 2 行给 bot2 | AI 用户不启动（聊天室照常） |

> 这些文件都由启动脚本自动读取并注入环境变量；也可直接用同名环境变量（`UCHAT_KEYSTORE_PWD`、`UCHAT_INVITE_CODE`、`UCHAT_ALLOWED_ORIGINS`、`UCHAT_ADMINS`、`UCHAT_TURN_PASSWORD`、`UCHAT_BOT_PASSWORD`、`DEEPSEEK_API_KEY`）。

---

## 配置要点（`src/main/resources/application.properties`）

| 键 | 默认 | 说明 |
|---|---|---|
| `server.port` | 8888 | 端口 |
| `server.ssl.key-store-password` | `${UCHAT_KEYSTORE_PWD}` | 证书口令，只从环境变量读 |
| `chat.invite.code` | `${UCHAT_INVITE_CODE:}` | 邀请码；空 = 禁止注册 |
| `chat.allowed-origins` | `${UCHAT_ALLOWED_ORIGINS:http://localhost:8888}` | 跨域白名单（同源访问其实用不到） |
| `chat.roles.admin` / `chat.roles.bot` | 空 / 两个 AI 昵称 | 角色样式 |
| `chat.files.max-total-gb` | 50 | 聊天室存储上限，超过**禁止上传**并提示联系管理员 |
| `chat.call.grace-ms` | 45000 | 掉线宽限期（断网回来不掉出通话） |
| `chat.signaling.max-per-sec` / `max-payload-bytes` | 60 / 32768 | 信令限流与载荷上限 |

---

## 测试

```bash
# 单元测试（36 个：UserManager / Room / Message / Turn / 消息可靠性）
mvn -B test

# 端到端自查脚本（dev/，需要 Bun + Chrome；各自起临时实例，不碰生产 8888）
bun dev/_smoke_test.js          # 登录 → 发消息 → 对端收到 → 上传 → 渲染 → 0 JS 异常
bun dev/t5_harness.js --scenario s1 # 离线私聊等可靠性场景
bun dev/_files_media_test.js    # 鉴权 / Range 播放 / 50GB 配额
bun dev/_pwa_test.js            # PWA 可安装性（Chrome 官方判定）
```
---

## 部署到公网

见 [`DEPLOY.md`](DEPLOY.md) 与 [`_异机部署说明.md`](_异机部署说明.md)。要点：

1. 自备域名 + 受信任证书（Let's Encrypt 即可；自签证书只能用 IP/本机，手机端拿不到摄像头权限）
2. 内网穿透建议用 **TCP 隧道**（不要开"自动 HTTPS/TLS"，否则会在节点解出 TLS 再明文转发，Tomcat 会回 400）
3. 反代/隧道后面记得把 HTTPS 地址加进 `allowed-origins.pwd`
4. 想给朋友用：把 `java/` + `uchat.jar` + 启动脚本打包成便携版（`build.cmd` 或手动），对方装个 JDK 也能跑

---

## 安全说明

- **本仓库不含任何密钥**：`*.pwd`、`keystore.p12`、`dsapi.txt`、`data/`、`logs/`、`backup/` 全部 gitignore
- 邀请码 / 证书口令 / TURN 口令都是 **fail-closed**：没配就不开放对应功能
- 上传、文件列表、下载、预览、偏好、番茄钟接口都校验登录 token；上传有存储配额
- 建议：公网部署时把 `chat.allowed-origins` 设成你的域名，并定期轮换邀请码与 AI 账号密码

---

## 已知限制

- 消息历史在内存 + 单个 `room.dat`（设计目标是"几个人的小房间"，不是万人群）
- 私聊落盘有上限（全局 2000 / 单人 200 条），超出会丢弃最旧并如实告知
- 通话与屏幕共享是 **P2P 网状**：共享者上行 ≈ 观看人数 × 每路码率，人多了需要 TURN 中继
- 不提供帐号体系（没有邮箱/找回密码），账号由室主在服务端维护

---

## 许可

[MIT](LICENSE) —— 可自由使用、修改、分发（保留版权声明即可）。
仓库内 `src/main/resources/static/vendor/` 下打包的第三方前端库（KaTeX / highlight.js / marked）各自遵循原许可，见 `vendor/LICENSES.md`。
