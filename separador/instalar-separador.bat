@echo off
chcp 65001 >nul
title Instalar separador do Musicalizando
cd /d "%~dp0"

rem Python 3.12 (o PyTorch para CPU ainda nao funciona bem em versoes mais novas)
set "PY="
py -3.12 --version >nul 2>nul && set "PY=py -3.12"
if not defined PY python --version >nul 2>nul && set "PY=python"
if not defined PY (
  echo.
  echo Python nao encontrado. Instale o Python 3.12:
  echo   winget install -e --id Python.Python.3.12
  echo ou baixe em https://www.python.org/downloads/release/python-3129/ marcando "Add python.exe to PATH".
  echo Depois rode este arquivo de novo.
  pause
  exit /b 1
)
%PY% --version

if not exist ".venv\Scripts\python.exe" (
  echo Criando o ambiente .venv ...
  %PY% -m venv .venv || (echo Falhou ao criar o .venv & pause & exit /b 1)
)
set "VPY=.venv\Scripts\python.exe"
"%VPY%" -m pip install --upgrade pip
echo.
echo Instalando PyTorch (CPU, ~200 MB)...
"%VPY%" -m pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu || (echo Falhou ao instalar o PyTorch & pause & exit /b 1)
echo.
echo Instalando Demucs e o resto...
"%VPY%" -m pip install -r requirements.txt || (echo Falhou ao instalar as dependencias & pause & exit /b 1)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo Criei o separador\.env: abra e cole a SUPABASE_SERVICE_ROLE_KEY.
)
echo.
echo Pronto! Agora de dois cliques em iniciar-separador.bat
pause
