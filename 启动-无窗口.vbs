Option Explicit
' 课堂转写 —— 守护启动
' 作用：后台跑 pythonw，进程退出（崩溃 / 看门狗主动退出）后自动拉起
' 首次启动时等它就绪，然后打开浏览器

Const PORT = 8787
Const URL = "http://127.0.0.1:8787/"

Dim shell, fso, base, pyw, pythonExe, i, ok, opened, restarts

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)

If Not fso.FileExists(base & "\server.py") Then
  MsgBox "找不到 server.py，请把本文件放回程序文件夹。", 16, "课堂转写"
  WScript.Quit 1
End If

' 优先用内置运行时（分享包里带），其次找系统 python
pyw = base & "\python\pythonw.exe"
If Not fso.FileExists(pyw) Then
  pyw = FindPythonW()
End If
If pyw = "" Then
  MsgBox "找不到 pythonw.exe。请确认包内有 python 文件夹，或已安装 Python。", 16, "课堂转写"
  WScript.Quit 1
End If

shell.CurrentDirectory = base

' 已经在跑就直接开浏览器
If Health(URL) Then
  shell.Run URL, 1, False
  WScript.Quit 0
End If

' 清掉占用端口的僵尸进程
shell.Run "cmd /c for /f ""tokens=5"" %p in ('netstat -ano ^| findstr :" & PORT & " ^| findstr LISTENING') do taskkill /PID %p /F", 0, True

opened = False
restarts = 0

Do
  shell.Run """" & pyw & """ """ & base & "\server.py"" --port " & PORT, 0, False

  ' 等它就绪（最多 20 秒）
  ok = False
  For i = 1 To 40
    WScript.Sleep 500
    If Health(URL) Then
      ok = True
      Exit For
    End If
    If i = 10 Then Exit For
  Next

  If ok And Not opened Then
    shell.Run URL, 1, False
    opened = True
  End If

  ' 守在这里：只要还活着就别动
  Do
    WScript.Sleep 2000
  Loop While Health(URL)

  restarts = restarts + 1
  WScript.Sleep 2000

  If restarts > 20 Then
    MsgBox "服务连续 " & restarts & " 次启动失败，已停止自动重启。" & vbCrLf & vbCrLf & _
           "请改用 启动.bat 查看报错信息。", 48, "课堂转写"
    WScript.Quit 1
  End If
Loop

Function Health(u)
  On Error Resume Next
  Dim x
  Set x = CreateObject("MSXML2.XMLHTTP")
  x.Open "GET", u & "api/health", False
  x.Send
  Health = (Err.Number = 0) And (x.Status = 200)
  On Error GoTo 0
End Function

Function FindPythonW()
  Dim cand, p, exec, line
  cand = Array( _
    shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none\pythonw.exe", _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python\Python312\pythonw.exe", _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python\Python313\pythonw.exe" _
  )
  For Each p In cand
    If fso.FileExists(p) Then
      FindPythonW = p
      Exit Function
    End If
  Next
  On Error Resume Next
  Set exec = shell.Exec("cmd /c where pythonw.exe")
  If Err.Number = 0 Then
    line = exec.StdOut.ReadLine()
    If Not IsEmpty(line) Then FindPythonW = line
  End If
  On Error GoTo 0
End Function
