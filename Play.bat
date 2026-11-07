@echo off
rem Double-click to play: builds the game if needed and opens it in your browser.
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist dist\index.html call npm run build
node tools\serve.mjs --open
pause
