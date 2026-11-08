@echo off
rem Double-click to play: builds the game if needed and opens it in your browser.
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run build
if errorlevel 1 (
  echo Build failed. See the error above.
  pause
  exit /b 1
)
node tools\serve.mjs --open
pause
