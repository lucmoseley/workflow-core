# WSL interop-bridge watchdog.
#
# Detects the failure mode where WSL's Windows interop bridge (/init) wedges and
# reg.exe calls launched from inside WSL never return. Symptom seen from Windows:
# reg.exe processes whose parent is wsl.exe, alive far longer than the ~40ms a
# real registry query takes, accumulating one per blocked `claude` launch.
#
# DETECT AND NOTIFY ONLY. This script never runs `wsl --shutdown`: a false
# positive would kill live background sessions, which is worse than the fault.
#
# Installed by `scripts/install-interop-watchdog.sh` in the workflow-core repo.
# Runs as a scheduled task at logon, repeating every 2 minutes. No maintenance.

$ErrorActionPreference = 'Stop'

$AgeThresholdSeconds  = 60      # a real reg.exe query takes ~0.04s
$AccumulationCount    = 3       # 9 had piled up in the observed incident
$CooldownMinutes      = 30      # don't re-toast the same wedge every 2 minutes
$StampFile            = Join-Path $env:LOCALAPPDATA 'wsl-interop-watchdog.laststamp'
$LogFile              = Join-Path $env:LOCALAPPDATA 'wsl-interop-watchdog.log'

function Write-Log([string]$Message) {
    try {
        $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
        Add-Content -Path $LogFile -Value $line -Encoding UTF8
        # Keep the log from growing without bound; no maintenance required.
        $item = Get-Item $LogFile -ErrorAction SilentlyContinue
        if ($item -and $item.Length -gt 200KB) {
            $keep = Get-Content $LogFile -Tail 500
            Set-Content -Path $LogFile -Value $keep -Encoding UTF8
        }
    } catch { }
}

function Show-Toast([string]$Title, [string]$Body) {
    # Built-in WinRT toast. Uses the stock Windows PowerShell AppID so no module
    # (BurntToast et al.) and no Start Menu shortcut registration is needed.
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.UI.Notifications.ToastNotification,        Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument,                  Windows.Data.Xml.Dom,     ContentType = WindowsRuntime]

    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
        [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $template.GetElementsByTagName('text')
    $texts.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
    $texts.Item(1).AppendChild($template.CreateTextNode($Body))  | Out-Null

    # Keep it in Action Center until dismissed - a 5s banner is easy to miss.
    $toastNode = $template.SelectSingleNode('/toast')
    $toastNode.SetAttribute('scenario', 'reminder') | Out-Null

    $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
}

function Test-Cooldown {
    if (-not (Test-Path $StampFile)) { return $true }
    try {
        $last = Get-Content $StampFile -Raw
        $lastTime = [datetime]::Parse($last.Trim(), [Globalization.CultureInfo]::InvariantCulture)
        return ((Get-Date) - $lastTime).TotalMinutes -ge $CooldownMinutes
    } catch { return $true }
}

# --- detection -------------------------------------------------------------

try {
    $now = Get-Date

    # Only reg.exe launched from inside WSL. Interop-spawned Windows processes
    # are parented to wsl.exe; a reg.exe run natively in Windows is not, so this
    # will not fire on ordinary Windows use of the registry editor tooling.
    $stuck = @(
        Get-CimInstance Win32_Process -Filter "Name='reg.exe'" -ErrorAction SilentlyContinue |
        ForEach-Object {
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" -ErrorAction SilentlyContinue
            if ($parent -and $parent.Name -eq 'wsl.exe') {
                $age = ($now - $_.CreationDate).TotalSeconds
                if ($age -ge $AgeThresholdSeconds) {
                    [PSCustomObject]@{
                        ProcessId = $_.ProcessId
                        Age       = [math]::Round($age, 1)
                        Cmd       = [string]$_.CommandLine
                    }
                }
            }
        }
    )

    if ($stuck.Count -eq 0) { exit 0 }

    # Two independent signatures, either of which is effectively impossible in
    # normal operation:
    #   1. the exact query that wedges - Claude Code's managed-policy lookup
    #   2. accumulation - several stuck interop reg.exe calls at once
    $policyHit   = @($stuck | Where-Object { $_.Cmd -match 'Policies\\ClaudeCode' }).Count -gt 0
    $accumulated = $stuck.Count -ge $AccumulationCount

    if (-not ($policyHit -or $accumulated)) {
        Write-Log ("ignored: {0} long-lived interop reg.exe, no fault signature" -f $stuck.Count)
        exit 0
    }

    $reason = if ($policyHit) { 'ClaudeCode policy query' } else { ('{0} stuck calls' -f $stuck.Count) }
    Write-Log ("DETECTED ({0}); pids: {1}" -f $reason, (($stuck | ForEach-Object { $_.ProcessId }) -join ','))

    if (-not (Test-Cooldown)) {
        Write-Log 'suppressed by cooldown'
        exit 0
    }

    Show-Toast 'WSL interop bridge is wedged' `
        'Close all WSL/terminal windows, run  wsl --shutdown  in PowerShell, then reopen. Your Claude session transcripts are saved on disk - nothing is lost.'

    Set-Content -Path $StampFile -Value ((Get-Date).ToString('o')) -Encoding ASCII
    Write-Log 'toast raised'
    exit 0
}
catch {
    Write-Log ("watchdog error: {0}" -f $_.Exception.Message)
    exit 0   # never let the watchdog itself become a problem
}
