' Runs watchdog.ps1 with no console window at all, then boots the WSL VM if it
' is down (#4057).
' Task Scheduler's "hidden" option still flashes a console briefly; wscript
' does not, so a check every 2 minutes stays genuinely invisible.
Dim shell, here
Set shell = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & here & "watchdog.ps1""", 0, False
KeepWslUp

' Starts the default distro when no vmmemWSL process exists. The distro then
' stays up on its own (.wslconfig instanceIdleTimeout=-1) and systemd's
' refill-loop-boot.service resumes the loop. While any wsl.exe runs without a
' vmmemWSL a boot is pending, and none is started beside it, so a hung WSL
' service cannot pile up wsl.exe processes.
' Residual: a failing start is visible only in wsl-keepalive.log, which nothing
' surfaces; a capped tick writes nothing; and the log is never trimmed (at most
' 144 lines a day while the VM will not stay up).
Sub KeepWslUp()
	' A first guess, unmeasured: 3 starts across 15 ticks of the 2-minute task
	' is a VM that will not stay up, not one slow boot.
	Const MAX_STARTS = 3
	Const WINDOW_S = 1800
	Dim wmi, fso, logPath, nowS, recent, f, stamp, age, digits
	Set wmi = GetObject("winmgmts:\\.\root\cimv2")
	If wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'vmmemWSL'").Count > 0 Then Exit Sub
	If wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'wsl.exe'").Count > 0 Then Exit Sub

	Set fso = CreateObject("Scripting.FileSystemObject")
	logPath = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\wsl-keepalive.log"
	' Any fixed recent epoch works: it keeps the seconds count small.
	nowS = DateDiff("s", #1/1/2026#, Now)
	Set digits = New RegExp
	digits.Pattern = "^[0-9]{1,10}$"
	recent = 0
	If fso.FileExists(logPath) Then
		Set f = fso.OpenTextFile(logPath, 1)
		Do Until f.AtEndOfStream
			stamp = Split(f.ReadLine & " ", " ")(0)
			If digits.Test(stamp) Then
				' A stamp ahead of now (a clock set back, a zone change) is not recent.
				age = nowS - CDbl(stamp)
				If age >= 0 And age < WINDOW_S Then recent = recent + 1
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
