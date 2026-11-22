@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found. Install it from https://nodejs.org then run this again.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo [*] Modules missing. Running npm install...
  call npm install
  if errorlevel 1 (
    echo [X] npm install failed.
    pause
    exit /b 1
  )
)

echo [*] Starting Invisible...
call npm start
if errorlevel 1 (
  echo [X] App exited with an error.
  pause
)
endlocal

