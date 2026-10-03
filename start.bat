@echo off
rem CEU — starts the local server and opens the app in its own window.
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Preparando o ambiente Python pela primeira vez...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if errorlevel 1 (
    echo Python 3.10+ nao encontrado. Instale em https://www.python.org/downloads/
    pause
    exit /b 1
  )
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
)

set PORT=4747
if not "%CEU_PORT%"=="" set PORT=%CEU_PORT%

rem Open as a standalone app window (Edge/Chrome app mode) once the server is up.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command ^
  "for($i=0;$i -lt 40;$i++){try{Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/api/state -TimeoutSec 1 | Out-Null; break}catch{Start-Sleep -Milliseconds 250}};" ^
  "try{Start-Process msedge '--app=http://127.0.0.1:%PORT%'}catch{Start-Process 'http://127.0.0.1:%PORT%'}"

".venv\Scripts\python.exe" -m server.main --port %PORT%
