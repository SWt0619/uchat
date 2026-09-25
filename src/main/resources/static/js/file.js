/* ===== file.js — 文件上传 (HTTP POST + WebSocket 元数据) ===== */

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;  // 10MB
const MAX_FILE_SIZE = 100 * 1024 * 1024;  // 100MB

const fileInput = $('file-input');
const fileBtn = $('btn-file');

fileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
    Array.from(fileInput.files).forEach(uploadFile);
    fileInput.value = '';
});

// ==================== Drag & Drop ====================
const messageArea2 = $('message-area');

messageArea2.addEventListener('dragover', (e) => {
    e.preventDefault(); e.stopPropagation();
    messageArea2.style.background = 'var(--accent-light)';
});

messageArea2.addEventListener('dragleave', (e) => {
    e.preventDefault(); e.stopPropagation();
    messageArea2.style.background = '';
});

messageArea2.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    messageArea2.style.background = '';
    Array.from(e.dataTransfer.files).forEach(uploadFile);
});

document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
        Array.from(e.dataTransfer.files).forEach(uploadFile);
    }
});

// ==================== Upload via HTTP POST ====================
async function uploadFile(file) {
    if (isOffline()) { showToast('连接已断开，请先重连', 'error'); return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        showToast('未连接到服务器', 'error');
        return;
    }

    const isImage = file.type && file.type.startsWith('image/');
    const maxSize = isImage ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;

    if (file.size > maxSize) {
        showToast('文件过大: ' + file.name + ' (' + formatFileSize(file.size) + ')，上限 ' + formatFileSize(maxSize), 'error');
        return;
    }

    showToast('正在上传: ' + file.name, 'info');

    try {
        const formData = new FormData();
        formData.append('file', file);

        // 2026-09-25：上传接口加了鉴权（防未登录灌磁盘），请求要带 nickname+token
    const uploadUrl = getApiBaseUrl() + '/api/files/upload?' + getFileAuthParams();
        const resp = await fetch(uploadUrl, {
            method: 'POST',
            body: formData
        });

        const result = await resp.json();

        if (!resp.ok) {
            showToast('上传失败: ' + (result.error || '文件格式不支持'), 'error');
            return;
        }

        // Send metadata via WebSocket (small message, no base64)
        ws.send(JSON.stringify({
            type: 'file',
            nickname: nickname,
            filename: result.name,
            size: result.size,
            filetype: result.type,
            chunk: 0,
            total: 1,
            msgId: Date.now() + '_' + Math.random()
        }));

        showToast('文件发送完成: ' + file.name, 'success');
    } catch (e) {
        showToast('网络错误，上传失败，请重试', 'error');
    }
}
