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
)

rem Retry dependency installation after a failed first run, and apply requirement updates.
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
if errorlevel 1 (
  echo Nao foi possivel instalar as dependencias. Verifique a rede e tente novamente.
  exit /b 1
)

set PORT=4747
if not "%CEU_PORT%"=="" set PORT=%CEU_PORT%

rem Reuse an existing CEU; never run recovery against its active database.
powershell -NoProfile -Command "try{$r=Invoke-RestMethod http://127.0.0.1:%PORT%/api/health -TimeoutSec 2; if($r.app -eq 'CEU'){Start-Process 'http://127.0.0.1:%PORT%'; exit 0}}catch{}; exit 1"
if not errorlevel 1 exit /b 0

rem Open only after CEU identifies itself as ready.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command ^
  "for($i=0;$i -lt 120;$i++){try{$r=Invoke-RestMethod http://127.0.0.1:%PORT%/api/health -TimeoutSec 1; if($r.app -eq 'CEU'){break}}catch{}; Start-Sleep -Milliseconds 250}; if($r.app -ne 'CEU'){exit 1};" ^
  "try{Start-Process msedge '--app=http://127.0.0.1:%PORT%'}catch{Start-Process 'http://127.0.0.1:%PORT%'}"

".venv\Scripts\python.exe" -m server.main --port %PORT%
