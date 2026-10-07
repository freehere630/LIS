@echo off
title Maglumi X3 - LIS Interface Engine
mode con: cols=86 lines=30
color 0D

cd /d "C:\apex-lis-bridge"
node bridge-maglumi.js
pause