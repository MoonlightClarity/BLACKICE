@echo off
if exist "%~dp0..\Relay-Desktop-Windows\Relay.exe" (
  start "" "%~dp0..\Relay-Desktop-Windows\Relay.exe"
) else (
  cd /d "%~dp0"
  call npm run desktop
)
