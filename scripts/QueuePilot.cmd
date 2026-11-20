@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ============================================================================
rem  QueuePilot - the family launcher (zero prerequisites).
rem
rem  Double-click to run. Needs NO admin rights and NO installed Node:
rem    1. node on PATH? use it.
rem    2. portable runtime already fetched into .runtime\node? use it.
rem    3. otherwise download the official Node zip once (~28 MB) into
rem       .runtime\node and use that - nothing is installed system-wide.
rem
rem  Then: API already healthy -> open dashboard; else boot it minimized,
rem  wait for /health, open the dashboard. Log: .runtime\launcher.log and
rem  %USERPROFILE%\.queuepilot\api.log
rem ============================================================================

set "APP=%~dp0"
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"
set "PORT=50325"
set "API_URL=http://127.0.0.1:%PORT%"
set "QDATA=%USERPROFILE%\.queuepilot"
set "LOG=%QDATA%\api.log"
set "RUNTIME=%APP%\.runtime\node"
set "NODEEXE=%RUNTIME%\node.exe"
set "NODEVER=v22.12.0"

if not exist "%QDATA%" mkdir "%QDATA%"

rem --- 1/2: find a node --------------------------------------------------------
set "NODECMD=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%NODEEXE%" (
    set "NODECMD=%NODEEXE%"
  ) else (
    echo [QueuePilot] Node not found - fetching portable Node %NODEVER% once (~28 MB)...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $u='https://nodejs.org/dist/%NODEVER%/node-%NODEVER%-win-x64.zip'; $z=Join-Path $env:TEMP 'qp-node.zip'; Invoke-WebRequest -UseBasicParsing $u -OutFile $z; $d='%RUNTIME%_tmp'; if (Test-Path $d) { Remove-Item -Recurse -Force $d }; Expand-Archive $z $d; Move-Item (Join-Path $d 'node-%NODEVER%-win-x64') '%RUNTIME%'; Remove-Item -Recurse -Force $d; Remove-Item $z" >> "%APP%\.runtime-fetch.log" 2>&1
    if not exist "%NODEEXE%" (
      echo [QueuePilot] Could not fetch Node. Install Node.js 22+ from https://nodejs.org and re-run.
      notepad "%APP%\.runtime-fetch.log" 2>nul
      pause
      exit /b 1
    )
    set "NODECMD=%NODEEXE%"
  )
)

rem --- API already up? just open the dashboard ---------------------------------
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing '%API_URL%/health' -TimeoutSec 2) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo [QueuePilot] API is already running - opening dashboard.
  start "" "%API_URL%/"
  exit /b 0
)

echo [QueuePilot] Starting API... (log: %LOG%)
powershell -NoProfile -Command "Start-Process -FilePath '%NODECMD%' -ArgumentList '\"%~dp0server\queuepilot.mjs\"' -WorkingDirectory '%APP%' -RedirectStandardOutput '%LOG%' -RedirectStandardError '%LOG%.err' -WindowStyle Minimized"

rem --- wait for /health (up to 60 s) -------------------------------------------
set /a tries=0
:wait
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing '%API_URL%/health' -TimeoutSec 2) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% GEQ 30 (
  echo [QueuePilot] API did not answer within 60 s. Log tail:
  powershell -NoProfile -Command "Get-Content '%LOG%' -Tail 15 -ErrorAction SilentlyContinue"
  echo.
  echo [QueuePilot] Re-run this file to retry.
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
