@echo off
chcp 65001 >nul
rem 只是转发到课堂转写.bat，保持单一入口
call "%~dp0课堂转写.bat" %*
