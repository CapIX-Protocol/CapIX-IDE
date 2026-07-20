# ide-install.ps1 — one-line CapixIDE installer for Windows.
#
#   irm https://raw.githubusercontent.com/CapIX-Protocol/CapIX-IDE/main/scripts/ide-install.ps1 | iex
#
# Resolves the latest GitHub release, downloads the unsigned Windows archive,
# verifies the published SHA-256 checksum, installs, and launches CapixIDE.
$ErrorActionPreference = 'Stop'
$Repo = 'CapIX-Protocol/CapIX-IDE'

function Log($Msg) { Write-Host "==> $Msg" -ForegroundColor Cyan }

Log 'Resolving latest CapixIDE release…'
$Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'capix-ide-installer' }
$Tag = $Release.tag_name
if (-not $Tag) { throw 'could not resolve the latest release tag' }

$Name = "CapixIDE-$Tag-win32-x64-unsigned"
$Archive = "$Name.zip"
$Base = "https://github.com/$Repo/releases/download/$Tag"
$Tmp = Join-Path $env:TEMP ("capix-ide-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp | Out-Null

try {
    $ZipPath = Join-Path $Tmp $Archive
    Log "Downloading $Archive ($Tag, win32/x64)"
    Invoke-WebRequest -Uri "$Base/$Archive" -OutFile $ZipPath
    $ShaPath = Join-Path $Tmp "$Archive.sha256"
    Invoke-WebRequest -Uri "$Base/$Archive.sha256" -OutFile $ShaPath

    Log 'Verifying SHA-256 checksum'
    $Expected = ((Get-Content $ShaPath -Raw).Trim() -split '\s+')[0].ToLower()
    $Actual = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLower()
    if ($Actual -ne $Expected) { throw "checksum verification failed (expected $Expected, got $Actual)" }

    $Dest = Join-Path $env:LOCALAPPDATA 'Programs\CapixIDE'
    Log "Installing to $Dest"
    Expand-Archive -Path $ZipPath -DestinationPath $Tmp -Force
    $Src = Get-ChildItem -Path $Tmp -Directory -Filter 'VSCode-win32-*' | Select-Object -First 1
    if (-not $Src) { throw 'archive did not contain the expected VSCode-win32-x64 tree' }
    if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    Copy-Item -Path (Join-Path $Src.FullName '*') -Destination $Dest -Recurse -Force

    $Exe = Get-ChildItem -Path $Dest -Filter 'CapixIDE.exe' -Recurse -File | Select-Object -First 1
    if (-not $Exe) { throw 'installed CapixIDE.exe not found' }

    $ShortcutPath = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\CapixIDE.lnk'
    $Wsh = New-Object -ComObject WScript.Shell
    $Shortcut = $Wsh.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = $Exe.FullName
    $Shortcut.WorkingDirectory = $Dest
    $Shortcut.Description = 'CapixIDE — the AI IDE for the Capix protocol'
    $Shortcut.Save()

    Log 'Launching CapixIDE'
    Start-Process $Exe.FullName
    Log "CapixIDE $Tag installed."
}
finally {
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
