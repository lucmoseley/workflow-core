' Runs watchdog.ps1 with no console window at all, then boots the WSL VM if it
' is down, so an unattended reboot or a VM death costs minutes, not the hours
' until someone opens a terminal (#4057).
' Task Scheduler's "hidden" option still flashes a console briefly; wscript
' does not, so a check every 2 minutes stays genuinely invisible.
Dim shell, here
Set shell = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & here & "watchdog.ps1""", 0, False
KeepWslUp

' Starts the default distro when no vmmemWSL process exists. The distro then
' stays up on its own (.wslconfig instanceIdleTimeout=-1) and systemd's
' refill-loop-boot.service resumes the loop. A start still pending is never
' doubled, so a hung WSL service cannot pile up wsl.exe processes; and after
' MAX_STARTS starts inside WINDOW_S seconds it stops starting until the oldest
' leaves the window, the log holding those starts as the visible failure.
Sub KeepWslUp()
	Const MAX_STARTS = 3
	Const WINDOW_S = 1800
	Dim wmi, fso, logPath, nowS, recent, f, line
	Set wmi = GetObject("winmgmts:\\.\root\cimv2")
	If wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'vmmemWSL'").Count > 0 Then Exit Sub
	If wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'wsl.exe' AND CommandLine LIKE '%--exec /bin/true%'").Count > 0 Then Exit Sub

	Set fso = CreateObject("Scripting.FileSystemObject")
	logPath = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\wsl-keepalive.log"
	nowS = DateDiff("s", #1/1/2026#, Now)
	recent = 0
	If fso.FileExists(logPath) Then
		Set f = fso.OpenTextFile(logPath, 1)
		Do Until f.AtEndOfStream
			line = Split(f.ReadLine & " ", " ")(0)
			If IsNumeric(line) Then
				If nowS - CLng(line) < WINDOW_S Then recent = recent + 1
			End If
		Loop
		f.Close
	End If
	If recent >= MAX_STARTS Then Exit Sub

	Set f = fso.OpenTextFile(logPath, 8, True)
	f.WriteLine nowS & " " & Now & " vmmemWSL absent; starting the default distro"
	f.Close
	shell.Run "wsl.exe --exec /bin/true", 0, False
End Sub
