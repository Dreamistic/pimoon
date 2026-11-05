@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0scripts\launch-desktop.mjs"
if not errorlevel 1 exit /b 0
echo.
echo Startup failed. See the error above.
pause
exit /b 1
