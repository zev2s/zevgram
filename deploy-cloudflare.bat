@echo off
title Publish Zevgram for free
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-cloudflare.ps1"
if errorlevel 1 (
  echo.
  echo Publication stopped. Read the message above and try again.
)
echo.
pause

