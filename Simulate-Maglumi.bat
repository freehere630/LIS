@echo off
title Maglumi X3 - Virtual Machine Simulator
mode con: cols=85 lines=30
cd /d "%~dp0"
node simulate-maglumi.js
pause