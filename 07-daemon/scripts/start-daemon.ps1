<#
.SYNOPSIS
  Start the DevNeural daemon detached.

.DESCRIPTION
  Used by the autostart Task Scheduler entry so the dashboard is
  reachable from the phone without the user having to open VS Code
  or any specific app on OTLCDEV. Idempotent: the daemon's own
  PID-file check exits cleanly if another instance is already alive,
  so re-running this script after a crash or manual start is safe.

  Captures stdout/stderr to %DEVNEURAL_DATA_ROOT%\daemon.log so a
  failed launch is debuggable in the dashboard's log tail.

.PARAMETER DaemonRoot
  Path to the 07-daemon directory. Auto-detected from $PSScriptRoot.

.EXAMPLE
  pwsh -File start-daemon.ps1
#>

[CmdletBinding()]
param(
    [string]$DaemonRoot,
    # When set, skip the "already alive" health probe and always
    # spawn node. Used by the /admin/daemon/restart route: the old
    # daemon may still be answering /health during its graceful
    # shutdown window (chokidar watcher close + app.close + store
    # close take 2-6s on Windows), so a probe at relauncher-spawn
    # time would self-skip and leave nothing alive once the sidecar
    # hard-kill fires at +6s. Task Scheduler autostart MUST NOT pass
    # this flag; it relies on the probe to no-op when healthy.
    [switch]$Force
)

# Resolve the daemon root relative to this script's location. Use a
# fallback chain because $PSScriptRoot is sometimes empty when the
# script is invoked with a forward-slash path through `powershell.exe
# -File ...` from a non-PowerShell shell (bash, cmd).
if ([string]::IsNullOrWhiteSpace($DaemonRoot)) {
    $scriptDir = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($scriptDir)) {
        $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    if ([string]::IsNullOrWhiteSpace($scriptDir)) {
        $scriptDir = (Get-Location).Path
    }
    $DaemonRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
}

$ErrorActionPreference = 'Stop'

$dist = Join-Path $DaemonRoot 'dist\daemon.js'
if (-not (Test-Path -LiteralPath $dist)) {
    throw "daemon.js not found at $dist. Run 'npm run build' in 07-daemon first."
}

# Cheap health probe before spawning. The autostart task fires every
# 5 minutes as a safety net; if the daemon is already alive on
# localhost:3747 we exit silently to avoid burning CPU on a no-op
# Node startup. Daemon's own PID-file singleton check is the
# authoritative guard, but skipping the spawn entirely is friendlier.
#
# Skipped when -Force is set (dashboard restart path). See param block.
$port = if ($env:DEVNEURAL_PORT) { [int]$env:DEVNEURAL_PORT } else { 3747 }
if (-not $Force) {
    try {
        $existing = Invoke-WebRequest -Uri "http://localhost:$port/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($existing.StatusCode -eq 200) {
            Write-Host "[start-daemon] already alive on :$port; skipping spawn"
            exit 0
        }
    } catch {
        # Not reachable; proceed with launch.
    }
} else {
    Write-Host "[start-daemon] -Force set; bypassing already-alive probe"
    # When called from /admin/daemon/restart, the old daemon may still
    # hold :$port during its graceful shutdown. Spawning node now would
    # EADDRINUSE the listen socket. Wait up to 20s for the port to free.
    # The restart route's sidecar kill fires at +6s so the worst-case
    # ungraceful exit still clears the port well inside this window.
    $portFreeDeadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $portFreeDeadline) {
        $stillBound = $false
        try {
            $probe = Invoke-WebRequest -Uri "http://localhost:$port/health" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
            if ($probe.StatusCode -eq 200) { $stillBound = $true }
        } catch {
            # Not reachable means port is free (or at least no Fastify
            # answering). Good enough to attempt the bind.
        }
        if (-not $stillBound) { break }
        Start-Sleep -Milliseconds 500
    }
}

# PowerShell 5.1 (default Windows shell) doesn't support `?.` so we
# fall back to an explicit null check.
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw "node not on PATH. Install Node.js or set explicit path."
}
$node = $nodeCmd.Source

# Use the data root the daemon is configured for (matches DATA_ROOT default
# in 07-daemon/src/paths.ts). DEVNEURAL_DATA_ROOT env override respected.
$dataRoot = if ($env:DEVNEURAL_DATA_ROOT) { $env:DEVNEURAL_DATA_ROOT } else { 'C:\dev\data\skill-connections' }
if (-not (Test-Path -LiteralPath $dataRoot)) {
    New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
}
$logFile = Join-Path $dataRoot 'daemon.log'

# Detached child process so the scheduled task can exit immediately
# while the daemon keeps running. WindowStyle Hidden + windowsHide on
# child_process keeps the console flash off the desktop (Anti-slop #26).
#
# Earlier versions used RedirectStandardOutput=$true with an event-driven
# StreamWriter to bridge stdout/stderr into the daemon log. The
# StreamWriter and the event handlers were owned by the PowerShell
# runtime, so when this script exited at line 106, Node's writes to the
# now-closed pipes failed with EPIPE and the daemon died moments after
# bind. Switch to Start-Process with file-level redirection so the
# pipes are owned by the OS and survive the parent's exit. The daemon
# also writes its own structured lines to daemon.log via fs.appendFile,
# so we redirect to a stdout-only sidecar file and let the Node-managed
# log carry the structured stream.
$stdoutLog = Join-Path $dataRoot 'daemon.stdout.log'
$stderrLog = Join-Path $dataRoot 'daemon.stderr.log'

# Route distillation (scheduled backfill + staleness re-distill + the
# critical end-of-session path) through the headless Opus engine instead
# of ollama. Set here so it inherits to the spawned node on BOTH the
# Task Scheduler autostart path and the dashboard /admin/daemon/restart
# (-Force) path. The child inherits this process's $env. Reversible:
# delete this line to fall back to the ollama distiller.
$env:DEVNEURAL_DISTILL_HEADLESS = '1'

# Route inbound voice through the haiku talk-layer (front desk: control /
# fast haiku / slow haiku+Lex). Flag-off is byte-identical to the prior
# voice. Inherits to the spawned node. Reversible: delete this line to
# roll back to the pre-haiku voice.
$env:DEVNEURAL_VOICE_HAIKU = '1'

# Headless Opus refinement of the Lex cold-start seed. The synchronous
# gateColdStart floor always runs; this only enables the bounded async
# upgrade pass (prewarmInvestigator, 60s timeout, fail-safe by
# contract). Same shared engine already proven by DISTILL_HEADLESS
# above. Reversible: delete this line to keep the deterministic floor
# only. Enabled 2026-07-09 (operator directive: no gates).
$env:DEVNEURAL_INVESTIGATOR_HEADLESS = '1'

$proc = Start-Process `
    -FilePath $node `
    -ArgumentList "`"$dist`"" `
    -WorkingDirectory $DaemonRoot `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog

Write-Host "[start-daemon] launched node $dist (pid=$($proc.Id))"
exit 0
