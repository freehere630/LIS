@echo off
title Arrows KT-44 - Virtual Machine Simulator
mode con: cols=90 lines=32
cd /d "%~dp0"
node simulate-arrows.js
pause