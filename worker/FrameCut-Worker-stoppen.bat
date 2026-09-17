@echo off
cd /d "%~dp0"
if not exist "%~dp0data" mkdir "%~dp0data"
type nul > "%~dp0data\worker.stop"
echo FrameCut Worker erhaelt das Stoppsignal und beendet den aktuellen Schritt sauber.
timeout /t 3 /nobreak > nul
