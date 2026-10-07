@echo off
title Arrows KT-44 - Hematology LIS Interface Engine
mode con: cols=86 lines=30
color 0B

cd /d "C:\apex-lis-bridge"
node bridge-arrows.js
pause