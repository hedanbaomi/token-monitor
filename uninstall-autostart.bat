@echo off
setlocal
chcp 65001 >nul
REM ===========================================================================
REM uninstall-autostart.bat
REM Removes the "Token Monitor" shortcut from the Windows Startup folder.
REM (Does not close a currently-running instance — quit it from its tray icon.)
REM ===========================================================================

title Token Monitor - 取消开机自启

set "STARTUP_DIR="
for /f "delims=" %%I in ('powershell -NoProfile -Command "[Environment]::GetFolderPath('Startup')"') do set "STARTUP_DIR=%%I"

set "SHORTCUT=%STARTUP_DIR%\Token Monitor.lnk"

if exist "%SHORTCUT%" (
  del "%SHORTCUT%"
  echo [v] 已移除开机自启:
  echo     %SHORTCUT%
) else (
  echo [i] 没有找到自启快捷方式（本就未安装）。
)

timeout /t 3 >nul
endlocal
