' 删除「Uchat 聊天室」桌面快捷方式
Option Explicit
Dim shell, fso, desktop, p
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
desktop = shell.SpecialFolders("Desktop")
p = desktop & "\Uchat 聊天室.lnk"
If fso.FileExists(p) Then
    fso.DeleteFile p, True
    MsgBox "已删除桌面快捷方式", 64, "Uchat"
Else
    MsgBox "桌面上没有这个快捷方式", 48, "Uchat"
End If
