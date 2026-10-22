@echo off
rem Starts Airwave Pilot and opens its window in your browser.
cd /d "%~dp0"
if not exist node_modules (echo Installing, one moment... & call npm install)
start "" http://localhost:8090
node pilot-client\pilot.js
pause
