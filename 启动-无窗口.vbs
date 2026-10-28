Option Explicit
' 课堂转写 —— 无窗口启动（脚本可随文件夹一起移动）
Dim shell, fso, base, port, url, i, ok, pyw
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
port = 8787
url = "http://127.0.0.1:" & port & "/"

If Not fso.FileExists(base & "\server.py") Then
  MsgBox "找不到 server.py，请把本文件放回程序文件夹。" & vbCrLf & base, 16, "课堂转写"
  WScript.Quit 1
End If

If Health(url) Then
  shell.Run url, 1, False
  WScript.Quit 0
End If

shell.Run "cmd /c for /f ""tokens=5"" %p in ('netstat -ano ^| findstr :" & port & " ^| findstr LISTENING') do taskkill /PID %p /F", 0, True

pyw = FindPythonW()
If pyw = "" Then
  MsgBox "找不到 pythonw.exe，请确认 Python 已安装。", 16, "课堂转写"
  WScript.Quit 1
End If

shell.CurrentDirectory = base
shell.Run """" & pyw & """ """ & base & "\server.py"" --port " & port, 0, False

ok = False
For i = 1 To 30
  WScript.Sleep 1000
  If Health(url) Then
    ok = True
    Exit For
  End If
Next

If ok Then
  shell.Run url, 1, False
Else
  MsgBox "30 秒内没能连上服务。" & vbCrLf & vbCrLf & _
         "请改用 一键启动.bat 查看报错。", 48, "课堂转写"
End If

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
  Dim cand, p
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
  Dim exec, line
  On Error Resume Next
  Set exec = shell.Exec("cmd /c where pythonw.exe")
  If Err.Number = 0 Then
    line = exec.StdOut.ReadLine()
    If Not IsEmpty(line) Then FindPythonW = line
  End If
  On Error GoTo 0
End Function
