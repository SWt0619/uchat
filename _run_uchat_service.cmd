@echo off
REM ------------------------------------------------------------------
REM  ASCII wrapper used by the SILENT supervisor (????Uchat.ps1) to start the service.
REM
REM  Why a wrapper file instead of passing the java command straight to
REM  `Start-Process cmd /c "<...>"`: cmd's /c quote-stripping mangles a command line
REM  that both starts with a quote and contains more quotes (java path + jar path + redirect
REM  = 6 quotes) -> java was never started and no output file was created at all.
REM  A wrapper .cmd whose path contains no spaces has no quoting problem whatsoever.
REM
REM  Env: reads keystore/invite/turn passwords from the local .pwd files when not already set.
REM ------------------------------------------------------------------
setlocal
cd /d "%~dp0"
set "JAVA=%~dp0java\bin\java.exe"
set "JAR=%~dp0uchat.jar"
if not defined UCHAT_KEYSTORE_PWD  if exist "%~dp0keystore.pwd"    set /p UCHAT_KEYSTORE_PWD=<"%~dp0keystore.pwd"
if not defined UCHAT_INVITE_CODE   if exist "%~dp0invite.pwd"      set /p UCHAT_INVITE_CODE=<"%~dp0invite.pwd"
if not defined UCHAT_TURN_PASSWORD if exist "%~dp0turn\turn.pwd"   set /p UCHAT_TURN_PASSWORD=<"%~dp0turn\turn.pwd"
if not exist "%~dp0logs" mkdir "%~dp0logs"
"%JAVA%" -Xmx768m -jar "%JAR%" --server.port=8888 >> "%~dp0logs\_service_stdout.log" 2>&1
exit /b %ERRORLEVEL%
