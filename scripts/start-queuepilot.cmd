@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ============================================================================
rem  QueuePilot - one-double-click start for family machines.
rem
rem  Boots the API (port 50325, fury engine runtime), waits until it answers
rem  /health, then opens the dashboard. Dependency-free: needs only Node.js.
rem
rem  If the API is already running, this just opens the dashboard.
rem  Log: %USERPROFILE%\.queuepilot\api.log
rem ============================================================================

rem Script lives in scripts\ - the repo root is one level up.
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "PORT=50325"
set "API_URL=http://127.0.0.1:%PORT%"
set "LOG_DIR=%USERPROFILE%\.queuepilot"
set "LOG=%LOG_DIR%\api.log"

where node >nul 2>nul
if errorlevel 1 (
  echo [QueuePilot] Node.js is not installed or not on PATH.
  echo [QueuePilot] Install Node.js 22+ from https://nodejs.org then re-run this file.
  pause
  exit /b 1
)

rem --- already healthy? just open the dashboard --------------------------------
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing '%API_URL%/health' -TimeoutSec 2) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo [QueuePilot] API is already running at %API_URL% - opening dashboard.
  start "" "%API_URL%/"
  exit /b 0
)

echo [QueuePilot] Starting API... (log: %LOG%)
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npx tsx src/main.ts' -WorkingDirectory '%ROOT%\apps\api' -RedirectStandardOutput '%LOG%' -RedirectStandardError '%LOG%.err' -WindowStyle Minimized"

rem --- wait for /health (up to 60 s) -------------------------------------------
set /a tries=0
:wait
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing '%API_URL%/health' -TimeoutSec 2) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% GEQ 30 (
  echo [QueuePilot] API did not answer within 60 s.
  echo [QueuePilot] Last log lines:
  powershell -NoProfile -Command "Get-Content '%LOG%' -Tail 15 -ErrorAction SilentlyContinue"
  echo.
  echo [QueuePilot] Re-run this file to retry. If it keeps failing, save the log above.
  pause
  exit /b 1
)
powershell -NoProfile -Command "Start-Sleep -Milliseconds 2000" >nul
goto wait

:ready
echo [QueuePilot] API is up - opening dashboard at %API_URL%/
start "" "%API_URL%/"
endlocal
exit /b 0
