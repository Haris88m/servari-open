@echo off
REM ============================================================
REM  SERVARI - portable Windows .exe builder
REM  Produces: dist-exe\SERVARI-x64.exe
REM
REM  NOTE: the .exe is the Electron shell ONLY. The SERVARI server
REM  (server/servari_server.py) is spawned from the repo at runtime
REM  and is NOT bundled. The .exe still needs Python at runtime
REM  ("python" on PATH, or set SERVARI_PYTHON to a specific exe).
REM ============================================================
setlocal
cd /d "%~dp0"

echo [servari] Installing dependencies (electron + electron-builder)...
call npm install
if errorlevel 1 (
  echo [servari] npm install FAILED. See output above.
  exit /b 1
)

echo [servari] Building portable .exe...
call npm run build:exe
if errorlevel 1 (
  echo [servari] build FAILED. See output above.
  exit /b 1
)

echo.
echo [servari] DONE. Output:
echo        %~dp0dist-exe\SERVARI-x64.exe
endlocal
