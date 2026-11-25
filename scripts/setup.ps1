. (Join-Path $PSScriptRoot 'common.ps1')
$ProgressPreference = 'SilentlyContinue'
Write-Host ''
Write-Host 'Squint setup' -ForegroundColor Cyan

$tor = Find-TorDir
if ($tor) {
  Write-Host "Found Tor Browser: $tor"
} else {
  Write-Host 'Tor Browser not found. Downloading the current version from torproject.org ...'
  $j = Invoke-RestMethod 'https://aus1.torproject.org/torbrowser/update_3/release/downloads.json'
  $ver = $j.version
  $url = $j.downloads.win64.ALL.binary
  if (-not $ver -or -not $url) { throw 'Could not read the current Tor Browser version.' }
  $name = Split-Path $url -Leaf
  $tmp = Join-Path $env:TEMP $name
  Invoke-WebRequest $url -OutFile $tmp

  # integrity: compare with the checksum list the Tor Project publishes for this version
  $sumUrl = "https://dist.torproject.org/torbrowser/$ver/sha256sums-signed-build.txt"
  $line = ((Invoke-WebRequest $sumUrl -UseBasicParsing).Content -split "`n") | Where-Object { $_ -match [regex]::Escape($name) } | Select-Object -First 1
  if (-not $line) { Remove-Item $tmp -Force; throw 'No checksum is listed for this download. Stopping.' }
  $want = ($line.Trim() -split '\s+')[0].ToLower()
  $got = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  if ($want -ne $got) { Remove-Item $tmp -Force; throw 'Checksum mismatch. The download was discarded.' }
  Write-Host "Tor Browser $ver downloaded and checked."

  $dest = Join-Path $Root 'TorBrowser'
  Write-Host 'Installing (silent) ...'
  Start-Process $tmp -ArgumentList "/S /D=$dest" -Wait
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  $tor = Find-TorDir
  if (-not $tor) { throw 'The installer finished but Tor Browser was not found. Install it by hand from torproject.org, then run setup again.' }
  Write-Host "Installed: $tor"
}
$c = Get-Config; $c.torDir = $tor; Save-Config $c

# shortcuts with the Squint name and icon
$icon = Join-Path $Root 'assets\icon.ico'
$ws = New-Object -ComObject WScript.Shell
$targets = @((Join-Path ([Environment]::GetFolderPath('Desktop')) "$($c.name).lnk"), (Join-Path ([Environment]::GetFolderPath('Programs')) "$($c.name).lnk"))
foreach ($t in $targets) {
  try {
    $s = $ws.CreateShortcut($t)
    $s.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    $s.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Root 'scripts\launch.ps1') + '"'
    $s.WorkingDirectory = $Root
    $s.IconLocation = $icon
    $s.Description = $c.name
    $s.Save()
    Write-Host "Shortcut: $t"
  } catch { Write-Host "Could not write $t" }
}

if (Apply-Skin $tor) { Write-Host 'Squint look applied.' }
else { Write-Host 'Open Tor Browser once (connect, then close it). After that Squint applies its look on every start.' }
Write-Host ''
Write-Host 'Done. Open Squint from your desktop. Tor Browser updates itself; leave that on.' -ForegroundColor Green
