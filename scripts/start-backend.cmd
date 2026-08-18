@echo off
rem PanelFlow's local API, started at logon by the scheduled task
rem "PanelFlow backend" (schtasks /query /tn "PanelFlow backend"). Run it by
rem hand the same way if you want to: it is `npm start` with a guard, a log,
rem and no console window to keep open.
rem
rem Deliberately no --env-file. backend\.env is a `vercel env pull` dump and
rem holds the production Turso credentials, so loading it here would point a
rem development server at the real accounts and the real reading progress.
rem With no TURSO_DATABASE_URL set, the backend opens its local database file
rem instead, which is what a server running on this machine should be reading.

cd /d "%~dp0.."

rem Already listening — started by hand, or this ran twice. Starting a second
rem one would only produce EADDRINUSE and a log that says nothing else.
netstat -an | findstr /c:":8787" | findstr /c:"LISTENING" >nul && exit /b 0

rem PATH is normally complete by logon; the fallback is for when it is not.
set "NODE=node.exe"
where /q node.exe || set "NODE=%ProgramFiles%\nodejs\node.exe"

rem Overwritten each start rather than appended: what is worth reading here is
rem why the last one failed, not every line since the machine was new.
set "LOG=%LOCALAPPDATA%\panelflow-backend.log"
echo [%date% %time%] starting %NODE% backend\src\index.js> "%LOG%"
"%NODE%" backend\src\index.js >> "%LOG%" 2>&1
echo [%date% %time%] exited with %ERRORLEVEL%>> "%LOG%"
