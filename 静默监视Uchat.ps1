# 静默监视Uchat.ps1 —— 用一个托盘图标汇报「Uchat 服务是否正常」
#
# 由 静默运行Uchat.ps1（或 静默运行Uchat.vbs）以隐藏窗口方式启动；也可以单独运行来排查。
#
# 为什么要它：改成静默运行后桌面上没有窗口可看，需要一个"一眼就知道"的东西。
#   · 🟢 绿点 = /api/health 返回 200 且 status=ok
#   · 🟡 黄点 = 启动中 / 连续 1 次探测失败（可能只是抖动）
#   · 🔴 红点 = 连续 2 次失败（服务不在了）
#   · 状态发生变化时弹一个气泡提醒（恢复/掉线都会提醒），并写 logs\_status_monitor.log
#   · 右键菜单：打开 Uchat / 打开日志目录 / 立即检查 / 重启服务 / 停止 Uchat（全部）/ 退出监视
#
# 探测方式刻意不用 Invoke-WebRequest：本机的 PowerShell HTTP 栈在部分会话里不可靠，
# 这里直接 TcpClient + SslStream 手写一个 HTTP/1.1 请求（自签证书照收），最稳。
param([switch]$Once, [switch]$Verbose2)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$monLog = Join-Path $logDir '_status_monitor.log'
$statusFile = Join-Path $logDir '_service_status.json'

function Say([string]$m) {
    Add-Content -LiteralPath $monLog -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
    if ($Verbose2) { Write-Host $m }
}

# ---------------- 健康探测：TcpClient + SslStream + 手写 HTTP ----------------
function Test-UchatHealth([int]$timeoutMs = 3000) {
    $res = [ordered]@{ ok = $false; detail = ''; ms = 0 }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $client = $null; $ssl = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect('127.0.0.1', 8888, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($timeoutMs)) { throw 'TCP 连接超时' }
        $client.EndConnect($iar)

        $ssl = New-Object System.Net.Security.SslStream($client.GetStream(), $false,
                    ([System.Net.Security.RemoteCertificateValidationCallback] { param($a, $b, $c, $d) $true }))
        $ssl.ReadTimeout = $timeoutMs
        $ssl.WriteTimeout = $timeoutMs
        $ssl.AuthenticateAsClient('127.0.0.1')

        $req = "GET /api/health HTTP/1.1`r`nHost: 127.0.0.1:8888`r`nUser-Agent: uchat-tray`r`nConnection: close`r`n`r`n"
        $bytes = [Text.Encoding]::ASCII.GetBytes($req)
        $ssl.Write($bytes, 0, $bytes.Length)
        $ssl.Flush()

        $sr = New-Object IO.StreamReader($ssl, [Text.Encoding]::UTF8)
        $head = $sr.ReadToEnd()
        $sr.Close()
        $sw.Stop()
        $res.ms = [int]$sw.ElapsedMilliseconds
        if ($head -match 'HTTP/1\.[01]\s+200') {
            if ($head -match '"status"\s*:\s*"ok"') { $res.ok = $true; $res.detail = '健康 (HTTP 200, status=ok)' }
            else { $res.ok = $true; $res.detail = '有响应 (HTTP 200)' }
        } else {
            $first = ($head -split "`r`n")[0]
            $res.detail = 'HTTP 异常: ' + $first
        }
    } catch {
        $sw.Stop()
        $res.ms = [int]$sw.ElapsedMilliseconds
        $res.detail = '探测失败: ' + $_.Exception.Message
    } finally {
        if ($ssl) { try { $ssl.Dispose() } catch { } }
        if ($client) { try { $client.Close() } catch { } }
    }
    return $res
}

if ($Once) {
    $r = Test-UchatHealth
    Write-Host ('ok={0} ms={1} {2}' -f $r.ok, $r.ms, $r.detail)
    exit ([int](-not $r.ok))
}

# ---------------- 单实例 ----------------
$mtx = New-Object System.Threading.Mutex($false, 'Local\UchatStatusTray')
try { if (-not $mtx.WaitOne(0)) { exit 0 } } catch { }

# ---------------- 托盘 ----------------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function New-DotIcon([string]$color) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $c = [System.Drawing.Color]::FromName($color)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $c), 1, 1, 13, 13)
    $g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(70, 70, 70)), 1), 1, 1, 13, 13)
    $g.Dispose()
    $h = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($h)
    return $icon
}

