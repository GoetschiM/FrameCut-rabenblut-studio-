@echo off
powershell.exe -NoProfile -NonInteractive -Command "[Console]::Out.Write($env:FRAMECUT_SSH_PASSWORD)"
