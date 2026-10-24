@echo off
rem Inicia o painel Fato ou Fake e abre o navegador em http://localhost:8765/
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" %*
pause
