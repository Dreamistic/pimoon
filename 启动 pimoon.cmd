@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "PIMOON_HEADLESS="
if not exist "%~dp0dist\pimoon\pimoon.exe" (
  echo 尚未找到 pimoon 成品，请先按 README 构建。
  pause
  exit /b 1
)
where python >nul 2>nul
if errorlevel 1 (
  echo 需要本机 Python 3.12 或更新版本，并将它加入 PATH。
  pause
  exit /b 1
)
start "" "%~dp0dist\pimoon\pimoon.exe"
