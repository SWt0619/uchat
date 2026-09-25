' 安装「Uchat 应用窗口」桌面快捷方式（2026-09-25）
' 说明：不依赖 PWA 安装，直接用 Chrome 的 --app 模式打开（无地址栏），
'       分享给朋友时把下面的 URL 改成你的对外地址即可（例如 https://你的域名:端口/）。
Option Explicit
Dim url, shell, fso, desktop, lnk, chrome, home
url = "https://127.0.0.1:8888/"
If WScript.Arguments.Count >= 1 Then url = WScript.Arguments(0)
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
desktop = shell.SpecialFolders("Desktop")
home = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%")
chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
If Not fso.FileExists(chrome) Then
    If fso.FileExists(home & "\Google\Chrome\Application\chrome.exe") Then chrome = home & "\Google\Chrome\Application\chrome.exe"
End If
Set lnk = shell.CreateShortcut(desktop & "\Uchat 聊天室.lnk")
lnk.TargetPath = chrome
lnk.Arguments = "--app=" & url
lnk.WorkingDirectory = desktop
lnk.Description = "Uchat 聊天室（应用窗口）"
lnk.IconLocation = chrome & ",0"
lnk.Save
MsgBox "已创建桌面快捷方式：Uchat 聊天室" & vbCrLf & "打开地址：" & url, 64, "Uchat"
