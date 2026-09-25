@echo off
cd /d %~dp0
netstat -ano -p UDP | findstr /C:":3478 " >nul 2>&1
if not errorlevel 1 exit /b 0
echo [TURN] starting local relay on UDP 3478 ...
start "" /b "C:\Users\you\.cherrystudio\bin\bun.exe" turn_server.js >> turn.log 2>&1
