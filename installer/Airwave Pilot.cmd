@echo off
rem Starts Airwave Pilot with the Node.js that ships with it and opens its window in your browser.
rem Settings are kept in %APPDATA%\Airwave so updates never overwrite them.
title Airwave Pilot
set AIRWAVE_PILOT_OPEN=1
if not exist "%APPDATA%\Airwave" mkdir "%APPDATA%\Airwave"
set "AIRWAVE_PILOT_CONFIG=%APPDATA%\Airwave\pilot-config.json"
"%~dp0node\node.exe" "%~dp0app\pilot-client\pilot.js"
if errorlevel 1 pause
