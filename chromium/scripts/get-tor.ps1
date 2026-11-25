$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Latest stable version number from the Tor Project, then the Expert Bundle from their archive.
$ver = (Invoke-RestMethod 'https://aus1.torproject.org/torbrowser/update_3/release/downloads.json').version
if (-not $ver) { throw 'Could not read the current Tor version' }
$name = "tor-expert-bundle-windows-x86_64-$ver.tar.gz"
$base = "https://archive.torproject.org/tor-package-archive/torbrowser/$ver"
$tmp = Join-Path $env:TEMP $name

Write-Host "Downloading Tor $ver ..."
Invoke-WebRequest "$base/$name" -OutFile $tmp

# Integrity check against the checksum file published next to the download.
$sums = (Invoke-WebRequest "$base/sha256sums-unsigned-build.txt" -UseBasicParsing).Content -split "`n"
$line = $sums | Where-Object { $_ -match [regex]::Escape($name) } | Select-Object -First 1
if (-not $line) { throw 'No checksum listed for this download' }
$want = ($line.Trim() -split '\s+')[0].ToLower()
$got = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
if ($want -ne $got) { Remove-Item $tmp -Force; throw 'Checksum mismatch, download discarded' }

$stage = Join-Path $root 'tor-stage'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null
tar -xzf $tmp -C $stage
Remove-Item $tmp -Force

Remove-Item (Join-Path $root 'tor') -Recurse -Force -ErrorAction SilentlyContinue
Move-Item (Join-Path $stage 'tor') (Join-Path $root 'tor')
if (Test-Path (Join-Path $stage 'data')) { Move-Item (Join-Path $stage 'data') (Join-Path $root 'tor\data') }
Remove-Item $stage -Recurse -Force
Write-Host "Tor $ver installed."
