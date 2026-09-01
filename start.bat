@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [Token Monitor] 正在启动...
npm start
if errorlevel 1 (
  echo [!] 启动异常退出，按任意键关闭...
  pause >nul
)
