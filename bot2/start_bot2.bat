@echo off
rem Uchat AI user #2 - detailed answers with references, mention-only
rem uses bot\chatbot.mjs with its own config/base, so the two bots never collide
cd /d %~dp0

rem ---- locate bun ----
set "BUN="
for %%B in ("C:\Users\you\.cherrystudio\bin\bun.exe") do if exist %%B set "BUN=%%~B"
if not defined BUN if exist "%~dp0bun_path.txt" set /p BUN=<"%~dp0bun_path.txt"
if not defined BUN (
    echo [BOT2] bun not found. Put its full path into bot2\bun_path.txt and retry.
    pause
    exit /b 1
)

:: bot login password (kept out of git; set UCHAT_BOT_PASSWORD or bot_login.pwd)
if not defined UCHAT_BOT_PASSWORD if exist "%~dp0bot_login.pwd" set /p UCHAT_BOT_PASSWORD=<"%~dp0bot_login.pwd"

rem ---- require an API key somewhere ---
set "HAVEKEY="
for %%A in ("%~dp0bot.pwd") do if exist "%%~fA" if %%~zA GTR 0 set "HAVEKEY=1"
for %%A in ("%~dp0dsapi.txt") do if exist "%%~fA" if %%~zA GTR 0 set "HAVEKEY=1"
for %%A in ("%~dp0..\dsapi.txt") do if exist "%%~fA" if %%~zA GTR 0 set "HAVEKEY=1"
if not defined HAVEKEY (
    echo [BOT2] no API key found. Not starting.
    timeout /t 60 /nobreak >nul
    exit /b 0
)

rem ---- skip if another instance is already running (check by process command line) ----
if defined BUSY (
    echo [BOT2] another instance is already running, this launcher exits.
    exit /b 0
)

rem ---- wait for the Uchat service ----
:wait
netstat -ano -p TCP | findstr /C:":8888 " | findstr LISTENING >nul 2>&1
if errorlevel 1 (
    timeout /t 3 /nobreak >nul
    goto wait
)

rem ---- skip if another instance is already running ----
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check_running.ps1" "bot2"
if errorlevel 9 (
    echo [BOT] another instance is already running, this launcher exits.
    exit /b 0
)

:loop
echo [BOT2] starting AI user #2 ...
"%BUN%" "%~dp0..\bot\chatbot.mjs" --config "%~dp0bot_config.json" --base "%~dp0" >> "%~dp0bot2.log" 2>&1
set "RC=%ERRORLEVEL%"
if "%RC%"=="3" (
    echo [BOT2] another instance is already running, this launcher exits.
    exit /b 0
)
if "%RC%"=="2" (
    echo [BOT2] no API key, retry in 60s
    timeout /t 60 /nobreak >nul
    goto loop
)
echo [BOT2] bot exited rc=%RC%, restart in 15s
timeout /t 15 /nobreak >nul
goto loop
