@echo off
chcp 65001 >nul
cd /d %~dp0
if not exist .venv (
  echo Dang tao moi truong Python...
  python -m venv .venv || (echo Can cai Python 3.10+ tu https://www.python.org/downloads/ ^(tich "Add to PATH"^) & pause & exit /b 1)
)
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt
if not exist .env copy .env.example .env >nul
start "" http://127.0.0.1:8800
python server.py
pause
