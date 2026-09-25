@echo off
rem Uchat AI user (chat bot) launcher
rem waits for the Uchat service, then runs the bot; restarts it if it exits
cd /d %~dp0
set "UCHAT_ROOT=%~dp0.."

rem ---- locate bun ----
set "BUN="
for %%B in ("C:\Users\you\.cherrystudio\bin\bun.exe") do if exist %%B set "BUN=%%~B"
if not defined BUN if exist "%~dp0bun_path.txt" set /p BUN=<"%~dp0bun_path.txt"
if not defined BUN (
    echo [BOT] bun not found. Put its full path into bot\bun_path.txt and retry.
    pause
    exit /b 1
)

:: bot login password (kept out of git; set UCHAT_BOT_PASSWORD or bot_login.pwd)
if not defined UCHAT_BOT_PASSWORD if exist "%~dp0bot_login.pwd" set /p UCHAT_BOT_PASSWORD=<"%~dp0bot_login.pwd"

rem ---- require an API key (bot.pwd or dsapi.txt, either location) ----
set "HAVEKEY="
for %%A in ("%~dp0bot.pwd") do if exist "%%~fA" if %%~zA GTR 0 set "HAVEKEY=1"
for %%A in ("%~dp0dsapi.txt") do if exist "%%~fA" if %%~zA GTR 0 set "HAVEKEY=1"
for %%A in ("%~dp0..\dsapi.txt") do if exist "%%~fA" if %%~zA GTR 0 set "HAVEKEY=1"
if not defined HAVEKEY (
    echo [BOT] no API key - put it in bot\dsapi.txt or bot\bot.pwd. Not starting.
    timeout /t 10 /nobreak >nul
    exit /b 0
)

rem ---- skip if a bot instance is already running (bot.lock holds its PID) ----
set "OLDPID="
if exist "%~dp0bot.lock" set /p OLDPID=<"%~dp0bot.lock"
if defined OLDPID (
    tasklist /FI "PID eq %OLDPID%" 2>nul | findstr /I "bun.exe" >nul && (
        echo [BOT] already running PID %OLDPID%, this launcher exits.
        exit /b 0
    )
)

rem ---- wait until the Uchat service answers ----
:wait
netstat -ano -p TCP | findstr /C:":8888 " | findstr LISTENING >nul 2>&1
if errorlevel 1 (
    echo [BOT] waiting for Uchat service on 8888 ...
    timeout /t 3 /nobreak >nul
    goto wait
)

rem ---- skip if another instance is already running (check by process command line) ----
if defined BUSY (
    echo [BOT] another instance is already running, this launcher exits.
    exit /b 0
)

rem ---- skip if another instance is already running ----
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check_running.ps1" "chatbot\.mjs(?!.*--config)"
if errorlevel 9 (
    echo [BOT] another instance is already running, this launcher exits.
    exit /b 0
)

:loop
echo [BOT] starting AI user ...
"%BUN%" "%~dp0chatbot.mjs" %* >> "%~dp0bot.log" 2>&1
set "RC=%ERRORLEVEL%"
if "%RC%"=="3" (
    echo [BOT] another instance is already running, this launcher exits.
    exit /b 0
)
if "%RC%"=="2" (
    echo [BOT] no API key, retry in 60s
    timeout /t 60 /nobreak >nul
    goto loop
)
echo [BOT] bot exited rc=%RC%, restart in 15s
timeout /t 15 /nobreak >nul
goto loop
