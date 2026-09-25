# 静默停止Uchat.ps1 —— 停掉静默模式的一整套（守护进程 / 托盘监视 / 服务 / 两个 AI / TURN）
#
# 由 停止Uchat.bat 调用。顺序很重要：必须先停守护进程，否则它会在 3 秒内把刚停掉的服务重新拉起来。
#
# ⚠️ 匹配纪律（2026-09-24 踩过一次，代价是把自己的 shell 杀了）：
#   不能用「命令行里出现某关键字」这种宽松匹配 —— 调用方的命令行里往往就写着这些关键字
#   （例如 `... -like '*u' + 'chat.jar*'`），于是把自己/taskkill 的调用链一起干掉。
#   规则：① 必须同时限定进程名（java.exe / bun.exe / cmd.exe / powershell.exe）；
#        ② 针对本项目的 powershell 脚本，必须带上 `-File` 前缀（脚本调用是 `-File xxx.ps1`，
#           随手 grep 的命令行一般没有）；③ 排除自己与本进程的父进程。
param([switch]$Quiet)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir '_silent_stop.log'

function Say([string]$m) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
    if (-not $Quiet) { Write-Host $line }
}

$selfPid = $PID
$parentPid = 0
try { $parentPid = [int](Get-CimInstance Win32_Process -Filter ("ProcessId=$selfPid")).ParentProcessId } catch { }

# 先停守护进程，再停托盘，然后才是服务/AI/TURN
$targets = @(
    @{ name = 'powershell.exe'; pat = '*-File*静默运行Uchat.ps1*'; why = '静默守护进程' },
    @{ name = 'powershell.exe'; pat = '*-File*静默监视Uchat.ps1*'; why = '托盘状态监视' },
    @{ name = 'java.exe';       pat = '*uchat.jar*';               why = 'Uchat 服务' },
    @{ name = 'bun.exe';        pat = '*chatbot.mjs*';             why = 'AI 用户' },
    @{ name = 'cmd.exe';        pat = '*start_bot*';               why = 'AI 启动器' },
    @{ name = 'bun.exe';        pat = '*turn_server.js*';          why = 'TURN 中继' },
    @{ name = 'cmd.exe';        pat = '*start_turn.bat*';          why = 'TURN 启动器' }
)

Say '开始停止 Uchat（静默模式）'

foreach ($t in $targets) {
    $procs = Get-CimInstance Win32_Process -Filter ("Name='{0}'" -f $t.name) -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            ($_.CommandLine -like $t.pat) -and
            $_.ProcessId -ne $selfPid -and
            $_.ProcessId -ne $parentPid
        }
    foreach ($p in $procs) {
        Say ('停止 {0}（{1}）PID={2}' -f $p.Name, $t.why, $p.ProcessId)
        # /T 连子进程一起收（bot 启动器 cmd → bun 是父子关系）
        & taskkill.exe /F /T /PID $p.ProcessId 2>&1 | Out-Null
    }
}

# 清掉状态文件（避免托盘/排障读到过期状态）
$st = Join-Path $logDir '_service_status.json'
if (Test-Path $st) { Remove-Item -LiteralPath $st -Force -ErrorAction SilentlyContinue }

Say '停止完成（若服务本就未运行，会显示只有本行）'
