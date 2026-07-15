<#
.SYNOPSIS
  Register a logon-triggered Task Scheduler entry that auto-starts
  the DevNeural daemon.

.DESCRIPTION
  Without this, rebooting OTLCDEV without opening VS Code leaves the
  daemon offline; the dashboard at https://otlcdev.tail27b46b.ts.net
  stops responding from the phone. After install, every logon kicks
  start-daemon.ps1 which spawns node dist/daemon.js detached.

  Idempotent: re-running replaces the existing task. Disable with
  -Disable. Trigger now with Start-ScheduledTask -TaskName
  "DevNeural-Daemon".

.PARAMETER Disable
  Unregister the task instead of installing.

.EXAMPLE
  pwsh -File install-daemon-autostart.ps1
  pwsh -File install-daemon-autostart.ps1 -Disable
#>

[CmdletBinding()]
param(
    [switch]$Disable
)

$ErrorActionPreference = 'Stop'

$taskName = 'DevNeural-Daemon'

if ($Disable) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "[install-daemon-autostart] removed task '$taskName'"
    return
}

$scriptPath = Join-Path $PSScriptRoot 'start-daemon.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "start-daemon.ps1 not found at $scriptPath"
}

$pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $pwshCmd) { $pwshCmd = Get-Command powershell -ErrorAction SilentlyContinue }
if (-not $pwshCmd) { throw 'no PowerShell on PATH' }
$pwsh = $pwshCmd.Source

# Wrap the PowerShell call in wscript + silent-shim.vbs so the 5-minute
# safety fire never flashes a console window. Task Scheduler's
# -WindowStyle Hidden alone leaves a brief flash on interactive logon
# tasks (Windows shows the conhost window before the SW_HIDE message
# applies). The shim invokes Run with WindowStyle 0 which suppresses
# conhost entirely, mirroring how silence-all-hooks.ps1 handles
# Claude Code hook commands.
$shim = "$PSScriptRoot\..\dist\capture\hooks\silent-shim.vbs"
$shim = [System.IO.Path]::GetFullPath($shim)
if (-not (Test-Path -LiteralPath $shim)) {
    throw "silent-shim.vbs not found at $shim. Run 'npm run build' or 'npm run silence-hooks' first."
}
$wscript = "$env:WINDIR\System32\wscript.exe"

# Single-string command the shim will pass to WshShell.Run with
# WindowStyle=0. Quote arguments with embedded spaces.
$inner = "$pwsh -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
$argList = "`"$shim`" `"$inner`""

$action = New-ScheduledTaskAction -Execute $wscript -Argument $argList

# Two triggers stacked for resilience:
#   AtLogOn  - covers fresh login + reboot (with 30s delay so the
#              login session warmup wins).
#   Once+5m  - safety-net that fires every 5 minutes forever; auto-
#              recovers from sleep/wake, OOM, manual kill. The repeat
#              also catches a fresh boot within 5 minutes, which is
#              why we don't need a separate AtStartup trigger
#              (AtStartup requires admin to register, breaking the
#              user-level install posture).
#
# start-daemon.ps1 short-circuits via /health probe when the daemon
# is already alive, so the 5-minute fire is near-zero-cost when
# things are healthy.
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User (whoami)
$logonTrigger.Delay = 'PT30S'

# 365-day duration is the largest the cmdlet accepts before
# overflowing the schema's PnDT format. Re-installing yearly is fine
# (we re-install on script changes anyway).
$now = Get-Date
$safetyTrigger = New-ScheduledTaskTrigger `
    -Once -At $now `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 365)

