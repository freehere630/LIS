@echo off
title Maglumi X3 - LIS Interface Engine
mode con: cols=96 lines=36

:: Enable Windows Virtual Terminal true-color rendering (removes color glitching)
reg add "HKCU\Console" /v VirtualTerminalLevel /t REG_DWORD /d 1 /f >nul 2>&1

:: Run from the script's exact directory
cd /d "%~dp0"

node bridge-maglumi.js
pause