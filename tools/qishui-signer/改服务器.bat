@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Soda Signer - open config page
set "PORT=18080"
set "NE="
if exist "%~dp0node.exe" set "NE=%~dp0node.exe"
if not defined NE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NE set "NE=%%i"
if defined NE (
  for /f "delims=" %%p in ('"%NE%" -e "const fs=require('fs');try{const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(c.port||18080)}catch(e){console.log(18080)}" "%~dp0config.json" 2^>nul') do set "PORT=%%p"
)
echo 正在打开签名器配置页（请先确保 start-signer.bat 已在运行）…
start "" "http://localhost:%PORT%/"
exit /b 0
