@echo off
title Cluely Copilot Launcher
echo ============================================================
echo   Launching Cluely Copilot
echo ============================================================
set "APP_DIR=%~dp0app"
cd /d "%APP_DIR%"
set "ELECTRON_RUN_AS_NODE="

taskkill /F /IM electron.exe >nul 2>&1

echo Starting Cluely Copilot...
start "" "%APP_DIR%\node_modules\electron\dist\electron.exe" "%APP_DIR%"
echo Cluely Copilot started!
