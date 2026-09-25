' ============================================================
'  静默运行Uchat.vbs —— 双击即可，全程无窗口地把 Uchat 跑起来
'
'  它只做一件事：用隐藏窗口启动 静默运行Uchat.ps1（守护进程）。
'  那个守护进程负责：服务看门狗 + 阻止休眠 + TURN + 两个 AI，
'  并顺带拉起托盘状态监视 静默监视Uchat.ps1（右下角图标）：
'
'     绿点 = 服务正常   黄点 = 探测抖动   红点 = 无响应
'     掉线 / 恢复都会弹气泡提醒；右键菜单可打开页面、重启服务、停止 Uchat
'
'  停止：双击 停止Uchat.bat（会先停守护与托盘，再停服务/AI/TURN）
'  想看窗口版（排障用）：双击 稳定运行Uchat.bat
' ============================================================
Option Explicit
Dim sh, fso, root, ps1

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ps1  = root & "\静默运行Uchat.ps1"

If Not fso.FileExists(ps1) Then
    MsgBox "找不到 " & ps1 & vbCrLf & "请确认 Uchat 目录完整。", 16, "Uchat"
    WScript.Quit 1
End If

' 0 = 隐藏窗口且不激活；第 3 个参数 False = 不等它结束（wscript 立刻退出）
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
