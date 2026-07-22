@echo off
cd /d "%~dp0"
start "" http://127.0.0.1:4173
npm run serve
