@echo off
chcp 65001 >nul
title Separador do Musicalizando
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo O separador ainda nao foi instalado. Rode primeiro o instalar-separador.bat
  pause
  exit /b 1
)
".venv\Scripts\python.exe" separador.py
if errorlevel 1 (
  echo.
  echo O separador parou com erro. Confira a mensagem acima.
  pause
  exit /b 1
)
echo.
echo O separador foi fechado.
pause
