@echo off
chcp 936 >nul
cd /d "%~dp0"
:: 密钥库口令：优先用环境变量；缺失则读同目录 keystore.pwd（本机文件，不入 git）
if not defined UCHAT_KEYSTORE_PWD if exist "%~dp0keystore.pwd" set /p UCHAT_KEYSTORE_PWD=<"%~dp0keystore.pwd"
:: TURN 口令：优先环境变量；缺失则读 turn\turn.pwd（本机文件，不入 git）
if not defined UCHAT_TURN_PASSWORD if exist "%~dp0turn\turn.pwd" set /p UCHAT_TURN_PASSWORD=<"%~dp0turn\turn.pwd"
:: 注册码：优先环境变量；缺失则读 invite.pwd（本机文件，不入 git）
if not defined UCHAT_INVITE_CODE if exist "%~dp0invite.pwd" set /p UCHAT_INVITE_CODE=<"%~dp0invite.pwd"
;; Uchat 2026-09-25：跨域来源与管理员名单也只从本机 .pwd 读（仓库里不含部署者信息）
if not defined UCHAT_ALLOWED_ORIGINS if exist "%~dp0allowed-origins.pwd" set /p UCHAT_ALLOWED_ORIGINS=<"%~dp0allowed-origins.pwd"
if not defined UCHAT_ADMINS if exist "%~dp0admins.pwd" set /p UCHAT_ADMINS=<"%~dp0admins.pwd"
title Uchat 稳定运行（守护 + 保持唤醒）

echo ==========================================
echo   Uchat 稳定运行模式
echo   服务进程崩溃会自动重启；主机不会休眠
echo ==========================================
echo.

set "JAVA=%~dp0java\bin\java.exe"
if not exist "%JAVA%" (
    echo [错误] 未找到内置 Java 环境: %JAVA%
    echo        请确认 java 文件夹已完整拷贝。
    pause
    exit /b 1
)

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

echo [1/2] 启动保持唤醒（阻止主机空闲休眠导致全体掉线）...
if exist "%~dp0保持唤醒.ps1" (
    start "Uchat保持唤醒" /min "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0保持唤醒.ps1"
) else (
    echo       [跳过] 未找到 保持唤醒.ps1
)

echo [2/2] 启动服务（退出后 3 秒自动重启，Ctrl+C 结束整个脚本）
echo.
echo   访问地址: https://localhost:8888
echo   局域网用户: https://本机IP:8888
echo ==========================================
echo.

:loop
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8888" ^| findstr "LISTENING"') do (
    echo [提示] 8888 端口已被 PID %%a 占用：说明已有一个 Uchat 服务/守护在运行。
    echo        本窗口退出，不再启动第二个实例 —— 两个实例会互相杀掉对方的 java，
    echo        导致"每几秒断线重连一次"（进语音房秒掉线的元凶）。
    echo        如确实要重启：先双击 停止Uchat.bat，再运行本脚本。
    timeout /t 8 /nobreak >nul
    exit /b 0
)

:: start local TURN relay (UDP 3478) if not running (no window)
netstat -ano -p UDP | findstr /C:":3478 " >nul 2>&1
if errorlevel 1 start "Uchat TURN" /min cmd /c "%~dp0turn\start_turn.bat"
:: start the AI chat user (waits for 8888 by itself)
:: 注意：必须 /min 另开一个控制台。旧写法 start "" /b 让 bot 与本窗口共用控制台，
:: 子进程里的 bun/powershell 会把本窗口代码页改成 UTF-8(65001) => java 的 GBK 日志全成乱码。
if exist "%~dp0bot\start_bot.bat" start "Uchat Bot 大肥鱼" /min cmd /c "%~dp0bot\start_bot.bat"
:: start the 2nd AI user (detailed answers; waits for 8888 by itself)
if exist "%~dp0bot2\start_bot2.bat" start "Uchat Bot 资料鱼" /min cmd /c "%~dp0bot2\start_bot2.bat"
:: 启动 java 前再确认一次代码页（防上面任何一个子进程把它改掉）
chcp 936 >nul
"%JAVA%" -Xmx768m -jar "%~dp0uchat.jar"
set "RC=%ERRORLEVEL%"

echo.
echo [守护] 服务进程已退出（返回码 %RC%），3 秒后自动重启...
timeout /t 3 /nobreak >nul
goto loop
