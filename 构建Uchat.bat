@echo off
setlocal enabledelayedexpansion
title Uchat 构建

:: ============================================================
:: 构建 Uchat，并把产物部署到根目录（旧的 uchat.jar 自动备份进 backup）
::
:: 两个要点：
::  1) 用项目自带的 JDK 17（java 目录）构建。pom 的目标版本是 17，
::     运行 App 用的也是同一个 JDK，产物与运行环境保持一致。
::     系统默认的 JAVA_HOME 是 JDK 25，两者不要混用。
::  2) PATHEXT 必须包含 .EXE。surefire 会用 cmd 调起不带扩展名的 java，
::     若 PATHEXT 被异常改写，会报 "The forked VM terminated" 以及
::     "java 不是内部或外部命令"。
::
:: 本文件是 GBK 编码、且不使用 chcp。cmd 在 936 代码页下原生解析 GBK，
:: 中文注释与输出都正常；若改成 UTF-8 再加 chcp 65001，cmd 会误行
:: （中文双字节会吞掉紧跟的反斜杠，导致 :: 注释行被当命令执行）。
:: ============================================================
set "PATHEXT=.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"

cd /d "%~dp0"
set "JAVA_HOME=%~dp0java"
set "MVN=D:\Dev\maven\apache-maven-3.9.16\bin\mvn.cmd"

if not exist "%MVN%" (
    echo [错误] 未找到 Maven: %MVN%
    echo        请确认 Maven 已安装在 D:\Dev\maven\apache-maven-3.9.16
    pause
    exit /b 1
)
if not exist "%JAVA_HOME%\bin\javac.exe" (
    echo [错误] 未找到内置 JDK: %JAVA_HOME%\bin\javac.exe
    echo        请确认 java 文件夹已完整拷贝。
    pause
    exit /b 1
)

echo ==========================================
echo   Uchat 构建
echo   JDK  : %JAVA_HOME%
echo   Maven: %MVN%
echo ==========================================
echo.

call "%MVN%" -B clean package
if errorlevel 1 (
    echo.
    echo [失败] 构建未通过，根目录的 uchat.jar 保持不变。
    pause
    exit /b 1
)

echo.
echo [部署] 备份旧 jar，然后替换根目录 uchat.jar
if not exist "%~dp0backup" mkdir "%~dp0backup"
if exist "%~dp0uchat.jar" (
    set "TS="
    for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%i"
    if not defined TS set "TS=previous"
    copy /y "%~dp0uchat.jar" "%~dp0backup\uchat_!TS!.jar" >nul
    echo        旧版本已备份: backup\uchat_!TS!.jar
)
copy /y "%~dp0target\uchat.jar" "%~dp0uchat.jar" >nul
if errorlevel 1 (
    echo [错误] 复制到根目录失败，请检查 uchat.jar 是否被占用（服务是否还在运行）。
    pause
    exit /b 1
)

echo.
echo ==========================================
echo   构建成功，uchat.jar 已更新
echo   启动服务: 启动Uchat.bat 或 稳定运行Uchat.bat
echo ==========================================
pause
