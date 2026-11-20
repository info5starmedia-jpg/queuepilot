# QueuePilot app self-update — the detached half of POST /app/update.
#
# The API (old version) downloads and hash-verifies the release zip, spawns
# this script detached, and exits. Only then can files be replaced: the
# native sqlite addon in node_modules stays locked for as long as the API
# process lives. Steps: wait for the old PID -> stage the zip -> refresh
# externals only when their manifest changed -> swap the app files -> relaunch.
#
#   -Zip     full path of the verified release zip (in the data dir's updates/)
#   -AppRoot the extracted release folder (the one holding install.json)
#   -OldPid  the API process to wait out
#
# Profiles, proxies, settings and engines live in %USERPROFILE%\.queuepilot —
# none of them are touched here.
param(
  [Parameter(Mandatory = $true)][string]$Zip,
  [Parameter(Mandatory = $true)][string]$AppRoot,
  [Parameter(Mandatory = $true)][int]$OldPid
)
$ErrorActionPreference = "Stop"
$log = Join-Path $AppRoot "update.log"
function Log($m) { Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m) }
Log "update start: zip=$Zip appRoot=$AppRoot oldPid=$OldPid"

# 1. Wait for the old API to exit (it self-terminates ~1s after spawning us).
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Id $OldPid -ErrorAction SilentlyContinue
  if (-not $p) { break }
  Start-Sleep -Milliseconds 500
}
if (Get-Process -Id $OldPid -ErrorAction SilentlyContinue) {
  Log "ERROR: old process $OldPid still alive after 90s — aborting without changes"
  exit 1
}

# 2. Stage the zip next to the app (same-volume rename is atomic-ish).
$stage = Join-Path $AppRoot ("_update-" + [Guid]::NewGuid().ToString("N"))
Expand-Archive -Path $Zip -DestinationPath $stage -Force
Log "staged to $stage"

# 3. Refresh externals ONLY when the dependency manifest changed, so an
#    update with the same externals works fully offline.
$depsChanged = $true
try {
  $oldPkg = Get-Content (Join-Path $AppRoot "package.json") -Raw | ConvertFrom-Json
  $newPkg = Get-Content (Join-Path $stage "package.json") -Raw | ConvertFrom-Json
  $depsChanged = ($oldPkg.dependencies | ConvertTo-Json -Compress -Depth 5) -ne ($newPkg.dependencies | ConvertTo-Json -Compress -Depth 5)
} catch { Log "package.json compare failed ($_) — treating deps as changed" }

if ($depsChanged) {
  # Prefer the portable runtime the bootstrapper may have installed; fall back
  # to PATH node (npm ships with both).
  $node = Join-Path $AppRoot ".runtime\node\node.exe"
  if (-not (Test-Path $node)) { $node = "node" }
  Log "externals changed — npm ci --omit=dev (node: $node)"
  Push-Location $AppRoot
  & $node (Join-Path $AppRoot ".runtime\node\node_modules\npm\bin\npm-cli.js") ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    # npm on PATH covers installs that never used the portable runtime.
    npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Pop-Location; Log "ERROR: npm ci failed"; exit 1 }
  }
  Pop-Location
  Log "externals refreshed"
} else {
  Log "externals unchanged — skipping npm ci"
}

# 4. Swap app files. /E copies everything the zip carries; the folder is not
#    mirrored, so .runtime and any local files the zip doesn't know stay put.
robocopy $stage $AppRoot /E /NFL /NDL /NJH /NJS /R:2 /W:2 | Out-Null
if ($LASTEXITCODE -gt 7) { Log "ERROR: robocopy exit $LASTEXITCODE"; exit 1 }
Remove-Item -Recurse -Force $stage
Remove-Item -Force $Zip -ErrorAction SilentlyContinue
Log "files swapped"

# 5. Relaunch the family launcher (it reuses the running-API check, so this
#    is safe even if something else already restarted the app).
$launcher = Join-Path $AppRoot "QueuePilot.cmd"
if (Test-Path $launcher) {
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$launcher`"" -WorkingDirectory $AppRoot -WindowStyle Minimized
  Log "relaunched via QueuePilot.cmd"
} else {
  Log "QueuePilot.cmd missing — start the app manually once"
}
Log "update done"
exit 0
