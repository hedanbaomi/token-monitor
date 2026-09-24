@echo off
setlocal
chcp 65001 >nul
REM ===========================================================================
REM install-autostart.bat
REM Installs a "Token Monitor" shortcut into the Windows Startup folder so the
REM app launches silently in the background every time you log in. No console
REM window is shown at launch (the shortcut points at the .vbs launcher).
REM
REM Run this ONCE (double-click). To undo later: delete the shortcut from
REM   Win+R  ->  shell:startup   (or run uninstall-autostart.bat)
REM ===========================================================================

title Token Monitor - 安装开机自启

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "VBS=%SCRIPT_DIR%\launch-background.vbs"

if not exist "%VBS%" (
  echo [x] 找不到 launch-background.vbs
  echo     预期路径: %VBS%
  pause
  exit /b 1
)

REM Resolve the per-user Startup folder via the shell (works on every locale).
set "STARTUP_DIR="
for /f "delims=" %%I in ('powershell -NoProfile -Command "[Environment]::GetFolderPath('Startup')"') do set "STARTUP_DIR=%%I"

if "%STARTUP_DIR%"=="" (
  echo [x] 无法定位启动文件夹。
  pause
  exit /b 1
)

set "SHORTCUT=%STARTUP_DIR%\Token Monitor.lnk"

REM Build the shortcut with PowerShell (always available on Win10/11).
powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$sc = $ws.CreateShortcut('%SHORTCUT%');" ^
  "$sc.TargetPath = '%SystemRoot%\System32\wscript.exe';" ^
  "$sc.Arguments = '\"%VBS%\"';" ^
  "$sc.WorkingDirectory = '%SCRIPT_DIR%';" ^
  "$sc.WindowStyle = 7;" ^
  "$sc.Description = 'Token Monitor (background launcher)';" ^
  "$sc.Save();" >nul 2>&1

if exist "%SHORTCUT%" (
  echo [v] 已安装开机自启:
  echo     %SHORTCUT%
  echo.
  echo 每次登录 Windows 后，Token Monitor 会自动在后台静默启动
  echo （驻留于系统托盘，无命令行窗口）。
) else (
  echo [x] 创建快捷方式失败。
  pause
  exit /b 1
)

echo.
echo 是否立即启动 Token Monitor？ (Y/N)
set /p ans=
if /i "%ans%"=="Y" (
  start "" wscript.exe "%VBS%"
  echo 已启动。
)
timeout /t 3 >nul
endlocal
