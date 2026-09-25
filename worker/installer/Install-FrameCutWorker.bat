@echo off
setlocal
title FrameCut Worker Installer

PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-worker.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if %EXIT_CODE% neq 0 (
    echo.
    echo ======================================================================
    echo Installation abgebrochen mit Fehlercode %EXIT_CODE%.
    echo ======================================================================
    echo.
    pause
    exit /b %EXIT_CODE%
)

echo.
echo ======================================================================
echo Setup erfolgreich beendet.
echo ======================================================================
echo.
pause
exit /b 0
