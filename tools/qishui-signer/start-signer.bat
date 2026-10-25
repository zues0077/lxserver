@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Soda Signer - do not close this window

set "NE="
if exist "%~dp0node.exe" set "NE=%~dp0node.exe"
if defined NE goto :node_ready

for /f "delims=" %%i in ('where node 2^>nul') do (
  echo %%i | findstr /i /c:"WindowsApps" >nul
  if errorlevel 1 if not defined NE set "NE=%%i"
)
if defined NE goto :node_ready

for %%p in (
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
  "%ProgramFiles%\nodejs\node.exe"
  "%ProgramFiles(x86)%\nodejs\node.exe"
) do if not defined NE if exist %%p set "NE=%%p"
if defined NE goto :node_ready

for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
  if not defined NE if exist "%%d\node.exe" set "NE=%%d\node.exe"
)
if defined NE goto :node_ready

for /d %%d in ("%APPDATA%\nvm\v*") do (
  if not defined NE if exist "%%d\node.exe" set "NE=%%d\node.exe"
)
if defined NE goto :node_ready

goto :no_node

:node_ready
rem --- verify it actually runs ---
"%NE%" -e "process.exit(0)" >nul 2>nul
if not errorlevel 1 goto :node_ok
set "NE="
goto :no_node

:node_ok

:run
rem --- port from config.json ---
rem NOTE: do NOT use for /f here. A quoted exe plus a JS -e string gets shredded by cmd
rem parsing (reproduced 2026-10-26: 'exe" -e "const' is not recognized). Redirect + set /p works.
set "PORT=18080"
"%NE%" -e "const fs=require('fs');try{const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(c.port||18080)}catch(e){console.log(18080)}" "%~dp0config.json" > "%~dp0_port.tmp" 2>nul
if exist "%~dp0_port.tmp" set /p PORT=<"%~dp0_port.tmp"
del "%~dp0_port.tmp" >nul 2>nul

echo [node] %NE%
echo [port] %PORT%
echo.
type "%~dp0msg\starting.txt"
echo.

rem --- open the config page once the signer had time to listen ---
start "" cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:%PORT%/"

"%NE%" "%~dp0signer.js" %*
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

:no_node
type "%~dp0msg\no_node.txt"
echo.
pause
exit /b 1
