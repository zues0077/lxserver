@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Soda Signer - do not close this window

set "NODE_EXE="

rem --- 1) portable node.exe in the same folder (best, zero dependency) ---
if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"

rem --- 2) node from PATH (skip the Microsoft Store stub) ---
if not defined NODE_EXE (
  for /f "delims=" %%i in ('where node 2^>nul') do (
    echo %%i | findstr /i /c:"WindowsApps" >nul
    if errorlevel 1 if not defined NODE_EXE set "NODE_EXE=%%i"
  )
)

rem --- 3) usual install locations ---
if not defined NODE_EXE (
  for %%p in (
    "%LOCALAPPDATA%\Programs\nodejs\node.exe"
    "%ProgramFiles%\nodejs\node.exe"
    "%ProgramFiles(x86)%\nodejs\node.exe"
  ) do if not defined NODE_EXE if exist %%p set "NODE_EXE=%%p"
)

rem --- 4) managed / portable dirs (WorkBuddy, nvm) ---
if not defined NODE_EXE (
  for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if not defined NODE_EXE if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
  )
)
if not defined NODE_EXE (
  for /d %%d in ("%APPDATA%\nvm\v*") do (
    if not defined NODE_EXE if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
  )
)

rem --- verify it actually runs ---
if defined NODE_EXE (
  "%NODE_EXE%" -e "process.exit(0)" >nul 2>nul
  if errorlevel 1 set "NODE_EXE="
)

if defined NODE_EXE goto :run

type "%~dp0msg\no_node.txt"
echo.
pause
exit /b 1

:run
echo [node] %NODE_EXE%
echo.
type "%~dp0msg\starting.txt"
echo.
rem 读取配置里的端口（默认 18080），启动后自动打开配置页
set "SIGNER_PORT=18080"
for /f "delims=" %%p in ('"%NODE_EXE%" -e "const fs=require('fs');try{const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(c.port||18080)}catch(e){console.log(18080)}" "%~dp0config.json" 2^>nul') do set "SIGNER_PORT=%%p"
start "" cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:%SIGNER_PORT%/ >nul 2>nul"
"%NODE_EXE%" "%~dp0signer.js" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" goto :stopped

type "%~dp0msg\crash.txt"
echo.
echo   [exit code %RC%]
echo.
pause
exit /b %RC%

:stopped
type "%~dp0msg\stopped.txt"
echo.
pause
exit /b 0
