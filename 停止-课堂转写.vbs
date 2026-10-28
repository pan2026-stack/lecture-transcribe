Option Explicit
' 课堂转写 —— 停止后台服务
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "cmd /c for /f ""tokens=5"" %p in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do taskkill /PID %p /F", 0, True
MsgBox "课堂转写的后台服务已停止。", 64, "课堂转写"
