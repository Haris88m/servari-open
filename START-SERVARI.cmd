@echo off
REM ============================================================
REM  SERVARI - launch the desktop shell (Electron window over
REM  the local SERVARI server).
REM
REM  Run from the repo root. The server (server/servari_server.py)
REM  is launched automatically by the Electron entry; it needs
REM  Python on PATH (or set SERVARI_PYTHON to a specific exe).
REM ============================================================
title SERVARI
cd /d "%~dp0"

echo.
echo   === SERVARI ===
echo   Starting the desktop shell. Close the window to exit.
echo.

call node_modules\.bin\electron.cmd .
