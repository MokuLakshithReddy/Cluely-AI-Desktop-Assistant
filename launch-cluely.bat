@echo off
title Cluely Copilot Launcher
echo ============================================================
echo   Launching Cluely Copilot (Unpacked Physical Hardware Mode)
echo ============================================================
cd /d "%~dp0app"
set ELECTRON_RUN_AS_NODE=
start "" "node_modules\electron\dist\electron.exe" .
echo Cluely Copilot process started.
