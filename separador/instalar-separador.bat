@echo off
chcp 65001 >nul
title Instalar separador do Musicalizando
cd /d "%~dp0"

rem Python: o mais novo instalado (py -3); senao o "python" do PATH
set "PY="
py -3 --version >nul 2>nul && set "PY=py -3"
if not defined PY python --version >nul 2>nul && set "PY=python"
if not defined PY (
  echo.
  echo Python nao encontrado. Instale com:
  echo   winget install -e --id Python.Python.3.12
  echo ou baixe em https://www.python.org/downloads/ marcando "Add python.exe to PATH".
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
echo Instalando PyTorch (no Windows o pacote do PyPI ja e a versao para CPU, ~200 MB)...
"%VPY%" -m pip install torch || (echo Falhou ao instalar o PyTorch & pause & exit /b 1)
echo.
echo Instalando Demucs e o resto...
rem pyyaml sem a extensao em C (dispensa o compilador do Visual Studio)
set "PYYAML_FORCE_LIBYAML=0"
"%VPY%" -m pip install -r requirements.txt || (echo Falhou ao instalar as dependencias & pause & exit /b 1)
"%VPY%" -m pip install --no-deps "demucs>=4.0.1" || (echo Falhou ao instalar o Demucs & pause & exit /b 1)
"%VPY%" -c "from demucs.pretrained import get_model; from demucs.apply import apply_model; import soundfile, lameenc, truststore" || (echo As bibliotecas nao carregaram & pause & exit /b 1)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo Criei o separador\.env: abra e cole a SUPABASE_SERVICE_ROLE_KEY.
)
echo.
echo Pronto! Agora de dois cliques em iniciar-separador.bat
pause
