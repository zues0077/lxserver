@echo off
setlocal
cd /d "%~dp0"
title Soda Signer

set "NODE_EXE="
if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"
if not defined NODE_EXE (
  where node >nul 2>nul && set "NODE_EXE=node"
)
if not defined NODE_EXE (
  echo [ERROR] Node.js not found on this computer.
  echo.
  echo   Option A: install Node.js LTS from https://nodejs.org  ^(then double-click again^)
  echo   Option B: put node.exe in the same folder as this file
  echo.
  pause
  exit /b 1
)

echo Starting signer. Keep this window open while playing music.
echo.
"%NODE_EXE%" "%~dp0signer.js" %*
echo.
echo Signer stopped.
pause
