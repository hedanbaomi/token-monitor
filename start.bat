@echo off
cd /d "%~dp0"
echo Starting Token Monitor...
npm start
if errorlevel 1 pause
