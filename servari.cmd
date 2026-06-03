@echo off
REM ============================================================
REM  SERVARI - the launcher. Two ways to run SERVARI:
REM
REM    servari.cmd app                  open the desktop / web app
REM    servari.cmd cli                  start a FULL INTERACTIVE SERVARI session
REM                                     in your terminal (auto-detect backend)
REM    servari.cmd cli --backend claude interactive Claude Code CLI session as SERVARI
REM    servari.cmd cli --backend codex  interactive OpenAI Codex CLI session as SERVARI
REM    servari.cmd cli --backend api    interactive BYOM chat as SERVARI (config.json)
REM    servari.cmd cli -p "your prompt" one-shot via the API backend (no session)
REM    servari.cmd cli --print-cmd      show the session launch command (no launch)
REM    servari.cmd cli --detect         print backend availability
REM
REM  `servari.cmd cli` (no further args) starts the interactive SERVARI session:
REM  it hands control to your harness (Claude / Codex), booted as SERVARI from
REM  SERVARI.md - the way a power user runs an agent OS. Bare `servari.cmd` does
REM  the same. Set SERVARI_PYTHON to choose a specific python.exe.
REM ============================================================
setlocal
cd /d "%~dp0"

REM Pick the python interpreter (SERVARI_PYTHON override, else `python`).
set "_PY=%SERVARI_PYTHON%"
if "%_PY%"=="" set "_PY=python"

REM First token selects the front door: app | cli (default cli).
if /I "%~1"=="app" goto :mode_app
if /I "%~1"=="cli" goto :mode_cli

REM No recognised mode token -> treat all args as CLI args (bare `servari`).
"%_PY%" "%~dp0server\servari_cli.py" %*
goto :eof

:mode_app
REM Hand off to the existing desktop launcher.
call "%~dp0START-SERVARI.cmd"
goto :eof

:mode_cli
REM Drop the leading "cli" token; pass everything after it through, quotes intact.
shift
set "_ARGS="
:cli_collect
if "%~1"=="" goto :cli_run
set "_ARGS=%_ARGS% %1"
shift
goto :cli_collect
:cli_run
"%_PY%" "%~dp0server\servari_cli.py"%_ARGS%
goto :eof
