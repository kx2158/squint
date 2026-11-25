@echo off
cd /d "%~dp0"
if not exist "lists\fork.synced" (
  node scripts\fetch-lists.js
  echo ok> "lists\fork.synced"
)
if not exist "lists\resources.dat" node scripts\fetch-lists.js --resources-only
if not exist "lists\adult.dat" node scripts\fetch-lists.js --adult-only
start "" "node_modules\electron\dist\electron.exe" .
