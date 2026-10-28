@echo off
chcp 65001 >nul
title 课堂转写 调试模式 v1.23.2
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo 没找到 Python，请先安装 3.10 以上版本并勾选 Add to PATH
  pause
  exit /b 1
)

echo 调试模式：黑窗口里会打印所有日志和报错
echo 浏览器访问 http://127.0.0.1:8787
echo.
start "" "http://127.0.0.1:8787"
python server.py --port 8787
echo.
echo 服务已退出，按任意键关闭
pause