$iconOk = New-DotIcon 'green'
$iconWarn = New-DotIcon 'gold'
$iconBad = New-DotIcon 'red'

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $iconWarn
$ni.Text = 'Uchat：正在检查…'
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Add-Item([string]$text, [scriptblock]$handler) {
    $it = New-Object System.Windows.Forms.ToolStripMenuItem($text)
    $it.add_Click($handler)
    [void]$menu.Items.Add($it)
    return $it
}
Add-Item '打开 Uchat' { Start-Process 'https://localhost:8888/' } | Out-Null
Add-Item '打开日志目录' { Start-Process 'explorer.exe' (Join-Path $root 'logs') } | Out-Null
$null = Add-Item '立即检查' { & $script:Check }
Add-Item '重启服务' {
    Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
        Where-Object { $_.CommandLine -like '*uchat.jar*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Say '从托盘请求重启服务（守护进程会在 3 秒内拉起）'
} | Out-Null
Add-Item '停止 Uchat（全部）' {
    $bat = Join-Path $root '停止Uchat.bat'
    if (Test-Path $bat) { Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $bat) -WindowStyle Hidden }
} | Out-Null
Add-Item '退出监视' { $script:Quit = $true; $ni.Visible = $false; [System.Windows.Forms.Application]::ExitThread() } | Out-Null
$ni.ContextMenuStrip = $menu

# ---------------- 状态机 ----------------
# ⚠️ 计数/状态一律放在**哈希表**里：脚本块（timer tick）里对 `$var++` 的赋值落不到脚本作用域，
#    第一版就踩了这个坑 —— `$seq` 永远显示 #1、`$fails` 永远不累加（于是永远停在"抖动"档，
#    既不会升级成红色、也不会记状态变化）。哈希表的属性是引用语义，跨 tick 天然保留。
$script:Quit = $false
$script:st = @{
    fails   = 0
    state   = 'init'      # init / ok / warn / bad
    since   = Get-Date
    upSince = $null
    seq     = 0
}

$script:Check = {
    $st = $script:st
    $st.seq++
    $r = Test-UchatHealth
    $now = Get-Date
    if ($r.ok) {
        $st.fails = 0
        if (-not $st.upSince) { $st.upSince = $now }
    } else {
        $st.fails = $st.fails + 1
    }

    $newState = 'ok'
    if ($st.fails -eq 1) { $newState = 'warn' }
    elseif ($st.fails -ge 2) { $newState = 'bad' }

    switch ($newState) {
        'ok' { $ni.Icon = $iconOk }
        'warn' { $ni.Icon = $iconWarn }
        'bad' { $ni.Icon = $iconBad }
    }

    $up = ''
    if ($newState -eq 'ok' -and $st.upSince) {
        $span = $now - $st.upSince
        $up = ' · 已运行 ' + ('{0:d1}h{1:d2}m' -f [int]$span.TotalHours, $span.Minutes)
    }
    $txt = switch ($newState) {
        'ok' { 'Uchat 运行正常' }
        'warn' { 'Uchat 探测失败 1 次（可能抖动）' }
        default { 'Uchat 无响应！' }
    }
    $ni.Text = ($txt + $up + '（' + $r.ms + 'ms）')
    if ($ni.Text.Length -gt 63) { $ni.Text = $ni.Text.Substring(0, 63) }

    # 状态变化 → 气泡提醒 + 记日志
    if ($newState -ne $st.state) {
        $old = $st.state
        $st.state = $newState
        $st.since = $now
        Say ('状态 {0} → {1}（{2}，{3}ms，连续失败 {4} 次）' -f $old, $newState, $r.detail, $r.ms, $st.fails)

        if ($old -eq 'init' -and $newState -eq 'ok') {
            $ni.BalloonTipTitle = 'Uchat 已静默启动'
            $ni.BalloonTipText = '服务正常。状态图标在右下角托盘（若没看到，点托盘上的 ^ 展开；可拖到常显区）。绿=正常，红=无响应；右键有菜单。'
            $ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
            $ni.ShowBalloonTip(6000)
        } elseif ($newState -eq 'bad') {
            $ni.BalloonTipTitle = 'Uchat 服务无响应'
            $ni.BalloonTipText = ($r.detail + '。守护进程会在服务退出时自动拉起，若持续红色请看 logs\_silent_supervisor.log。')
            $ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Error
            $ni.ShowBalloonTip(8000)
        } elseif ($old -eq 'bad' -and $newState -ne 'bad') {
            $ni.BalloonTipTitle = 'Uchat 已恢复'
            $ni.BalloonTipText = ('服务重新可用（' + $r.detail + '）。')
            $ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
            $ni.ShowBalloonTip(5000)
        }
    } else {
        Say ('检查 #{0}: {1}（{2}ms，连续失败 {3} 次）{4}' -f $st.seq, $r.detail, $r.ms, $st.fails, $up)
    }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({ & $script:Check })
$timer.Start()
$ni.add_MouseDoubleClick({ Start-Process 'https://localhost:8888/' })

Say '托盘状态监视启动（5 秒一次探测 /api/health）'
& $script:Check

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $timer.Stop()
    $ni.Visible = $false
    $ni.Dispose()
    Say '托盘状态监视退出'
}
