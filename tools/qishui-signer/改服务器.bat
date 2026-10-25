@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Soda Signer - change LX server
call "%~dp0start-signer.bat" --setup
