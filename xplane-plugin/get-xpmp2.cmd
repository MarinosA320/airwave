@echo off
rem Downloads the XPMP2 library (MIT licence, by TwinFan) that the plugin is built on.
cd /d "%~dp0"
if not exist lib\XPMP2 git clone --depth 1 --branch v3.7.0 https://github.com/TwinFan/XPMP2 lib\XPMP2
