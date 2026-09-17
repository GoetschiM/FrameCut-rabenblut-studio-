@echo off
cd /d "%~dp0"
title FrameCut Worker
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0FrameCut-Worker.ps1"
pause
