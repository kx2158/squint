@echo off
cd /d "%~dp0"
echo Starting Squint with logging. Leave this window open and read any error below.
echo.
"node_modules\electron\dist\electron.exe" . --enable-logging
echo.
echo Squint exited. Errors, if any, are above and in error.log.
pause
