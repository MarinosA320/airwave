@echo off
rem Starts an Airwave server with simulated traffic and opens the ATC scope.
cd /d "%~dp0"
if not exist node_modules (echo Installing, one moment... & call npm install)
start "" http://localhost:8080
node server\server.js
pause