$triggers = @($logonTrigger, $safetyTrigger)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable:$false `
    -ExecutionTimeLimit ([System.TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5)

# User-level task so non-elevated PowerShell can install it. Daemon
# binds to user-level paths (~/.devneural*, %DATA_ROOT%) anyway.
$principal = New-ScheduledTaskPrincipal `
    -UserId (whoami) `
    -LogonType Interactive `
    -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Description 'DevNeural daemon autostart + watchdog. Launches node dist/daemon.js at logon, at boot, and every 5 minutes as a safety net (no-op when daemon is already alive). Keeps the dashboard reachable from the phone after sleep/wake or unexpected stops.' `
        -Action $action `
        -Trigger $triggers `
        -Settings $settings `
        -Principal $principal `
        -ErrorAction Stop | Out-Null
} catch {
    if ($_.Exception.Message -match 'Access is denied') {
        Write-Host ''
        Write-Host '[install-daemon-autostart] PowerShell cmdlet access denied; falling back to schtasks.exe'
        $schtasksPath = "$env:WINDIR\System32\schtasks.exe"
        $taskCmd = "$pwsh $argList"
        & $schtasksPath /Create /F /SC ONLOGON /TN $taskName /TR "`"$taskCmd`""
        if ($LASTEXITCODE -ne 0) {
            throw 'both Register-ScheduledTask and schtasks.exe failed'
        }
    } else {
        throw
    }
}

Write-Host "[install-daemon-autostart] registered '$taskName' to run at logon"
Write-Host "[install-daemon-autostart] command: $pwsh $argList"

# Second, on-demand-only task for operator-requested restarts.
# Root cause (2026-07-15): the /admin/daemon/restart relauncher ran
# schtasks /run on the safety-net task above, which fires start-daemon
# WITHOUT -Force. At that moment the old daemon is still tearing down,
# so the alive-probe sees it and no-ops; recovery then waited for the
# next 5-minute safety tick (the operator's multi-minute restart hang).
# This task runs start-daemon.ps1 -Force, which skips the alive-probe
# and instead waits up to 20s for :3747 to free, so a restart-time
# schtasks /run lands the relaunch in seconds. NO triggers: the safety
# net keeps its own semantics; this one only ever fires on demand.
$restartTaskName = 'DevNeural-Daemon-Restart'
$innerForce = "$pwsh -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Force"
$argListForce = "`"$shim`" `"$innerForce`""
$actionForce = New-ScheduledTaskAction -Execute $wscript -Argument $argListForce

Unregister-ScheduledTask -TaskName $restartTaskName -Confirm:$false -ErrorAction SilentlyContinue

try {
    Register-ScheduledTask `
        -TaskName $restartTaskName `
        -Description 'DevNeural daemon on-demand restart relauncher. No triggers; fired via schtasks /run by POST /admin/daemon/restart. Runs start-daemon.ps1 -Force (skips the alive-probe, waits for the port) so a restart never waits on the 5-minute safety net.' `
        -Action $actionForce `
        -Settings $settings `
        -Principal $principal `
        -ErrorAction Stop | Out-Null
} catch {
    if ($_.Exception.Message -match 'Access is denied') {
        Write-Host '[install-daemon-autostart] PowerShell cmdlet access denied for restart task; falling back to schtasks.exe'
        $schtasksPath = "$env:WINDIR\System32\schtasks.exe"
        $taskCmdForce = "$wscript $argListForce"
        & $schtasksPath /Create /F /SC ONCE /ST 00:00 /TN $restartTaskName /TR "`"$taskCmdForce`""
        if ($LASTEXITCODE -ne 0) {
            throw 'both Register-ScheduledTask and schtasks.exe failed for the restart task'
        }
    } else {
        throw
    }
}

Write-Host "[install-daemon-autostart] registered '$restartTaskName' (on-demand only)"
Write-Host "[install-daemon-autostart] trigger now: Start-ScheduledTask -TaskName $taskName"
Write-Host "[install-daemon-autostart] view in UI: taskschd.msc -> Task Scheduler Library -> $taskName"
Write-Host "[install-daemon-autostart] uninstall: pwsh -File install-daemon-autostart.ps1 -Disable"
