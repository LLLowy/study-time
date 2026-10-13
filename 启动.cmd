@echo off
rem ============================================================
rem  Study Workstation launcher.
rem  Keep this file ASCII-only: cmd.exe parses .cmd files with the
rem  system OEM code page (936/GBK here), so non-ASCII text inside
rem  would be garbled and can even break command parsing.
rem  All Chinese messages are printed by server.js instead.
rem ============================================================

chcp 65001 >nul
title Study Workstation
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo.
echo   Starting study workstation, your browser will open shortly...
echo   Close this window to stop the program (data is saved in .\data).
echo.

node "%~dp0server.js"
if errorlevel 1 goto crashed
exit /b 0

:nonode
echo.
echo   [ERROR] Node.js was not found on this computer.
echo.
echo   Please download and install the LTS version from:
echo       https://nodejs.org/
echo.
echo   Then double-click this file again.
echo.
pause
exit /b 1

:crashed
echo.
echo   The program exited with an error. Please screenshot the messages above.
echo.
pause
exit /b 1
