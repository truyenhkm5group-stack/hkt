@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Pancake AI Sales Manager

rem Tim Python: uu tien "py" (Python Launcher), sau do "python"
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY (
  echo [LOI] Khong tim thay Python. Cai Python 3.10+ tu https://www.python.org/downloads/ va tich "Add python.exe to PATH".
  pause & exit /b 1
)
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" || (
  echo [LOI] Can Python 3.10 tro len. Ban dang co:
  %PY% --version
  pause & exit /b 1
)

if not exist .venv\Scripts\python.exe (
  echo Dang tao moi truong Python lan dau...
  %PY% -m venv .venv || (echo [LOI] Khong tao duoc .venv & pause & exit /b 1)
)
echo Dang kiem tra thu vien...
.venv\Scripts\python.exe -m pip install -q --disable-pip-version-check -r requirements.txt || (echo [LOI] Cai thu vien that bai - kiem tra mang Internet & pause & exit /b 1)
if not exist .env copy .env.example .env >nul

echo.
echo  Bot dang chay tai http://127.0.0.1:8800  (giu cua so nay mo; dong cua so = tat bot)
echo.
start "" http://127.0.0.1:8800
.venv\Scripts\python.exe server.py
echo.
echo Bot da dung. Neu co loi o tren, chup man hinh gui lai.
pause
