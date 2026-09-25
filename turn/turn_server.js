// Uchat 本地 TURN 中继（node-turn）—— 解决对称 NAT / CGNAT 下 WebRTC 打不通的问题
// 由 启动TURN.bat 调用；配置读取同目录 turn.json（含凭据，不入 git）
const fs = require('fs');
const path = require('path');
const Turn = require('node-turn');

const cfgPath = path.join(__dirname, 'turn.json');
let cfg;
try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (e) {
    console.error('[TURN] 读不到 ' + cfgPath + '：' + e.message);
    process.exit(1);
}

const user = cfg.username || 'uchat';
const pass = cfg.password;
const port = cfg.port || 3478;
const realm = cfg.realm || 'uchat';

if (!pass) {
    console.error('[TURN] turn.json 里没有 password，拒绝启动');
    process.exit(1);
}

const server = new Turn({
    authMech: 'long-term',
    credentials: { [user]: pass },
    realm: realm,
    listeningPort: port,
    debugLevel: cfg.debug ? 'ALL' : 'INFO',
    // 不显式指定 listeningIps/relayIps → 自动使用本机所有网卡（含内网 IP）
});

server.start();
console.log('[TURN] 已启动：port=' + port + ' realm=' + realm + ' user=' + user);
console.log('[TURN] 另需在服务端 ICE 配置里告知客户端该 TURN 地址（见 TurnController）');

process.on('SIGINT', () => { console.log('[TURN] 收到中断，退出'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[TURN] 收到终止，退出'); process.exit(0); });
