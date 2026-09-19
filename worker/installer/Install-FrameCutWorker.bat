@echo off
setlocal
PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-worker.ps1" %*
exit /b %ERRORLEVEL%
