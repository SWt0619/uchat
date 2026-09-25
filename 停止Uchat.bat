@echo off
chcp 936 >nul 2>&1
title 停止 Uchat
:: ★ 先停看门狗（稳定运行Uchat.bat 的循环）。否则它会立刻把刚停掉的服务重新拉起来。
::   看门狗窗口的标题以 "Uchat" 开头（bat 里 title 设的），这里按标题前缀精确匹配，不误伤其他窗口。
taskkill /F /FI "WINDOWTITLE eq Uchat*" >nul 2>&1

:: ★ 静默模式（静默运行Uchat.vbs）下没有窗口，上面那句杀不到任何东西。
::   必须先停「静默守护进程」与托盘监视，否则守护进程 3 秒内就会把服务重新拉起来；
::   顺带把两个 AI 与 TURN 一起收掉（下次静默启动会重新拉起）。
if exist "%~dp0静默停止Uchat.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0静默停止Uchat.ps1"


echo 正在停止占用 8888 端口的 Uchat 服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8888" ^| findstr "LISTENING"') do (
    echo   停止进程 PID: %%a
    taskkill /F /PID %%a >nul 2>&1
)
echo.
echo 完成。若提示"未找到"，说明服务本就未在运行。
timeout /t 3 >nul
