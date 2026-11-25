# Shared helpers for setup.ps1 and launch.ps1
$ErrorActionPreference = 'Stop'
$script:Root = Split-Path -Parent $PSScriptRoot
$script:ConfigFile = Join-Path $Root 'config.json'

function Get-Config { Get-Content $ConfigFile -Raw | ConvertFrom-Json }
function Save-Config($c) { $c | ConvertTo-Json | Set-Content $ConfigFile -Encoding UTF8 }

# A Tor Browser folder has Browser\firefox.exe inside it.
function Test-TorDir($d) { $d -and (Test-Path (Join-Path $d 'Browser\firefox.exe')) }

function Find-TorDir {
  $c = Get-Config
  if (Test-TorDir $c.torDir) { return $c.torDir }
  $home_ = [Environment]::GetFolderPath('UserProfile')
  $cands = @(
    (Join-Path $Root 'TorBrowser'),
    (Join-Path $Root 'TorBrowser\Tor Browser'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Tor Browser'),
    (Join-Path $home_ 'Downloads\Tor Browser'),
    (Join-Path $home_ 'Documents\Tor Browser')
  )
  foreach ($base in @($env:LOCALAPPDATA, (Join-Path $env:LOCALAPPDATA 'Programs'), $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($base) { $cands += (Join-Path $base 'Tor Browser') }
  }
  foreach ($d in $cands) { if (Test-TorDir $d) { return $d } }
  return $null
}

function Get-ProfileDir($tor) { Join-Path $tor 'Browser\TorBrowser\Data\Browser\profile.default' }

# Copy the Squint look into the Tor Browser profile. Only the profile is touched, never the program
# folder, so Tor Browser's own updater keeps working.
function Apply-Skin($tor) {
  $prof = Get-ProfileDir $tor
  if (-not (Test-Path $prof)) { return $false }

  New-Item -ItemType Directory -Force -Path (Join-Path $prof 'chrome') | Out-Null
  Copy-Item (Join-Path $Root 'skin\chrome\*') (Join-Path $prof 'chrome') -Recurse -Force

  # start page: pins.json -> tiles
  $enc = { param($s) [System.Net.WebUtility]::HtmlEncode([string]$s) }
  $tiles = ''
  try {
    foreach ($p in (Get-Content (Join-Path $Root 'pins.json') -Raw | ConvertFrom-Json)) {
      if ($p.url -match '^https?://') { $tiles += '<a class="t" href="' + (& $enc $p.url) + '"><div class="i">' + (& $enc (([string]$p.title + '?').Substring(0,1))) + '</div><div class="l">' + (& $enc $p.title) + '</div></a>' }
    }
  } catch { }
  $html = (Get-Content (Join-Path $Root 'skin\start.html') -Raw -Encoding UTF8).Replace('@@PINS@@', $tiles)
  $startFile = Join-Path $Root 'start.generated.html'
  [IO.File]::WriteAllText($startFile, $html, (New-Object Text.UTF8Encoding($false)))
  $startUrl = ([Uri]$startFile).AbsoluteUri

  # user.js: replace only our own block
  $uj = Join-Path $prof 'user.js'
  $old = if (Test-Path $uj) { Get-Content $uj -Raw } else { '' }
  $old = [regex]::Replace($old, '(?s)// >>> squint.*?// <<< squint[^\r\n]*\r?\n?', '')
  $block = (Get-Content (Join-Path $Root 'skin\user.js') -Raw).Replace('@@START@@', $startUrl)
  $new = $old + "// >>> squint`r`n" + $block + "`r`n// <<< squint`r`n"
  # comfort mode (config.json "comfortMode"): history, logins and tabs kept, site data wiped on exit
  if ((Get-Config).comfortMode -ne $false) {
    $new += "// >>> squint-comfort`r`n" + (Get-Content (Join-Path $Root 'skin\comfort.js') -Raw) + "`r`n// <<< squint-comfort`r`n"
  }
  [IO.File]::WriteAllText($uj, $new, (New-Object Text.UTF8Encoding($false)))
  return $true
}
