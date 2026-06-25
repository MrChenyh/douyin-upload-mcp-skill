@echo off
setlocal
cd /d "%~dp0\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-console.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] Startup failed. Please send the messages above to the engineer.
  pause
)
