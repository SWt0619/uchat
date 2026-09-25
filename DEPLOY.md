# Uchat 服务端部署指南

## 一、环境要求

- **Java 17** 或更高版本（`java -version` 确认）
- **Maven**（用于编译打包，`mvn -version` 确认）
- 操作系统：Windows / macOS / Linux 均可

## 二、快速启动（本地测试）

### 2.1 编译打包

本机已装好 Maven（`D:\Dev\maven\apache-maven-3.9.16`，依赖走阿里云镜像，本地仓库在 `D:\Dev\maven\repository`），
详见 `D:\Dev\maven\使用说明.md`。项目里也放好了一键脚本：

**双击 `构建Uchat.bat`** —— 它会用项目自带的 JDK 17 执行 `mvn -B clean package`，
跑完 24 个单测后把产物部署到根目录（旧 `uchat.jar` 自动备份进 `backup\`）。

手动构建等价于：

```bash
# 用项目自带的 JDK 17（pom 的 target 是 17，运行时用的也是它）
set "JAVA_HOME=%~dp0java"
mvn -B clean package

# 或直接命令行
mvn package -DskipTests        # 只要产物、不跑测试
mvn test                       # 只跑测试（24 个用例）
```

> 手动构建时若报 `The forked VM terminated without properly saying goodbye`，
> 检查 `PATHEXT` 是否包含 `.EXE`（surefire 用 cmd 调起不带扩展名的 `java`）；
> `构建Uchat.bat` 里已显式重置，不受影响。

### 2.2 启动

```bash
# 开发环境
mvn spring-boot:run

# 生产环境（打包后）
java -jar uchat.jar
# 或双击 启动Uchat.bat
```

本机浏览器访问 `http://localhost:8888`。

## 三、公网部署（让外网用户访问）

### 方案 A：内网穿透（最省事，无需公网 IP）

使用樱花 FRP：

1. 注册账号：https://sakurafrp.com
2. 创建隧道：TCP 类型，本地 IP `127.0.0.1`，本地端口 `8888`
3. 下载启动器，登录后启动隧道
4. 获得访问地址如 `xxx.sakurafrp.com:12345` 发给用户即可

> ⚠️ **不要把隧道改成 HTTP 类型、也不要开启「自动 HTTPS」**（2026-09-23 实测踩到的坑）：
> 本机服务是 **HTTPS-only**（默认 `server.ssl.enabled=true`），而 HTTP 型/自动TLS 隧道会在**樱花节点解开 TLS**、
> 再以**明文 HTTP** 转发到 `127.0.0.1:8888` ⇒ Tomcat 直接回
> **`400 Bad Request — This combination of host and port requires TLS.`**，表现为"穿透突然用不了了"。
>
> **正确做法：隧道保持 TCP 类型**，让 TLS 端到端到本机。自签证书会让浏览器提示"不安全"，
> 点「高级 → 继续前往」即可；想彻底消除提示请走 §方案 B（真证书）或 T6 任务书里的 mkcert。
>
> **当前节点 `your-tunnel.example.com`，对外端口 `64911`** ⇒ 访问地址 **`https://your-tunnel.example.com:PORT/`**。
> ⚠️ 旧文档里的 `old-tunnel.example.com` 已失效（实测 `old-tunnel.example.com:64911` 与 `:27609` 两个端口都 ConnectionRefused）。
> 樱花免费隧道的**节点与端口可能变化**，以启动器里显示的为准。
>
> **三种情况如何自查**（都在本机跑即可）：
> | 现象 | 含义 |
> |---|---|
> | 本机 `https://127.0.0.1:8888/api/health` → `200 {"status":"ok"…}` | 服务本身正常 |
> | 隧道地址返回 `400 … requires TLS`（且 TLS 证书 CN 是 `SakuraFrp Automatic TLS`） | 节点在替你做 TLS 终止 ⇒ **改回 TCP 类型** |
> | 隧道地址返回带 `Server: SakuraFrp` 的 `501 Not Implemented` | 节点是 HTTP 型隧道且没匹配到域名/路径规则 |

### 方案 B：云服务器 + 域名 + Nginx（推荐生产环境）

**1. 准备云服务器**

最低配置 1 核 2G，安装 Java 17：

```bash
# Ubuntu/Debian
apt install openjdk-17-jdk-headless nginx

# 上传 uchat.jar 到服务器
scp target/uchat.jar user@your-server:/home/user/uchat/
```

