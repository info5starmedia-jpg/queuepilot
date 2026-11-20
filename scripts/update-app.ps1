# QueuePilot app self-update - the detached half of POST /app/update.
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
# Profiles, proxies, settings and engines live in %USERPROFILE%\.queuepilot -
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
  Log "ERROR: old process $OldPid still alive after 90s - aborting without changes"
  exit 1
}

# 2. Stage the zip next to the app (same-volume rename is atomic-ish).
$stage = Join-Path $AppRoot ("_update-" + [Guid]::NewGuid().ToString("N"))
Expand-Archive -Path $Zip -DestinationPath $stage -Force
Log "staged to $stage"

# 3. Refresh externals ONLY when the dependency manifest changed, so an
#    update with the same externals works fully offline.
$depsChanged = $true
# Snapshot the OLD dependencies before the swap, so we can tell whether the
# npm reconciliation below is needed at all.
try {
  $oldDeps = (Get-Content (Join-Path $AppRoot "package.json") -Raw | ConvertFrom-Json).dependencies | ConvertTo-Json -Compress -Depth 5
} catch { $oldDeps = $null }

# 4. Swap app files FIRST, so the npm step below sees the NEW package.json.
#    /E copies everything the zip carries; the folder is not mirrored, so
#    .runtime and any local files the zip doesn't know stay put.
robocopy $stage $AppRoot /E /NFL /NDL /NJH /NJS /R:2 /W:2 | Out-Null
if ($LASTEXITCODE -gt 7) { Log "ERROR: robocopy exit $LASTEXITCODE"; exit 1 }

try {
  $newDeps = (Get-Content (Join-Path $AppRoot "package.json") -Raw | ConvertFrom-Json).dependencies | ConvertTo-Json -Compress -Depth 5
  $depsChanged = ($oldDeps -eq $null) -or ($oldDeps -ne $newDeps)
} catch { Log "package.json compare failed ($_) - treating deps as changed" }

if ($depsChanged) {
  # --ignore-scripts: better-sqlite3 ships N-API prebuilds, so npm's auto
  # node-gyp rebuild is both unneeded and impossible on family machines
  # (no C++ toolchain). The zip already vendors node_modules; this install
  # only reconciles the tree against the new package.json.
  # Prefer the portable runtime the bootstrapper may have installed; fall back
  # to PATH node (npm ships with both).
  $node = Join-Path $AppRoot ".runtime\node\node.exe"
  if (-not (Test-Path $node)) { $node = "node" }
  Log "externals changed - npm install --omit=dev (node: $node)"
  Push-Location $AppRoot
  & $node (Join-Path $AppRoot ".runtime\node\node_modules\npm\bin\npm-cli.js") install --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    # npm on PATH covers installs that never used the portable runtime.
    npm install --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Pop-Location; Log "ERROR: npm install failed"; exit 1 }
  }
  Pop-Location
  Log "externals refreshed"
} else {
  Log "externals unchanged - skipping npm install"
}

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
  Log "QueuePilot.cmd missing - start the app manually once"
}
Log "update done"
exit 0
