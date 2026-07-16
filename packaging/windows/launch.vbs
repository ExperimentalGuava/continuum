' Continuum launcher — starts the app with NO console window.
' node.exe is a console program, so launching it directly (or via a shortcut) pops a
' black window. This shim runs it hidden (window style 0); the only visible UI is
' Continuum's own app window. Shortcuts and the installer point here instead of node.exe.
Dim sh, appDir
Set sh = CreateObject("WScript.Shell")
appDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run """" & appDir & "node\node.exe"" """ & appDir & "bin\continuum.mjs"" app", 0, False
