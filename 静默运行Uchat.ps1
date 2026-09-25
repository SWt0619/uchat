# 静默运行Uchat.ps1 —— 全程隐藏地把整套服务跑起来（等效于「稳定运行Uchat.bat + 保持唤醒 + bot + bot2 + turn」，但桌面上不留任何窗口）
#
# 由 静默运行Uchat.vbs 以隐藏窗口方式启动（不要直接双击本文件，会闪一个控制台）。
#
# 职责：
#   1. 单实例互斥（重复启动不会起第二套）
#   2. 阻止系统空闲休眠（SetThreadExecutionState，等价于 保持唤醒.ps1）
#   3. 服务看门狗：每 3 秒确认 java 在跑，不在就拉起来
#      （java 通过同目录的 ASCII 包装脚本 _run_uchat_service.cmd 启动 —— 见那个文件里的注释：
#        直接把 java 命令行交给 `cmd /c "..."` 会被 cmd 的引号剥离规则搞坏，实测 java 根本起不来）
#   4. 服务就绪（端口 8888 可连）后，再保证 TURN / 两个 AI / 托盘监视在 —— 每个最多 15 秒尝试一次，
#      且**只在对应进程确实缺失时**才启动（否则会像第一版那样每 3 秒堆一个启动器进程）
#   5. 状态落盘 logs\_service_status.json（托盘 / 排障读取）
#
# 停止：双击 停止Uchat.bat（它会先停本进程与托盘，再停 java / bot / turn）
param([switch]$Quiet)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$statusFile = Join-Path $logDir '_service_status.json'
$watchLog = Join-Path $logDir '_silent_supervisor.log'
$svcWrapper = Join-Path $root '_run_uchat_service.cmd'

function Say([string]$m) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Add-Content -LiteralPath $watchLog -Value $line -Encoding UTF8
    if (-not $Quiet) { Write-Host $line }
}

# ---------- 单实例 ----------
$mtx = New-Object System.Threading.Mutex($false, 'Local\UchatSilentSupervisor')
try { if (-not $mtx.WaitOne(0)) { exit 0 } } catch { }

# ---------- 阻止休眠 ----------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class USleepGuard {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@ -ErrorAction SilentlyContinue

# ---------- 口令/注册码（优先环境变量，缺失则读本机 .pwd） ----------
function Read-Pwd([string]$rel) {
    $p = Join-Path $root $rel
    if (Test-Path $p) {
        $v = (Get-Content -LiteralPath $p -TotalCount 1 -ErrorAction SilentlyContinue)
        if ($v) { return $v.Trim() }
    }
    return $null
}
if (-not $env:UCHAT_KEYSTORE_PWD) { $env:UCHAT_KEYSTORE_PWD = Read-Pwd 'keystore.pwd' }
if (-not $env:UCHAT_INVITE_CODE) { $env:UCHAT_INVITE_CODE = Read-Pwd 'invite.pwd' }
if (-not $env:UCHAT_TURN_PASSWORD) { $env:UCHAT_TURN_PASSWORD = Read-Pwd 'turn\turn.pwd' }
if (-not $env:UCHAT_ALLOWED_ORIGINS) { $env:UCHAT_ALLOWED_ORIGINS = Read-Pwd 'allowed-origins.pwd' }
if (-not $env:UCHAT_ADMINS) { $env:UCHAT_ADMINS = Read-Pwd 'admins.pwd' }

# ---------- 小工具 ----------
# 注意用正则（-match）而不是通配（-like）：bot1 与 bot2 都跑 bot\chatbot.mjs，
# 只有 bot2 的命令行结尾带 `--config ...`，所以 bot1 用 `chatbot\.mjs"?\s*$` 才能区分（实测验证过）。
function Get-Procs([string]$name, [string]$regex) {
    Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -match $regex) }
}
function Start-Hidden([string]$file, [string[]]$argList, [string]$workDir) {
    Start-Process -FilePath $file -ArgumentList $argList -WorkingDirectory $workDir -WindowStyle Hidden | Out-Null
}
function Test-ServicePort([int]$port = 8888, [int]$timeoutMs = 800) {
    $c = $null
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne($timeoutMs)) { $c.EndConnect($iar); return $true }
        return $false
    } catch { return $false } finally { if ($c) { try { $c.Close() } catch { } } }
}

$svcWrapperPath = Join-Path $root '_run_uchat_service.cmd'
function Start-Service {
    if (-not (Test-Path $svcWrapperPath)) { Say ('缺少服务包装脚本: ' + $svcWrapperPath); return $false }
    Start-Hidden 'cmd.exe' @('/c', $svcWrapperPath) $root
    return $true
}

