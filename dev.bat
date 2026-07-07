@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1"
exit /b %ERRORLEVEL%
