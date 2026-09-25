# Uchat 项目文档

## 一、项目概述

Uchat v2.4.0 — 基于 **Java 17 + Spring Boot 2.7 + WebSocket** 的实时聊天室应用，支持文字/语音/视频/文件/屏幕共享。纯 Web 应用，浏览器即客户端。

> v2.4.0 做了音视频通话的可靠性/音质加固（TURN 支持、ICE 候选排队、信令鉴权、码率自适应、音频链收敛），
> 变更明细见 [CHANGELOG.md](CHANGELOG.md#v240-2026-09-22)（当时的验收步骤记在 `FIXES.md`，该文档已于 2026-09-24 清理，可在 Git 历史中查看）。

| 属性 | 值 |
|---|---|
| 版本 | 2.4.0 |
| 语言 | Java 17 |
| 框架 | Spring Boot 2.7.18 |
| 通信 | WebSocket (raw JSON) |
| 前端 | 原生 HTML/CSS/JS，无框架 |
| 包管理 | Maven |
| 端口 | 8888 (服务端) / 8889 (debug) |
| 测试 | JUnit 5 |
| 通话容量 | 语音 2 间（12 / 6 人）、视频 2 间（8 / 6 人）；主聊天室总容量 **16 人** |

---

## 二、使用说明

### 2.1 启动服务器

```bash
# 开发环境
mvn spring-boot:run

# 生产环境（打包后）
java -jar uchat.jar
# 或双击 启动Uchat.bat
```

本机浏览器访问 `https://localhost:8888`（或 `https://127.0.0.1:8888`）。

**日常使用：双击 `静默运行Uchat.vbs`（v2.8.2 起推荐）** —— 全程隐藏，桌面上一个窗口都不会多：

| 它做的事 | 说明 |
|---|---|
| 守护进程 | `静默运行Uchat.ps1`：服务看门狗（3 秒一轮，java 不在了就拉起）+ 阻止系统休眠 + TURN + 两个 AI |
| 状态怎么看 | **右下角托盘图标**：🟢 正常 / 🟡 探测抖动 / 🔴 无响应；掉线与恢复都会弹气泡；悬停显示「已运行 x 小时 · 最近一次探测 x ms」 |
| ⚠️ 图标没看到 | Windows 11 会把新图标收进托盘折叠区：点托盘上的 `^` 展开，把 Uchat 图标**拖到常显区**即可；即使不拖，掉线/恢复的**气泡提醒照样会弹** |
| 托盘右键 | 打开 Uchat / 打开日志目录 / 立即检查 / 重启服务 / 停止 Uchat（全部）/ 退出监视 |
| 状态落盘 | `logs\_service_status.json`（守护进程写）、`logs\_status_monitor.log`（每次探测与状态变化）、`logs\_silent_supervisor.log`（拉起/重启记录） |
| 停止 | 双击 `停止Uchat.bat`（先停守护与托盘，再停服务 / AI / TURN） |

**排障用（窗口版）：`稳定运行Uchat.bat`** —— 会开 4 个窗口（服务 + TURN + 两个 AI），但**日志可以直接看**：
① 拉起 `保持唤醒.ps1` 阻止主机空闲休眠 ② 用 `:loop` 守护服务进程（崩溃/被杀后 3 秒自动重启）。
⚠️ v2.8.1 起 bot / TURN 各自持有独立控制台，不再与看门狗共用（共用会让控制台代码页被改成 UTF-8，导致 java 的 GBK 日志在窗口里全成乱码）。

> 局域网下"主机一掉线、其他人全掉"是**服务端单点**导致的架构现象，不是重连 bug。
> 定位方法与调优（网卡省电、静态 IP、重连时序实测）见 [DEPLOY.md §4.3](DEPLOY.md)。

### 2.2 手机端（v2.8.3 适配后的行为）

窄屏（≤768px）自动切换为移动布局，无需装 App。要点：

| 项 | 手机上的行为 |
|---|---|
| 在线列表 | 工具栏最左的 👥 打开**右侧抽屉**（点遮罩或再点 👥 收起） |
| **@ 提及** | 抽屉里每个人的行右侧有 **`@` 按钮：一击把 `@昵称 ` 插到输入框末尾并聚焦（自动弹键盘）**；也可以点整行弹菜单 → `@ 提及` |
| **@ 补全**（双端） | 在输入框打 `@` 或 `@` + 前缀 → 弹出**在线用户**候选：`↑`/`↓` 选择、`Enter`/`Tab` 接受、`Esc` 关闭，手机可点选 |
| **私聊** | 同一行右侧的 **`🔒` 按钮：一击打开私聊（整屏）**，按钮旁显示未读数；也可点整行弹菜单 → `私聊` |
| 私聊窗口 | 手机上**整屏**显示，头部有关闭 ✕；对方离线也能发（v2.8.0 起消息落盘、对方上线补投） |
| 工具栏 | 只保留 在线列表 / 表情 / 骰子 / 语音通话 / 视频通话 / 切换主题 / 清屏 / 设置 |
| 设置页 | 手机隐藏与手机无关的项：消息字体、麦克风、**🎤 语音测试**、摄像头、屏幕共享清晰度与帧率、发送习惯；「工具栏按钮」只列手机上真有的按钮 |
| Markdown 工具条 | 保留 加粗/斜体/删除线/行内代码/链接/无序/有序/引用 + 折叠；LaTeX 与数学符号面板在手机上隐藏 |
| 通话/共享面板 | 贴边显示、可拖动，麦克风按钮不会被挤出屏外 |

> 复现这份适配的体检：`bun dev\_mobile_audit.js --tag before|after`（真 Chrome + CDP，390×844 + 触摸模拟，
> 起独立实例在 8899，**不会碰 8888**）；报告 `logs\_mobile_*.json|txt`，截图 `logs\_mobile_*/`。

### 2.3 樱花 Frp 内网穿透（建站推荐）

让朋友通过公网访问你的服务器，无需 VPN。

**1. 注册账号**
访问 sakurafrp.com 注册并登录。

**2. 创建隧道**
在管理面板「隧道列表」中点击「创建隧道」：
- **隧道类型**：TCP
- **本地 IP**：127.0.0.1
- **本地端口**：8888
- **远程端口**：自动分配

**3. 启动隧道**
下载樱花 Frp 启动器（Windows），登录后启动隧道。启动成功后会显示访问地址，格式如 `xxx.sakurafrp.com:12345`。

**4. 发给朋友**
朋友在浏览器打开 `http://xxx.sakurafrp.com:12345` 即可进入聊天室。无需安装任何客户端。

**5. 如果遇到浏览器安全警告**
在樱花面板中将隧道类型改为 HTTP 或开启「自动 HTTPS」，即可获得 HTTPS 支持。

### 2.4 局域网部署

如果和朋友在同一局域网内，直接访问 `http://你的局域网IP:8888` 即可，无需额外配置。

---

### 2.5 听歌房（一起听歌）与通话房间容量（v2.9.0）

**听歌房**（工具栏 🎵，最多 4 人，轮流点歌）

| 能力 | 说明 |
|---|---|
| 两种音源 | ① 粘贴网易云歌曲链接（`song?id=数字`）② **📁 本地音频**（mp3/ogg/wav/m4a/flac/opus/webm，≤30MB，上传后房间内共用同一音源） |
| 版权提醒 | 网易云外链只对**有外链权限**的曲目有效；放不出来时点歌人端会显示明确提示，服务端广播「⚠ xx 的曲目无法播放…已自动跳过」并自动换下一首（另有 90 秒兜底推进） |
| **真同步** | 服务端广播该曲目的**起点时间**（`startedAt`）+ 自身时钟（`serverTime`）；各客户端算出 `(服务器当前时间 − startedAt)` 并 seek 到该位置，每 2 秒校正（偏差 >0.8 秒自动拉回）。中途加入的人也对齐（实测两页差 0.01–0.75 秒） |
| 时长 | 点歌人拿到元数据后上报 `music_room_meta`（时长），服务端据此精确安排下一轮 |
| 自动播放 | 浏览器要求手势时显示「▶ 点这里开始同步播放」，点完即自动对齐 |
| 接口 | 上传 `POST /api/music/upload`（需登录 token，落到 `data/music/`）；播放 `GET /music/<文件名>`（Spring 静态映射，**带 HTTP Range**，`<audio>` 才能 seek） |

**通话房间容量**（v2.9.0 起，可在通话中直接换房）

| 房间 | 类型 | 容量 |
|---|---|---|
| 房间 1 | 🎙️ 语音 | **12 人** |
| 房间 2 | 🎙️ 语音 | **6 人** |
| 房间 1 | 📹 视频 | **8 人** |
| 房间 2 | 📹 视频 | **6 人** |

- 通话中再点呼叫键 = 打开「🔀 换房间」（**不再直接挂断**）：可语音⇄视频、1 号房⇄2 号房互切；退出通话请点选择器里的「退出通话」或通话面板的挂断
- 容量由服务端下发（`call_status.caps`），客户端只显示不硬编码；房间满时提示「语音房间1已满（12人）」
- ⚠️ 聊天室总容量仍是 **16 人**（`MAX_CLIENTS`），所以四个房间容量之和可以大于同时在线人数

**屏幕共享的两个指示（v2.9.2）**

| 位置 | 显示 | 说明 |
|---|---|---|
| 共享者（共享条） | `👥 3 人观看 · 上行 ≈ 4.5 Mbps（每路 1.50）` | 人数 × 每路码率（只跟帧率有关：**24–48fps→1.5M、60fps→3M**），每路加系统音频 128k；≥85% 出口估值时转红并提示 |
| 观看者（浮窗） | `● 良好 · 延迟 42ms · 30fps` | nominated candidate-pair RTT + 增量丢包 + 解码帧率；2 秒刷新（与语音通话质量徽标同一套算法） |
| 出口估值 | 默认 30 Mbps（本机实测 ≈29） | 可改：`localStorage.setItem('screen-uplink-mbps','50')` |
| 观看到底几人 | 以**服务端名单**为准（`screen_viewers`） | 服务端按 watch/unwatch/断线维护；共享者本人不计入（v2.9.3 起） |
| 可选档位 | 画质 480p / 720p / 1080p / **2K**；帧率 **24 / 36 / 48 / 60** | 每路码率只跟帧率有关：24–48fps→1.5 Mbps、60fps→3 Mbps（老设置自动迁移） |

## 三、项目目录结构

```
chatroom2/
├── pom.xml
├── 构建Uchat.bat                    # 一键构建（JDK17 + Maven）并部署到根目录，旧 jar 自动备份
├── 启动Uchat.bat                    # 启动服务（固定堆 768m）
├── 稳定运行Uchat.bat                # 守护启动：崩溃自动重启 + 保持唤醒（推荐长时间/局域网运行）
├── 保持唤醒.ps1                     # 免管理员阻止主机空闲休眠（SetThreadExecutionState）
├── 停止Uchat.bat
├── backup\                          # 构建时自动备份的旧 jar（含改造前的 2.3.1 原版）
├── src/main/java/com/chatroom2/
│   ├── ChatRoomApplication.java
│   ├── config/                     # WebSocketConfig, CorsConfig, IpWhitelistFilter, WhitelistHandshakeInterceptor
│   ├── controller/                 # FileController, PrefsController, ChatHttpController, HealthController, PomodoroController, TurnController
│   ├── model/                      # Message, Room, UserManager, UserSession, AuthTokenStore
│   ├── websocket/                  # ChatWebSocketHandler
├── src/main/resources/static/
│   ├── index.html, config.js, test.html
│   ├── css/light.css, dark.css
│   └── js/                         # app.js, chat.js, webrtc.js, screen.js, file.js
├── tools/                          # 第三方工具
├── data/                           # 运行时数据
├── logs/                           # 聊天日志
└── backup/                         # 项目备份
```

---

## 四、后端核心类与方法

### 4.1 [ChatRoomApplication.java](src/main/java/com/chatroom2/ChatRoomApplication.java)

Spring Boot 入口，无额外逻辑。

### 4.2 [ChatWebSocketHandler.java](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java)

**核心消息处理器**，处理所有 WebSocket 消息类型。

| 方法 | 说明 |
|---|---|
| [`handleTextMessage`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | **消息总路由**：解析 JSON → 根据 `type` 字段分发到 25+ 个 handler |
| [`handleAuth`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 登录/注册认证 + 注册码校验 |
| [`doLogin`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 完成登录：加入房间、推送历史、通知屏幕共享、广播用户列表 |
| [`handleChat`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 文字消息：频率限制 → 身份校验 → 存入历史 → 广播 |
| [`handlePrivate`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 私聊：频率限制 → 身份校验 → 收件人必须是注册用户 → **落盘 `PrivateStore`** → 在线直发并标记已投递 / 离线留库待补投 → 回 `chat_ack`（v2.8.0 起） |
| [`handleRecall`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 撤回消息：校验 3 分钟时限 |
| [`handleScreenStart/Stop`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 屏幕共享：synchronized 原子拦截，同一时间仅允许一人 |
| [`handleScreenStatus`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 服务端权威查询屏幕共享状态 |
| [`handleScreenWatch`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 新加入者主动请求观看屏幕共享 |
| [`handleMusicRoom*`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 听歌房：最多 4 人，轮流选歌，15 分钟自动切 |
| ~~`handleVoiceJoin/Leave/Data`~~ | — | ~~语音中继（WebSocket PCM），最多 16 人~~ **v2.4.0 已删除**（前端从未发送这三个消息，属死代码；且 raw PCM over WS 与 WebRTC 音频会双路重叠） |
| [`handleRoomEnter`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 通话房间管理：视频2间+语音2间，各4人，按 subtype 路由；幂等（重复 enter/重连直接补发权威 `room_state`） |
| [`markCallRoomUnstable`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 掉线时保留通话席位（宽限期 45s）并通知对端「重连中」，不再立即拆连接 |
| [`broadcastCallRoomsState`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 广播全部 4 个房间状态给参与者和非参与者（150ms 去抖，延后重放而不是丢弃） |
| [`isVideoSignalAllowed`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 视频信令门禁：会话归属 + 接收者在线 + 载荷上限 + 收发双方同房间 + 单独限流 |
| [`isScreenSignalAllowed`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 屏幕共享信令门禁（屏幕共享与会话房间无关，故不做同房间约束） |
| [`handleMediaState`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 转发麦克风/摄像头开关状态给同房间成员（对端画角标） |
| [`afterConnectionClosed`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 断线宽限期：标记断线而非立即移除，聊天 6 分钟内可重连；通话席位保留 45 秒 |
| [`isSessionOwner`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 校验 WebSocket 连接确属声称的昵称，防消息伪造 |
| [`isRateLimited`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 聊天频率限制：每用户每秒最多 10 条消息 |
| [`isSignalRateLimited`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 信令频率限制：SDP/ICE 单独配额（默认 60 条/秒），与聊天限流分开计数 |
| [`broadcastUserList`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 广播在线+离线用户列表 |
| [`saveLogToFile`](src/main/java/com/chatroom2/websocket/ChatWebSocketHandler.java) | 关闭时将聊天记录写入 `logs/chatlog_*.txt` |

### 4.3 [Room.java](src/main/java/com/chatroom2/model/Room.java)

**房间状态容器**，线程安全。

| 方法 | 说明 |
|---|---|
| [`join`](src/main/java/com/chatroom2/model/Room.java) | 加入房间：断线用户自动重连替换 session |
| [`disconnect`](src/main/java/com/chatroom2/model/Room.java) | 标记断线（5分钟宽限期） |
| [`broadcast`](src/main/java/com/chatroom2/model/Room.java) | 向所有在线用户广播 |
| [`sendTo`](src/main/java/com/chatroom2/model/Room.java) | 向指定用户发送 |
| [`addHistory`](src/main/java/com/chatroom2/model/Room.java) | 添加消息到历史（1 秒节流 + 10 秒定时兜底，上限 200 条） |
| [`saveToFile`](src/main/java/com/chatroom2/model/Room.java) / [`loadFromFile`](src/main/java/com/chatroom2/model/Room.java) | 持久化 / 恢复 |

### 4.4 [UserManager.java](src/main/java/com/chatroom2/model/UserManager.java)

**用户账户管理**，PBKDF2WithHmacSHA256（100,000 次迭代）+ 16 字节随机 salt 哈希存储，旧格式自动迁移升级。

| 方法 | 说明 |
|---|---|
| [`register`](src/main/java/com/chatroom2/model/UserManager.java) | 注册：校验密码 6-18 位 |
| [`authenticate`](src/main/java/com/chatroom2/model/UserManager.java) | 认证：PBKDF2/SHA-256+salt/SHA-256 三级兼容 |
| [`changePassword`](src/main/java/com/chatroom2/model/UserManager.java) | 改密：先认证再更新 |

### 4.5 [UserSession.java](src/main/java/com/chatroom2/model/UserSession.java)

封装单个用户的 WebSocket 连接。

| 方法 | 说明 |
|---|---|
| [`send`](src/main/java/com/chatroom2/model/UserSession.java) | 向该用户发送消息（断线状态自动跳过） |
| [`markDisconnected`](src/main/java/com/chatroom2/model/UserSession.java) | 标记为断线，记录时间戳 |
| [`reconnect`](src/main/java/com/chatroom2/model/UserSession.java) | 用新 WebSocket 替换断线的 session |
| [`isOnline`](src/main/java/com/chatroom2/model/UserSession.java) | 判断是否在线（未断线且 WebSocket 开启） |

### 4.6 [Message.java](src/main/java/com/chatroom2/model/Message.java)

**消息模型**，Gson JSON 序列化。提供 `auth`、`chat`、`privateMsg`、`recall`、`system`、`welcome`、`userlist` 等静态工厂方法。

### 4.7 [FileController.java](src/main/java/com/chatroom2/controller/FileController.java)

REST API，路径 `/api/files`。支持文件/图片上传（≤100MB/10MB）、列表、下载、预览。下载/预览需 AuthTokenStore token 鉴权。

### 4.8 [PrefsController.java](src/main/java/com/chatroom2/controller/PrefsController.java)

REST API，路径 `/api/prefs`。用户偏好（字体、主题、设备选择等）的加载/保存。

### 4.9 [WebSocketConfig.java](src/main/java/com/chatroom2/config/WebSocketConfig.java)

注册端点 `/ws/chat` → `ChatWebSocketHandler`，注入 `WhitelistHandshakeInterceptor`，配置 256KB 消息缓冲区 + 30 分钟 idle 超时。CORS 来源通过 `chat.allowed-origins` 可配置。

### 4.10 [IpWhitelistFilter.java](src/main/java/com/chatroom2/config/IpWhitelistFilter.java) / [WhitelistHandshakeInterceptor.java](src/main/java/com/chatroom2/config/WhitelistHandshakeInterceptor.java)

IP 白名单双层防护。HTTP 层通过 Servlet Filter，WebSocket 层通过 HandshakeInterceptor。配置 `chat.ip-whitelist.enabled=true` + `chat.ip-whitelist.ips=IP1,IP2`。

### 4.11 [ChatHttpController.java](src/main/java/com/chatroom2/controller/ChatHttpController.java)

HTTP 轮询模式备用通道，路径 `/api/chat`。用于 WebSocket 不可用的网络环境。

### 4.12 [AuthTokenStore.java](src/main/java/com/chatroom2/model/AuthTokenStore.java)

登录后发放 64 位随机 token，桥接 WebSocket 认证与 HTTP 文件访问。FileController 下载/预览接口校验 token。

### 4.13 [CorsConfig.java](src/main/java/com/chatroom2/config/CorsConfig.java)

全局 CORS 配置，`chat.allowed-origins` 属性控制允许的来源域名，默认 `*`。

### 4.14 [PrivateStore.java](src/main/java/com/chatroom2/model/PrivateStore.java)（v2.8.0）

**私聊存储**（离线私聊 + 私聊断线补齐的唯一数据源），JVM 内单例，落盘 `user.dir/data/private.dat`
（第 1 行元数据 JSON + 之后每行一条记录；临时文件 + 原子替换；1 秒节流 + 10 秒兜底线程）。

| 能力 | 说明 |
|---|---|
| 写入 | `add(msg, json)`：每条私聊都入库（在线/离线都入），初始 `delivered=false` |
| 离线补投 | `pendingFor(nick)` / `undeliveredCount(nick)` / `undeliveredBySender(nick)` / `markDeliveredFor(nick)` |
| 断线补齐 | `sinceFor(nick, since)` / `relatedTo(nick)` / `oldestFor` / `newestFor` |
| 可见性 | 所有查询都以「本人是发件人**或**收件人」为条件 ⇒ 第三方一条都拿不到 |
| 容量与诚实边界 | 全局 2000 条、单收件人 200 条；超出丢最旧并按收件人累计 `droppedFor(nick)`，客户端如实提示"补不齐" |

### 4.15 [Message.java](src/main/java/com/chatroom2/model/Message.java)（v2.8.0 新增字段）

`offlineMsg`（private：该帧是补投的离线私聊）、`unread`/`unreadCount`/`dropped`（private_pending：未读汇总）。
⚠️ 补投标记不能叫 `offline` —— 该名字已被 `userlist` 的离线用户列表（`List<String> offline`）占用。

---

## 五、Web 前端核心模块

### 5.1 [app.js](src/main/resources/static/js/app.js)

主入口和 UI 逻辑。登录、用户列表、设置面板、表情、骰子、听歌房 UI、番茄钟、环境音效、随机决策、工具按钮管理、数学符号面板。
**私聊（v2.8.0）**：对方离线也能开窗/发送；本地历史每条带 `msgId` 并按 `msgId` 去重；未读角标画在用户列表的联系人行上（打开窗口清零）；
服务端补投的离线消息显示 `[离线]` 标记且不自动弹窗；发送走 Outbox（持久化队列 + 断线重发）。

### 5.2 [chat.js](src/main/resources/static/js/chat.js)

WebSocket 通信和消息渲染。消息总路由、Markdown 渲染、文件卡片、图片灯箱、消息搜索、心跳。
**重连**：指数退避（首次约 0.5s，`1/2/4/8/15` 秒封顶，±25% 抖动，永不放弃）+ 心跳 5 秒；
`online` / `visibilitychange` / `focus` / `pageshow` 事件立即重试；连接代次号过滤旧 socket 的迟到事件；
认证看门狗（10 秒无 `auth_resp` 强制重试）。重连期间认证被拒不会退出登录。

### 5.2.1 [outbox.js](src/main/resources/static/js/outbox.js)（v2.5.0 建立，v2.8.0 覆盖私聊）

发送队列 / 重发 / 去重 / 未读通知。私聊与公聊共用同一队列：`enqueue` 不覆盖私聊的乐观渲染（由 app.js 负责）、
`onPrivateFail` 按 `msgId` 精确标记失败、`syncBadges()` 供私聊窗口重绘后补角标。

### 5.3 [webrtc.js](src/main/resources/static/js/webrtc.js)

WebRTC Mesh 音视频通话。ICE 配置（STUN + TURN 临时凭据）由 `/api/turn` 下发；
ICE 候选排队；逐对等体码率/帧率自适应（按人数 + 实时丢包率/RTT 降档与恢复）；
ICE restart 自愈；音量增益与可选「增强降噪」收敛为单一音频链（浏览器原生 AEC/NS/AGC 默认开启）；
质量角标显示丢包率 + RTT + 受限原因；媒体状态角标（🔇/📸）；说话检测共用同一个 AudioContext。

### 5.4 [screen.js](src/main/resources/static/js/screen.js)

屏幕共享 (getDisplayMedia)。**480p/720p/1080p/2K** + **24/36/48/60fps** 切换、查看器拖拽/缩放/最大化、新人主动请求观看。

### 5.5 [file.js](src/main/resources/static/js/file.js)

文件拖拽上传 + 粘贴上传。

---

## 六、消息类型速查

| type | 方向 | 说明 |
|---|---|---|
| `auth` | C→S | 登录/注册请求 |
| `auth_resp` | S→C | 认证结果 |
| `chat` | C↔S | 文字消息。带 `msgId`；**v2.5.0 起 `msgId` 是服务端幂等键的一半**（重发必须复用同一 `msgId`，否则会被当成新消息） |
| `chat_ack` | S→C | **v2.5.0** 服务端回执：`msgId` + `serverTime` + `duplicate`。`duplicate:true` = 该 `(昵称, msgId)` 此前已处理过、**本次未再入库/广播** ⇒ 客户端应出队并标记成功 |
| `sync_since` | C→S | **v2.5.0** 断线补齐请求：`since`（毫秒时间戳；**省略 / 0 / 非法值 = 全量**）。计入既有频率限制 |
| `sync_result` | S→C | **v2.5.0** 补齐结果：`messages`（**原始消息 JSON 字符串**数组，与广播逐字一致，客户端可直接复用正常渲染）+ `count` + `truncated` + `oldest`/`newest`。`truncated:true` = 请求起点早于服务端缓冲区起点（**缓冲区上限 200 条**）⇒ 缺口可能补不齐。**v2.8.1 起**：缓冲区为空时一律 `false`（清空聊天记录后老客户端带旧 `since` 重连不再误报）；v2.8.0 起 `messages` 里还可能包含**本人涉及的私聊** |
| `private` | C↔S | 私聊消息。**v2.8.0 起对方离线也能发**：消息一律落盘 `data/private.dat`，在线则顺手直发、离线则等对方上线补投（补投的帧带 `offlineMsg:true`）。幂等去重与 `chat_ack` 同样生效；只有「收件人不是注册用户」「给自己发」才回 `private_fail`（带 `msgId`）。私聊不进公共 history，但 `sync_since` 会按时间戳补**本人涉及的**私聊 |
| `private_pending` | S→C | **v2.8.0** 登录时的未读私聊汇总：`unreadCount`（未投递总条数）+ `unread`（发件人 → 条数）+ `dropped`（因容量上限补不齐的条数，>0 时客户端如实提示）。**先于逐条补投下发**，在逐条补投前到达 |
| `recall` | C↔S | 撤回消息 |
| `system` | S→C | 系统通知 |
| `userlist` | S→C | 在线用户列表（含离线） |
| `file` | C↔S | 文件消息元数据 |
| `typing` | C↔S | 正在输入 |
| `room_enter/leave` | C↔S | 进入/退出通话（含 `subtype`: video/voice, `online`: 房间号） |
| `room_state` | S→C | 通话房间状态（含 `subtype` 区分视频/语音，`online` 房间号）。加入者会**立即**收到一份权威状态，不必等广播 |
| `room_peer_unstable` | S→C | 同房间成员掉线（宽限期内），对端显示「⏳重连中」而不是拆连接 |
| `room_peer_resume` | S→C | 宽限期内重连成功，恢复通话 |
| `media_state` | C↔S | 麦克风/摄像头开关状态（`audioOn`/`videoOn`），转发给同房间成员画角标 |
| `call_status` | S→C | 4 房间人数（video1/video2/voice1/voice2） |
| `call_rooms_state` | C→S | 请求广播当前全部房间状态 |
| `video_offer/answer/ice` | C↔S | WebRTC 视频信令（服务端校验：身份 + 接收者在线 + 载荷上限 + 同房间 + 限流） |
| `screen_start/stop` | C↔S | 屏幕共享状态 |
| `screen_offer/answer/ice` | C↔S | WebRTC 屏幕信令（同样有五重校验，且不再支持无 receiver 的全局广播） |
| `screen_status` / `screen_status_resp` | C→S / S→C | 查询屏幕共享状态 |
| `screen_watch` / `screen_new_viewer` | C→S / S→C | 新人请求/通知观看屏幕共享 |
| `screen_active` / `screen_blocked` | S→C | 通知活跃共享 / 拦截通知 |
| ~~`voice_join/leave/data`~~ | — | ~~语音中继（WebSocket PCM）~~ **v2.4.0 已删除** |
| `music_room_*` | C↔S | 听歌房操作（join / leave / pick / skip / reject） |
| `music_room_meta` | C→S | 点歌人上报当前曲目时长（秒）→ 服务端精确安排下一轮 |
| `music_room_fail` | C→S | 点歌人上报"放不出来"（版权/外链失效）→ 服务端广播提示并自动跳过 |
| `heartbeat` / `heartbeat_ack` | C↔S | 心跳（**v2.4.0 起 5s 间隔**，连续丢失主动重连） |
| `history_start/end` | S→C | 历史消息分隔标记 |
| `quit` | C→S | 主动退出 |
| `auth_change_pwd` / `auth_change_pwd_ok/fail` | C↔S | 修改密码 |

---

## 七、v2.4.0 新增（音视频通话加固）

| 功能 | 说明 |
|---|---|
| TURN/STUN 下发 | `GET /api/turn`（`TurnController`）按 coturn `use-auth-secret` 下发 1 小时有效的 TURN 临时凭据；未配置时只回 STUN |
| ICE 候选排队 | 远端描述就绪前的 candidate 排队重放，不再静默丢弃（视频与屏幕共享两条链路） |
| 信令五重校验 | 会话归属 + 接收者在线 + 载荷上限（默认 32KB）+ 收发双方同房间 + 单独限流（默认 60/s） |
| 通话宽限期 | 掉线保留席位 45 秒（`chat.call.grace-ms`），对端显示「重连中」；重连后自动恢复 |
| 媒体状态角标 | `media_state` 同步麦克风/摄像头开关，对端画面显示 🔇 / 📸 |
| ICE restart 自愈 | `disconnected` 4 秒超时或 `failed` 时自动重启 ICE；`window.online` 时主动重协商 |
| 逐对等体码率自适应 | 按人数设码率/帧率；按实时丢包/RTT 自动降档（降码率 → 仅语音）与恢复 |
| Opus 抗丢包 | SDP 打开 `useinbandfec=1` / `usedtx=1` / `stereo=0` / `maxaveragebitrate` |
| 原生音频处理 | 打开浏览器 `echoCancellation` / `noiseSuppression` / `autoGainControl`（旧版三项全关） |
| 音频链收敛 | 增益 + 可选增强降噪合并为唯一一条链，新老 peer 音质一致 |
| 屏幕共享增强 | 视频轨 `contentHint='text'`、按帧率设码率上限、`maintain-resolution` |
| 通话容量 | 语音 2 间（12 / 6 人）、视频 2 间（8 / 6 人）；主聊天室总容量 **16 人** |
| 重连机制重写 | 首次重试 30s → 约 0.5s，指数退避封顶 15s，**永不放弃**（旧版 5 分钟后踢回登录页）；心跳 10s → 5s |
| 主机侧稳定性 | `稳定运行Uchat.bat`（守护重启）+ `保持唤醒.ps1`（免管理员阻止休眠）；排查见 DEPLOY.md §4.3 |
| 服务端自愈 | 写失败主动关闭连接（不再让死连接挂 30 分钟）；快速重连静默处理（不再刷屏） |

## 八、v2.3.1 新增

| 功能 | 说明 |
|---|---|
| 用户自定义状态 | 预设+自定义，实时同步，用户列表显示 |
| 番茄钟服务端持久化 | `PomodoroController`，数据存 `data/users/{nick}/pomodoro.json` |
| 健康检查 | `HealthController` GET `/api/health`，返回状态/运行时间/内存 |
| 看门狗守护进程 | 每10s检测，3连败自动重启服务器，生成诊断转储 |
| 系统托盘启动器 | PowerShell 托盘图标，显隐切换，Stop & Exit 杀进程树 |
| 诊断转储 | 关闭时写 `logs/diag/*.txt`（UTF-8 BOM） |
| 重连优化 | 30s间隔×10次（5分钟），宽限期6分钟，僵死连接主动踢 |
| 重连消息去重 | `history_start` 清空聊天区 |
| 心跳日志静默 | 服务端不再打印心跳 `[MSG]` |
| 测试端启动器 | `test-client.bat` |

## 九、v2.2.0 特性清单

| 功能 | 说明 |
|---|---|
| 注册/登录/改密 | PBKDF2（100,000 次迭代）+ 注册码验证 |
| 文字聊天 | Markdown、KaTeX 数学公式、@提及、引用回复、粘贴图片上传 |
| 私聊 | 持久化历史、离线不丢消息 |
| 消息撤回 | 3 分钟内 |
| 文件/图片 | 拖拽/粘贴上传、图片灯箱，下载需 token 鉴权 |
| 视频通话 | WebRTC Mesh、AI 降噪（关/柔和/强力）、自适应分辨率、2间各8人 |
| 纯语音通话 | 独立 2 间（12 / 6 人）、紧凑 UI、说话检测高亮、网络质量列表 |
| 屏幕共享 | 480p–2K、24–60fps、三层防覆盖、定向信令路由 |
| 语音中继 | WebSocket PCM，最多 16 人 |
| 听歌房 | 最多 4 人、轮流选歌 |
| 骰子/表情 | 骰子动画 + 40 个 emoji |
| 消息搜索 | 多关键词高亮 + 发言人选单 |
| 主题切换 | 亮色/暗色、自定义字体/字号/聊天背景 |
| 断线重连 | 3 分钟宽限期 + 自动重连 + 通话自动恢复 |
| IP 白名单 | HTTP + WebSocket 双层拦截 |
| 频率限制 | 每秒每用户 10 条 |
| 数学符号面板 | 55 个 LaTeX 常用符号一键插入 |
| 环境音效 | 雨声/咖啡馆/篝火/白噪音 |
| 番茄钟 | 工作/休息循环、每日目标环形进度条、阶段长进度条、累计统计 |
| 随机决策 | 滚动动画随机抽取 |
| 消息防伪造 | isSessionOwner 身份校验 |
| CORS 配置 | 全局可配置，部署时锁定域名 |
| 测试面板 | /test.html 多用户模拟器，5 种测试场景 |

## 十、v2.1.0 特性清单（历史）

| 功能 | 说明 |
|---|---|
| 注册/登录/改密 | SHA-256 + 16 字节随机 salt |
| 文字聊天 | Markdown、KaTeX 数学公式、@提及、引用回复、粘贴图片上传 |
| 私聊 | 持久化历史、离线不丢消息 |
| 消息撤回 | 3 分钟内 |
| 文件/图片 | 拖拽/粘贴上传、图片灯箱 |
| 视频通话 | WebRTC Mesh、AI 降噪（关/柔和/强力）、自适应分辨率、2间各8人 |
| 纯语音通话 | 独立 2 间（12 / 6 人）、紧凑 UI、说话检测高亮、网络质量列表 |
| 屏幕共享 | 720p-1440p、15-60fps、三层防覆盖、定向信令路由 |
| 语音中继 | WebSocket PCM，最多 16 人 |
| 听歌房 | 最多 4 人、轮流选歌 |
| 骰子/表情 | 骰子动画 + 40 个 emoji |
| 消息搜索 | 多关键词高亮 + 发言人选单 |
| 主题切换 | 亮色/暗色、自定义字体/字号/聊天背景 |
| 断线重连 | 5 分钟宽限期 |
| IP 白名单 | HTTP + WebSocket 双层拦截 |
| 频率限制 | 每秒每用户 10 条 |
| 数学符号面板 | 55 个 LaTeX 常用符号一键插入 |
| 环境音效 | 雨声/咖啡馆/篝火/白噪音 |
| 番茄钟 | 番茄/倒计时/正计时 |
| 随机决策 | 滚动动画随机抽取 |
| 消息防伪造 | isSessionOwner 身份校验 |
| 插件框架 | Java 插件接口 + 前端插件系统 + REST API 管理 |
