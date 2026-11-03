@echo off
cd /d "%~dp0"
bun run start
if errorlevel 1 pause
