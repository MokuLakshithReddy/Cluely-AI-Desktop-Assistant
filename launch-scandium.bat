@echo off
title Scandium Launcher
echo ============================================================
echo   Launching Scandium
echo ============================================================
set "APP_DIR=%~dp0app"
cd /d "%APP_DIR%"
set "ELECTRON_RUN_AS_NODE="

taskkill /F /IM electron.exe >nul 2>&1

echo Starting Scandium...
start "" "%APP_DIR%\node_modules\electron\dist\electron.exe" "%APP_DIR%"
echo Scandium started!
