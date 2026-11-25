. (Join-Path $PSScriptRoot 'common.ps1')
Add-Type -AssemblyName System.Windows.Forms
try {
$tor = Find-TorDir
if (-not $tor) {
  [System.Windows.Forms.MessageBox]::Show('Tor Browser was not found. Run setup.bat first.', 'Squint') | Out-Null
  exit 1
}
$c = Get-Config
if ($c.torDir -ne $tor) { $c.torDir = $tor; Save-Config $c }

# Apply the Squint look before every start, so any change made to the skin shows up on the next launch.
$ok = Apply-Skin $tor
if (-not $ok) {
  # first run: Tor Browser has not created its profile yet. Start it once, plain.
  [System.Windows.Forms.MessageBox]::Show("First start: Tor Browser will open without the Squint look. Connect, close it, then open Squint again.", 'Squint') | Out-Null
}

# Start it the same way Tor Browser's own shortcut does when there is one, else firefox.exe directly.
$lnk = Join-Path $tor 'Start Tor Browser.lnk'
$exe = Join-Path $tor 'Browser\firefox.exe'; $args_ = ''
if (Test-Path $lnk) {
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  if ($s.TargetPath -and (Test-Path $s.TargetPath)) { $exe = $s.TargetPath; $args_ = $s.Arguments }
}
if ($args_) { Start-Process $exe -ArgumentList $args_ -WorkingDirectory (Split-Path $exe) } else { Start-Process $exe -WorkingDirectory (Split-Path $exe) }
} catch {
  [System.Windows.Forms.MessageBox]::Show("Squint could not start:`n" + $_.Exception.Message, 'Squint') | Out-Null
  exit 1
}
