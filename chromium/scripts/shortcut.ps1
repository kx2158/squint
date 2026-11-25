$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $root 'assets\icon.ico'
$brand = (Get-Content (Join-Path $root 'brand.json') -Raw | ConvertFrom-Json).name
$desk = [Environment]::GetFolderPath('Desktop')
$start = Join-Path ([Environment]::GetFolderPath('Programs')) ''
$pinned = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$old = 'Plain', 'Veil', 'Squint', $brand
$ws = New-Object -ComObject WScript.Shell

# remove every older copy of this browser's shortcut (desktop, Start menu, taskbar pin)
$removedPin = $false
foreach ($dir in $desk, $start, $pinned) {
  if (-not (Test-Path $dir)) { continue }
  foreach ($n in $old) {
    $f = Join-Path $dir "$n.lnk"
    if (Test-Path $f) {
      $isPin = ($dir -eq $pinned)
      Remove-Item $f -Force -ErrorAction SilentlyContinue
      if ($isPin) { $removedPin = $true }
      Write-Host "Removed old shortcut: $f"
    }
  }
}

function New-Link($path) {
  $s = $ws.CreateShortcut($path)
  $s.TargetPath = $exe
  $s.Arguments = '.'
  $s.WorkingDirectory = $root
  $s.IconLocation = $icon
  $s.Description = $brand
  $s.Save()
  Write-Host "Shortcut: $path"
}
New-Link (Join-Path $desk "$brand.lnk")
if (Test-Path $start) { New-Link (Join-Path $start "$brand.lnk") }

if ($removedPin) {
  Write-Host ''
  Write-Host 'Refreshing the taskbar (the screen blinks for a second)...'
  Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
}
Write-Host ''
Write-Host "Now right-click the new '$brand' shortcut on your desktop > Show more options > Pin to taskbar."
