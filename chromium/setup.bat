@echo off
setlocal
cd /d "%~dp0"
title Squint setup
echo.
echo   Squint setup
echo   -----------
echo   Folder: %cd%
echo.

if not exist "package.json" (
  echo This window is not inside the extracted Squint folder.
  echo Right-click plain.zip, choose "Extract All", open the extracted folder, then run setup.bat there.
  echo Running it from inside the zip does not work.
  pause
  exit /b 1
)

rem --- 1. Node.js -------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [1/5] Installing Node.js LTS ^(one-time^)...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  if errorlevel 1 goto nonode
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
) else (
  echo [1/5] Node.js found.
)
where npm >nul 2>nul
if errorlevel 1 goto nonode

rem --- 2. Dependencies + uBlock Origin / EasyList filter lists ----------------
echo.
echo [2/5] Installing the browser engine and filter lists...
call npm install
if errorlevel 1 goto fail
if not exist "node_modules\electron\dist\electron.exe" (
  echo Fetching the Chromium engine ^(newer npm skips install scripts, so this is done directly^)...
  node "node_modules\electron\install.js"
)
if not exist "node_modules\electron\dist\electron.exe" goto fail

rem --- 3. Tor (optional) ------------------------------------------------------
echo.
set "TOR=n"
set /p "TOR=[3/5] Download the Tor Expert Bundle so the Tor route works? (y/N): "
if /i "%TOR%"=="y" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\get-tor.ps1"
  if errorlevel 1 echo Tor download failed. The browser still works; you can retry by running setup.bat again.
) else (
  echo Skipped Tor.
)

rem --- 4. Desktop shortcut ----------------------------------------------------
echo.
echo [4/5] Creating a desktop shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\shortcut.ps1"

rem --- 5. Launch --------------------------------------------------------------
echo.
echo [5/5] Starting Squint...
start "" "node_modules\electron\dist\electron.exe" .
echo.
echo Done. This folder is where Squint lives:
echo   %cd%
echo From now on use the "Squint" shortcut on your desktop, or run.bat in that folder.
echo If no window opened, run debug.bat in that folder and read the error it shows.
echo In Squint: menu ^> Import from Brave ^(close Brave first^).
pause
exit /b 0

:nonode
echo.
echo Could not set up Node.js automatically.
echo Install it from https://nodejs.org ^(LTS^), then run this file again.
pause
exit /b 1

:fail
echo.
echo Setup failed: the Chromium engine (electron) did not download. Check your internet connection, then run this file again.
echo If it keeps failing, send me the text above.
pause
exit /b 1
