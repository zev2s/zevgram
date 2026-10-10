@echo off
cd /d "%~dp0"
node "%~dp0zevgram-server.js"
echo.
echo Zevgram has stopped. Press any key to close this window.
pause >nul

