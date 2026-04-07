@echo off
setlocal
cd /d "%~dp0"
python web_main.py %*
endlocal
