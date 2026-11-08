' Runs watchdog.ps1 with no console window at all.
' Task Scheduler's "hidden" option still flashes a console briefly; wscript
' does not, so a check every 2 minutes stays genuinely invisible.
Dim shell, here
Set shell = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & here & "watchdog.ps1""", 0, False