**2. 域名 DNS 解析**

在域名控制台添加 A 记录，指向服务器公网 IP。

**3. 配置 Nginx 反向代理**

`/etc/nginx/sites-available/uchat`：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # WebSocket 升级
    location /ws/ {
        proxy_pass http://127.0.0.1:8888;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 1800s;
    }

    # 普通 HTTP
    location / {
        proxy_pass http://127.0.0.1:8888;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

启用站点：

```bash
ln -sf /etc/nginx/sites-available/uchat /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

**4. 申请免费 SSL 证书**

```bash
# 安装 certbot
apt install certbot python3-certbot-nginx

# 自动配置证书
certbot --nginx -d your-domain.com
```

证书 90 天有效期，certbot 会自动续期。

## 四、配置文件说明

`application.properties` 中关键配置项：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `server.port` | 8888 | 服务端口 |
| `chat.allowed-origins` | `*` | CORS 允许的来源域名，**部署到公网应改为具体域名** |
| `chat.ip-whitelist.enabled` | false | 是否开启 IP 白名单 |
| `chat.ip-whitelist.ips` | （空） | 白名单 IP，逗号分隔 |
| `chat.max-message-length` | 5000 | 单条消息最大字符数 |
| `chat.stun.urls` | Google STUN | 逗号分隔的 STUN 列表；Google STUN 在国内常不可达，建议配自建 |
| `chat.turn.host` | （空） | TURN 地址（如 `turn:turn.example.com:3478`）；**留空 = 未启用 TURN** |
| `chat.turn.tls-host` | （空） | TURN over TLS 地址（如 `turns:turn.example.com:5349`），用于 UDP 被封的网络 |
| `chat.turn.secret` | （空） | 与 coturn `static-auth-secret` 一致；**不要写死长期账号密码** |
| `chat.turn.realm` | uchat | 需与 turnserver.conf 的 realm 一致 |
| `chat.turn.ttl` | 3600 | 下发凭据的有效期（秒） |
| `chat.call.max-per-room` | 4 | 每个通话房间人数上限（Mesh 物理上限，详见下节） |
| `chat.signaling.max-per-sec` | 60 | 信令（SDP/ICE）每用户每秒上限 |
| `chat.signaling.max-payload-bytes` | 32768 | 单个 SDP/ICE 载荷上限 |
| `chat.call.grace-ms` | 45000 | 通话掉线宽限期；期间对端显示「重连中」而非直接断线 |

环境变量覆盖：`server.ssl.key-store-password` 读 `UCHAT_KEYSTORE_PWD`（未设置时回落到内置默认值）。

### 4.1 TURN 中继部署（**公网通话必需**）

只配 STUN 时，双方都在对称 NAT / 运营商 CGNAT / 企业防火墙后面就**必然连不上**（浏览器只能靠 host candidate 直连）。
部署 coturn 并把配置填进 `application.properties` 后，服务端会通过 `GET /api/turn` 下发 1 小时有效的临时凭据：

```ini
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=<随机 32 字节 hex>
realm=uchat
# 企业网常封 UDP → 同时开 TCP/TLS 中继
no-udp-relay=0
no-tcp-relay=0
total-quota=100
stale-nonce=600
cert=/etc/letsencrypt/live/your-domain.com/fullchain.pem
pkey=/etc/letsencrypt/live/your-domain.com/privkey.pem
```

```properties
chat.turn.host=turn:turn.example.com:3478
chat.turn.tls-host=turns:turn.example.com:5349
chat.turn.secret=<与 static-auth-secret 相同>
chat.turn.realm=uchat
```

验证：浏览器打开 `https://你的域名/api/turn`，应返回 `{"iceServers":[...],"turnEnabled":true}`；
再让两端分别用「手机 4G」和「家里 WiFi」进同一个通话房间，能建立连接即说明 TURN 生效。

### 4.2 通话房间为什么是 4 人

本项目用**纯 P2P Mesh**（服务端只转发信令，不碰媒体）：N 人时每个人都要给其余 N−1 人各发一路上行。
8 人 = 每端 7 路上行（≈4 Mbps 纯视频码流），家庭宽带上不可行。因此默认上限 4 人。
若要更多人的会议，需要引入 SFU（mediasoup / Janus / LiveKit 等）——届时每人上行降到 1 路。

### 4.3 局域网稳定性（服务端在主机上 ⇒ 主机是单点）

**先说结论：主机掉线时其他用户"立刻全掉"不是重连逻辑的 bug，而是架构使然。**
服务端进程就跑在主机上，客户端与它之间是直连的 TCP/WebSocket。主机一旦休眠、网卡省电掉链子、
或进程退出，所有客户端到它的连接会在同一瞬间断开（TCP 是连接导向的，没有"服务端离线但客户端还连着"这种状态）。
能改善的是两件事：**别让主机掉**，以及**掉线后多快能回来**。

#### ① 判断到底是谁掉线了（3 分钟定位）

在主机上保留 `启动Uchat.bat` 的窗口，出问题时看它：

| 现象 | 结论 |
|---|---|
| 主机窗口还在正常打印日志，客户端全掉 | 主机的**网络**断了（网卡省电 / WiFi 抖动 / DHCP 续租），JVM 还活着 |
| 主机窗口自己消失了 / 打印异常退出 | **服务端进程**崩了，用 §4.3-③ 的守护模式启动 |
| 主机窗口长时间无任何输出，之后客户端掉线 | 主机**休眠**了（最常见），用 §4.3-② 的保持唤醒 |

补充判断：让另一台机器 `ping 主机IP -t` 同时观察，若 client 掉线的同时 ping 也超时，那就是主机网络层的问题。

#### ② 别让主机休眠 / 网卡省电（本次已附脚本，免管理员）

直接双击 **`稳定运行Uchat.bat`**（它做两件事：启动保持唤醒 + 崩溃自动重启），
或者单独运行保活脚本：

```bat
:: 只阻止系统休眠（显示器仍可自动关闭）
powershell -NoProfile -ExecutionPolicy Bypass -File 保持唤醒.ps1
:: 需要屏幕也常亮时
powershell -NoProfile -ExecutionPolicy Bypass -File 保持唤醒.ps1 -KeepDisplayOn
```

`保持唤醒.ps1` 用 `SetThreadExecutionState` 声明"本进程还在干活"，**不需要管理员权限**，
也不会改你的电源计划。另外建议手动检查三项（这些需要管理员/图形界面，脚本不代劳）：

1. **网卡省电**：设备管理器 → 网络适配器 → 你的无线网卡 → 属性 → 电源管理 →
   **取消**"允许计算机关闭此设备以节约电源"。这一项是 WiFi 周期性微断的首因。
2. **无线适配器节能模式**：设置 → 系统 → 电源和电池 → 电源模式 → 高级 →
   无线适配器设置 → 节能模式 = **最高性能**。
3. **睡眠**：设置 → 系统 → 电源和电池，把"使用电池/接通电源时，经过以下时间后使设备进入睡眠"改为**从不**。

> 若主机是笔记本且用 WiFi，条件允许时**接有线网**；也可以让主机插着电源跑。

#### ③ 让服务端进程崩了能自己起来

`稳定运行Uchat.bat` 是一个 `:loop` 守护外壳：JVM 退出（崩溃/被杀）后 3 秒自动重新拉起，
并且在每轮启动前清理占用 8888 端口的残留进程。Ctrl+C 结束整个脚本。

`/api/health` 端点可用于外挂监控（返回状态/运行时间/内存），示例：

```bash
# 每 10 秒探测一次，失败 3 次就重启（Linux 用 systemd 的 Restart=on-failure 更省事）
```

#### ④ 别让客户端的"地址"失效

客户端连的是它在地址栏里输入的 `location.host`。如果主机用 DHCP 且 IP 变了，
**客户端会一直重连一个已经不属于主机的地址，永远回不来**。所以：

- 给主机配**静态 IP**，或在路由器里做 **DHCP 保留（绑定 MAC）**；
- 或者用主机名访问（部分路由器/系统支持 `主机名.local` 的 mDNS 解析）；
- 客户端侧把地址存成书签，避免手输错。

#### ⑤ 不要用主机的"移动热点"当 AP

如果其他人是连到**主机自己开的热点**上，那么主机就是整个网络的中心：主机一抖，所有人一起掉，
而且客户端连"回不来"的原因也可能是热点重新分配了网段。这种场景请换成独立路由器/AP。

#### ⑥ 掉线后多快回来（本次重连机制已重写）

旧版是**固定 30 秒重试一次，而且第一次也要等满 30 秒**，重试 10 次（5 分钟）后就
`goToLogin()` 把用户踢回登录页并**清空密码框**。也就是说主机重启一次，房间里所有人被迫重新输密码。

现在的策略（`chat.js`）：首次重试约 **0.5 秒**，之后指数退避 `1/2/4/8/15` 秒封顶 15 秒，
带 ±25% 抖动（避免所有人同时打服务器），并**永不放弃**。另外：

- 心跳间隔 10 秒 → **5 秒**，把"TCP 半开（没有 RST）"的发现时间从 30 秒压到 15 秒；
- 监听 `online` / `visibilitychange` / `focus` / `pageshow`，**网络恢复、标签页切回前台时立刻重试**
  （后台标签页里浏览器会把 `setTimeout` 节流到 ≥1 分钟，这些事件是必要补充）；
- 加了连接代次号（`wsToken`）：旧 socket 迟到的 `onclose` 不会再影响刚恢复的会话；
- 加了认证看门狗：连上了但 10 秒收不到 `auth_resp` 会强制重试，避免卡死在"正在重连"；
- 重连期间认证被拒（例如服务端刚重启）**不再退出登录**，保留凭据继续退避重试。

实测（对 `reconnectDelay()` 真实代码做 300 次模拟，中位数）：

| 主机离线时长 | 旧版 | 新版 |
|---|---|---|
| 2 秒 | **30.0 秒** | **3.5 秒** |
| 5 秒 | 30.0 秒 | 7.4 秒 |
| 15 秒 | 30.0 秒 | 16.8 秒 |
| 30 秒 | 30.0 秒 | 34.6 秒 |
| 120 秒 | 120.0 秒 | 127.6 秒 |
| 300 秒 | 300.0 秒 | 307.1 秒 |
| **600 秒（主机重启）** | **放弃 → 踢回登录页，需重输密码** | **608.1 秒自动恢复** |

服务端同时做了两处配合改动：

- **写失败即关闭连接**（`UserSession.send`）：旧版只打印一行日志，于是服务端会一直以为那个用户"在线"
  （直到容器 idle 超时，本机配置 30 分钟），期间用户列表、广播、重连判定全部基于错误状态；
  现在主动关连接 → 容器触发正常断开流程 → 客户端立刻重连。
- **快速重连不再刷屏**（`supersededSessions`）：主机抖动后所有客户端几乎同时回来，
  旧 socket 的关闭事件会晚于新连接到达，导致每个人都收到一轮
  "X 断开了连接 / X 已重连" 系统消息；现在这类"被顶替的旧连接"静默处理。

公网部署时务必修改：

```properties
chat.allowed-origins=https://your-domain.com
```

#### ⑦ 证书：内容是受信任的，但只签了你自己的域名，而且快到期了

`keystore.p12`（**唯一别名 `uchat`**）里装的是 **ZeroSSL 签发的 DV 证书**（`CN=YOUR-DOMAIN.example.com`，
签发者 `ZeroSSL RSA DV SSL CA 2` → Sectigo R46 根）—— **不是自签证书**，浏览器不会报"不受信任"。
但有两点要注意：

**A. 它只覆盖 `YOUR-DOMAIN.example.com` / `www.YOUR-DOMAIN.example.com`，不含 IP 和 `your-tunnel.example.com`**

| 访问方式 | 会有提示吗 | 为什么 |
|---|---|---|
| `https://YOUR-DOMAIN.example.com[:端口]` | **完全没有** | 域名与 SAN 一致、且受信任 |
| `https://your-tunnel.example.com:PORT` | **有**："名称不匹配" | 证书受信任，但 SAN 里没有这个域名 |
| `https://192.168.x.x:8888` / `https://127.0.0.1:8888` | **有**：名称不匹配 | SAN 里没有 IP |

> 想让隧道访问也**零提示**：给你自己域名加一条解析指向隧道节点（`your-tunnel.example.com` / `60.215.128.232`），
> 然后用 `https://xxx.YOUR-DOMAIN.example.com:64911/` 访问即可（端口不影响证书校验）。
> 这样做同时满足**手机端相机/麦克风**的前提（需要受信任的安全上下文）。
> ⚠️ 用 IP 访问时 JDK 的 `HttpClient` 访问 `wss://127.0.0.1` 必然握手失败（SAN 无 IP）
> ⇒ 脚本化测试用 `--server.ssl.enabled=false`（只绑回环时安全）或 Python `CERT_NONE`。

**B. ⏰ 到期时间：2026-09-24 07:59:59（北京时间）** —— 证书 2026-06-25 签发，90 天 DV。

续期步骤（ZeroSSL / Let's Encrypt 都适用）：

```bash
# 1) 拿到新的 fullchain.crt + privkey.key（ZeroSSL 面板下载，或 certbot 签发）
# 2) 生成 p12（别名要与原来一致：uchat）
openssl pkcs12 -export -in fullchain.crt -inkey privkey.key \
  -out new-keystore.p12 -name uchat -passout pass:你的口令
# 3) 替换（先备份！）并重启服务
copy keystore.p12 keystore.p12.bak
copy new-keystore.p12 keystore.p12
```

或直接用 keytool 导入到原 keystore（`-destalias uchat`，口令见环境变量 `UCHAT_KEYSTORE_PWD`，或同目录的 `keystore.pwd`）。
⚠️ 到期后会**所有访问方式**都报证书错误（含隧道），务必在到期前续。
2. **用 JDK 的 `HttpClient` 访问 `wss://127.0.0.1:8899` 会直接握手失败**（端点识别无法关闭）。所以脚本化端到端测试要么
   加 `--server.ssl.enabled=false`（只绑 127.0.0.1 时是可接受的），要么用 Python `ssl` + `verify_mode=CERT_NONE`。
3. **手机端会因此不可用**（相机/麦克风要求受信任的安全上下文）—— 见暂缓的 T6 任务。

要让本机/局域网也不再报警告：自签时**加入 IP SAN**，例如

```
subjectAltName = DNS:YOUR-DOMAIN.example.com, DNS:www.YOUR-DOMAIN.example.com, \
                 DNS:localhost, DNS:<主机名>, IP:127.0.0.1, IP:192.168.x.x
```

重新导出 p12（`openssl pkcs12 -export -in fullchain.pem -inkey privkey.pem -out keystore.p12 -name tomcat`）
后更新 `server.ssl.*` 即可；手机端还需在设备上信任对应根证书（见 T6 任务书）。

## 五、作为系统服务运行（Linux）

创建 Systemd 服务文件 `/etc/systemd/system/uchat.service`：

```ini
[Unit]
Description=Uchat Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/home/user/uchat
ExecStart=/usr/bin/java -Xmx256m -jar /home/user/uchat/uchat.jar
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now uchat
systemctl status uchat
```

## 六、数据与备份

| 文件/目录 | 用途 |
|---|---|
| `data/users.dat` | 用户账号和密码哈希 |
| `data/room.dat` | 聊天记录（最多 200 条） |
| `data/users/{nickname}/prefs.json` | 用户偏好设置 |
| `data/users/shared/files/` | 上传的文件 |
| `logs/` | 服务端运行日志 |

日常备份只需保存 `data/` 目录。删除 `data/room.dat` 和 `data/users.dat` 可清空聊天记录和用户信息，重新启动即可。

## 七、故障排查

| 现象 | 可能原因 | 解决 |
|---|---|---|
| 端口被占用 | 上次未正常退出 | 脚本自动杀旧进程，或手动 `taskkill /F /IM java.exe` |
| WebSocket 频繁断线 | Tomcat idle timeout 过短 | 已默认 30 分钟，如仍有问题检查代理超时设置 |
| 文件上传失败 | 超过大小限制 | 普通文件 100MB，图片 10MB |
| 通话连不上 / 一直转圈 | **未部署 TURN**，双方不在同一 NAT 后 | 按 §4.1 部署 coturn 并填写 `chat.turn.*`；两端网络不同时必需 |
| 对方外放时听到回声 | 浏览器 AEC 被关闭 | v2.4.0 已默认开启（`echoCancellation:true`），确认没有旧版 JS 缓存 |
| 画面模糊 / 卡顿 | 上行带宽不足 | 界面右下角角标会显示丢包率与 ↓带宽/↓仅语音；Mesh 下建议 ≤4 人 |
| 房间已满 | 语音房 12 / 6 人、视频房 8 / 6 人（v2.9.0 起） | 换另一间；需要更多人的会议请引入 SFU（§4.2） |
| **主机一掉线，其他人同时全掉** | 服务端在主机上，主机是单点（网络层） | 见 §4.3：先按表格定位是网络、休眠还是进程崩溃，再按对应小节处理 |
| **掉线后长时间回不来 / 被踢回登录页** | 主机 IP 变了，或旧版"重试 10 次就放弃" | 给主机配静态 IP（§4.3-④）；v2.4.0 已改为永不放弃的指数退避重连（§4.3-⑥） |
