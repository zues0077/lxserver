@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Soda Signer - open config page

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

:open
rem --- port from config.json ---
rem NOTE: do NOT use for /f here. A quoted exe plus a JS -e string gets shredded by cmd
rem parsing (reproduced 2026-10-26: 'exe" -e "const' is not recognized). Redirect + set /p works.
set "PORT=18080"
"%NE%" -e "const fs=require('fs');try{const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(c.port||18080)}catch(e){console.log(18080)}" "%~dp0config.json" > "%~dp0_port.tmp" 2>nul
if exist "%~dp0_port.tmp" set /p PORT=<"%~dp0_port.tmp"
del "%~dp0_port.tmp" >nul 2>nul

type "%~dp0msg\open_config.txt"
echo.
echo   http://localhost:%PORT%/
echo.
start "" "http://localhost:%PORT%/"
exit /b 0

:no_node
type "%~dp0msg\no_node.txt"
echo.
echo   default port: 18080
echo.
exit /b 0
