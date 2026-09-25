# 保持唤醒.ps1 — 阻止 Windows 因空闲进入睡眠（无需管理员权限）
#
# 为什么需要：Uchat 的服务端就跑在这台机器上。这台机器一旦休眠、或网卡进入省电
# 状态，所有客户端到它的 TCP 连接会同时断开 —— 这正是"主机一掉线，其他人全掉线"
# 的根因（服务端是单点）。SetThreadExecutionState 是 Windows 的应用级
# "我还在干活"声明：只要本进程活着，系统就不会因空闲休眠。
#
# 故意不加 ES_DISPLAY_REQUIRED：屏幕照常可以自动关闭（省电、不刺眼），
# 关屏不影响网络。需要连屏幕也常亮时加 -KeepDisplayOn。

param([switch]$KeepDisplayOn)

$code = @'
using System;
using System.Runtime.InteropServices;
public static class SleepGuard {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
    public const uint ES_CONTINUOUS       = 0x80000000u;
    public const uint ES_SYSTEM_REQUIRED  = 0x00000001u;
    public const uint ES_DISPLAY_REQUIRED = 0x00000002u;
}
'@

try {
    Add-Type -TypeDefinition $code -ErrorAction Stop
} catch {
    Write-Host "[保持唤醒] 初始化失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$flags = [uint32]([SleepGuard]::ES_CONTINUOUS -bor [SleepGuard]::ES_SYSTEM_REQUIRED)
if ($KeepDisplayOn) {
    $flags = [uint32]($flags -bor [SleepGuard]::ES_DISPLAY_REQUIRED)
    Write-Host "[保持唤醒] 模式：系统与显示器都保持常亮" -ForegroundColor Cyan
} else {
    Write-Host "[保持唤醒] 模式：只阻止系统休眠（显示器仍可自动关闭）" -ForegroundColor Cyan
}

$r = [SleepGuard]::SetThreadExecutionState($flags)
if ($r -eq 0) {
    Write-Host "[保持唤醒] 设置失败（可能被组策略限制）。可改用手动方式：设置 - 系统 - 电源，把睡眠改为从不。" -ForegroundColor Yellow
    exit 1
}

$start = Get-Date
Write-Host "[保持唤醒] 已生效。请让本窗口保持运行；按 Ctrl+C 或关闭窗口即解除。" -ForegroundColor Green

try {
    while ($true) {
        Start-Sleep -Seconds 30
        # 系统从睡眠恢复、或切换电源方案时该声明可能被重置，周期性重申一次
        [void][SleepGuard]::SetThreadExecutionState($flags)
        $mins = [int]((Get-Date) - $start).TotalMinutes
        if ($mins -gt 0 -and ($mins % 5) -eq 0) {
            Write-Host "[保持唤醒] 运行中，已保持 $mins 分钟"
        }
    }
} finally {
    [void][SleepGuard]::SetThreadExecutionState([SleepGuard]::ES_CONTINUOUS)
    Write-Host "[保持唤醒] 已解除，系统可以正常休眠了。" -ForegroundColor Yellow
}