# ---------- 目标进程的判定模式（正则） ----------
$patJava = 'uchat\.jar'
$patBot1 = 'chatbot\.mjs"?\s*$'      # 结尾就是 chatbot.mjs（不带 --config）＝ 大肥鱼
$patBot2 = 'bot2[\\/]bot_config'     # 资料鱼：--config ...\bot2\bot_config.json
$patTurn = 'turn_server\.js'
$patTray = '静默监视Uchat\.ps1'

$state = @{
    started   = Get-Date
    restarts  = 0
    svcSince  = $null
    lastTry   = @{}          # 各类依赖最近一次尝试启动的时间（节流用）
    seq       = 0
    svcUp     = $false
}

function Ensure-Dep([string]$key, [int]$everySec, [scriptblock]$check, [scriptblock]$start, [string]$label) {
    if (& $check) { return }
    $last = $state.lastTry[$key]
    $now = Get-Date
    if ($last -and ($now - $last).TotalSeconds -lt $everySec) { return }
    $state.lastTry[$key] = $now
    Say ('拉起 ' + $label)
    & $start
}

Say '静默守护启动（无窗口）'
Say ('根目录: ' + $root)

while ($true) {
    try { [void][USleepGuard]::SetThreadExecutionState([uint32]3221225473) } catch { }   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED

    # ---- 服务 ----
    $svc = Get-Procs 'java.exe' $patJava | Select-Object -First 1
    if (-not $svc) {
        $state.svcUp = $false
        if (-not $state.lastTry['svc'] -or ((Get-Date) - $state.lastTry['svc']).TotalSeconds -ge 5) {
            $state.lastTry['svc'] = Get-Date
            Say '服务不在运行 → 拉起'
            if (Start-Service) { $state.restarts++; $state.svcSince = (Get-Date).ToString('o') }
        }
    } else {
        if (-not $state.svcSince) {
            $state.svcSince = $svc.CreationDate.ToString('o')
            Say ('发现已在运行的服务 PID=' + $svc.ProcessId)
        }
        if (-not $state.svcUp) {
            if (Test-ServicePort) {
                $state.svcUp = $true
                Say ('服务端口 8888 已就绪（PID=' + $svc.ProcessId + '），开始检查 TURN / AI / 托盘')
            }
        }
    }

    # ---- 依赖（只在服务就绪后管，避免像第一版那样堆一堆等待中的启动器）----
    if ($state.svcUp) {
        Ensure-Dep 'turn' 20 { Get-Procs 'bun.exe' $patTurn } {
            $bat = Join-Path $root 'turn\start_turn.bat'
            if (Test-Path $bat) { Start-Hidden 'cmd.exe' @('/c', $bat) (Split-Path -Parent $bat) }
        } 'TURN 中继'

        Ensure-Dep 'bot1' 20 { Get-Procs 'bun.exe' $patBot1 } {
            $bat = Join-Path $root 'bot\start_bot.bat'
            if (Test-Path $bat) { Start-Hidden 'cmd.exe' @('/c', $bat) (Split-Path -Parent $bat) }
        } 'AI 用户（大肥鱼）'

        Ensure-Dep 'bot2' 20 { Get-Procs 'bun.exe' $patBot2 } {
            $bat = Join-Path $root 'bot2\start_bot2.bat'
            if (Test-Path $bat) { Start-Hidden 'cmd.exe' @('/c', $bat) (Split-Path -Parent $bat) }
        } 'AI 用户（资料鱼）'

        Ensure-Dep 'tray' 20 { Get-Procs 'powershell.exe' $patTray } {
            $ps1 = Join-Path $root '静默监视Uchat.ps1'
            if (Test-Path $ps1) {
                Start-Hidden 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $ps1) $root
            }
        } '托盘状态监视'
    }

    # ---- 状态落盘 ----
    $state.seq++
    $svc = Get-Procs 'java.exe' $patJava | Select-Object -First 1
    $st = 'starting'
    $pidVal = $null
    if ($svc) { $pidVal = [int]$svc.ProcessId }
    if ($state.svcUp) { $st = 'running' }
    $obj = [ordered]@{
        state           = $st
        pid             = $pidVal
        portUp          = $state.svcUp
        serviceSince    = $state.svcSince
        supervisorSince = $state.started.ToString('o')
        restarts        = $state.restarts
        ticks           = $state.seq
        updatedAt       = (Get-Date).ToString('o')
    }
    try { ($obj | ConvertTo-Json -Compress) | Set-Content -LiteralPath $statusFile -Encoding UTF8 } catch { }

    Start-Sleep -Seconds 3
}
