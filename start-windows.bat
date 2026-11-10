@echo off
cd /d "%~dp0"
title Running Timer Server
set "PY="
py -3 --version >nul 2>nul && set "PY=py -3"
if not defined PY python --version >nul 2>nul && set "PY=python"
if not defined PY (
  echo.
  echo  Python is not installed.
  echo  Install it from https://www.python.org/downloads/  ^(check "Add python.exe to PATH"^), then run this file again.
  start "" https://www.python.org/downloads/
  pause
  exit /b 1
)
%PY% -c "import openpyxl" >nul 2>nul || %PY% -m pip install --user openpyxl
%PY% server\running_server.py %*
pause
