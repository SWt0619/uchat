/* Default config — 由客户端启动器动态覆盖 */
window.CHAT_SERVER_HOST = window.CHAT_SERVER_HOST || '';  // WebSocket 目标
window.CHAT_SERVER_PORT = window.CHAT_SERVER_PORT || 0;
window.API_SERVER_HOST = window.API_SERVER_HOST || '';    // REST API 目标（可与 WS 不同）
window.API_SERVER_PORT = window.API_SERVER_PORT || 0;
window.IS_CLIENT_MODE = window.IS_CLIENT_MODE || false;
window.USE_HTTP_MODE = window.USE_HTTP_MODE || false;     // 纯 HTTP 模式（VPN 环境 WebSocket 不可用时）

/*
 * 生产部署说明：
 * 1. 此文件默认留空，前端自动从 location.host 推断服务器地址。
 *    只要通过 Nginx/Caddy 反向代理访问，无需修改任何配置。
 * 2. 如果前后端分离部署（域名不同），在此设置：
 *    window.CHAT_SERVER_HOST = 'chat-api.example.com';
 *    window.API_SERVER_HOST = 'chat-api.example.com';
 * 3. HTTPS 下 WebSocket 会自动使用 wss://，API 会自动使用 https://。
 * 4. 后端配置文件 application.properties 中需要设置：
 *    chat.allowed-origins=https://your-domain.com
 */
