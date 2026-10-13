[CmdletBinding()]
param(
    [switch] $Force,
    [switch] $SkipToolchainInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This source revision is the target recorded by GitHub's v0.6.1 release metadata.
$RepositoryUrl = 'https://github.com/storytold/wordcraft.git'
$Commit = '7dfa6b0ee2aeeafec004c51fdd2ab9a697da3cc4'
$PatchName = 'compact-startup.patch'
$TrunkVersion = '0.21.14'
# The workspace minimum is 1.90, but its release lockfile resolves packages
# (notably egui 0.36.2) that require Rust 1.95 or later.
$RustToolchain = 'stable-x86_64-pc-windows-msvc'

$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$vendorRoot = Join-Path $workspaceRoot 'vendor'
$destination = Join-Path $vendorRoot 'wordcraft'
$patchPath = Join-Path $vendorRoot (Join-Path 'wordcraft-patches' $PatchName)
$toolchainRoot = Join-Path $workspaceRoot '.wordcraft-toolchain'
$rustupHome = Join-Path $toolchainRoot 'rustup'
$cargoHome = Join-Path $toolchainRoot 'cargo'
$toolsRoot = Join-Path $toolchainRoot 'tools'
$cargoTargetDir = Join-Path $toolchainRoot 'target'
$cargoExe = Join-Path $cargoHome 'bin\cargo.exe'
$rustupExe = Join-Path $cargoHome 'bin\rustup.exe'
$trunkExe = Join-Path $toolsRoot 'bin\trunk.exe'

function Assert-ChildPath {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $Parent,
        [Parameter(Mandatory)][string] $Description
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $parentPrefix = $fullParent + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($parentPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to use $Description outside '$fullParent': $fullPath"
    }
    return $fullPath
}

function Get-VerifiedExistingChildPath {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $Parent,
        [Parameter(Mandatory)][string] $Description
    )

    $fullPath = Assert-ChildPath -Path $Path -Parent $Parent -Description $Description
    $resolvedPath = (Resolve-Path -LiteralPath $fullPath).ProviderPath
    return Assert-ChildPath -Path $resolvedPath -Parent $Parent -Description $Description
}

function Remove-VerifiedChildDirectory {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $Parent,
        [Parameter(Mandatory)][string] $Description
    )

    if (Test-Path -LiteralPath $Path) {
        $verifiedPath = Get-VerifiedExistingChildPath -Path $Path -Parent $Parent -Description $Description
        Remove-Item -LiteralPath $verifiedPath -Recurse -Force
    }
}

function Invoke-Checked {
    param([Parameter(Mandatory)][string] $FilePath, [Parameter(ValueFromRemainingArguments = $true)][string[]] $Arguments)

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed ($LASTEXITCODE): $FilePath $($Arguments -join ' ')"
    }
}

function Install-PrebuiltTrunk {
    param(
        [Parameter(Mandatory)][string] $Version,
        [Parameter(Mandatory)][string] $Destination,
        [Parameter(Mandatory)][string] $TemporaryRoot
    )

    $headers = @{ 'User-Agent' = 'Mass-Cover-Letters-WordCraft-Build' }
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/trunk-rs/trunk/releases/tags/v$Version" -Headers $headers
    $asset = @($release.assets | Where-Object { $_.name -match '^trunk-x86_64-pc-windows-msvc.*\.zip$' })
    if ($asset.Count -ne 1) {
        throw "Expected one prebuilt Windows Trunk zip for v$Version; found $($asset.Count)."
    }
    $archivePath = Assert-ChildPath -Path (Join-Path $TemporaryRoot $asset[0].name) -Parent $TemporaryRoot -Description 'temporary Trunk archive'
    $extractPath = Assert-ChildPath -Path (Join-Path $TemporaryRoot 'trunk') -Parent $TemporaryRoot -Description 'temporary Trunk extraction'
    Write-Host "Downloading prebuilt Trunk v$Version..."
    Invoke-WebRequest -Uri $asset[0].browser_download_url -Headers $headers -OutFile $archivePath
    if ((Get-Item -LiteralPath $archivePath).Length -ne [int64]$asset[0].size) {
        throw 'Prebuilt Trunk archive size does not match GitHub release metadata.'
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath
    $candidates = @(Get-ChildItem -LiteralPath $extractPath -Recurse -File -Filter 'trunk.exe')
    if ($candidates.Count -ne 1) {
        throw "Expected one trunk.exe in the prebuilt archive; found $($candidates.Count)."
    }
    $source = Get-VerifiedExistingChildPath -Path $candidates[0].FullName -Parent $extractPath -Description 'prebuilt Trunk executable'
    $destinationParent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    $verifiedDestination = Assert-ChildPath -Path $Destination -Parent $toolsRoot -Description 'workspace-local Trunk executable'
    Copy-Item -LiteralPath $source -Destination $verifiedDestination -Force
}

function Get-VsDevCmd {
    $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
        throw 'Visual Studio Build Tools were not found; the Rust MSVC host needs its linker.'
    }
    $installRoot = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
    if ([string]::IsNullOrWhiteSpace($installRoot)) {
        throw 'Visual Studio C++ Build Tools were not found; the Rust MSVC host needs its linker.'
    }
    $devCmd = Join-Path $installRoot 'Common7\Tools\VsDevCmd.bat'
    if (-not (Test-Path -LiteralPath $devCmd -PathType Leaf)) {
        throw "Visual Studio developer command script is missing: $devCmd"
    }
    return $devCmd
}

$destination = Assert-ChildPath -Path $destination -Parent $vendorRoot -Description 'WordCraft destination'
$patchPath = Get-VerifiedExistingChildPath -Path $patchPath -Parent $vendorRoot -Description 'WordCraft startup patch'
$toolchainRoot = Assert-ChildPath -Path $toolchainRoot -Parent $workspaceRoot -Description 'workspace-local WordCraft toolchain'
$cargoTargetDir = Assert-ChildPath -Path $cargoTargetDir -Parent $toolchainRoot -Description 'workspace-local WordCraft Cargo target cache'
$tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = Assert-ChildPath -Path (Join-Path $tempParent ("wordcraft-build-" + [guid]::NewGuid().ToString('N'))) -Parent $tempParent -Description 'temporary WordCraft build directory'
$sourceRoot = Join-Path $tempRoot 'source'
$backupPath = Assert-ChildPath -Path (Join-Path $vendorRoot ("wordcraft.backup-" + [guid]::NewGuid().ToString('N'))) -Parent $vendorRoot -Description 'WordCraft backup directory'

if ((Test-Path -LiteralPath $destination) -and -not $Force) {
    throw "Destination already exists: $destination. Re-run with -Force to replace this generated vendor bundle."
}

try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null

    $env:RUSTUP_HOME = $rustupHome
    $env:CARGO_HOME = $cargoHome
    $env:RUSTUP_TOOLCHAIN = $RustToolchain
    New-Item -ItemType Directory -Path $cargoTargetDir -Force | Out-Null
    $env:CARGO_TARGET_DIR = $cargoTargetDir
    # Trunk 0.21 treats the conventional NO_COLOR=1 flag as a value for its
    # valueless --no-color switch.  Do not inherit it into the build process.
    $env:NO_COLOR = $null
    $env:PATH = "$(Join-Path $cargoHome 'bin');$(Join-Path $toolsRoot 'bin');$env:PATH"

    if (-not (Test-Path -LiteralPath $cargoExe)) {
        if ($SkipToolchainInstall) {
            throw "Workspace-local Rust is missing at $cargoExe. Re-run without -SkipToolchainInstall."
        }
        $rustupInstaller = Join-Path $tempRoot 'rustup-init.exe'
        Write-Host 'Installing the Rust stable toolchain into .wordcraft-toolchain...'
        Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile $rustupInstaller
        Invoke-Checked $rustupInstaller '-y' '--profile' 'minimal' '--default-toolchain' 'stable' '--no-modify-path'
    }
    if (-not (Test-Path -LiteralPath $rustupExe)) {
        throw "rustup was not installed at $rustupExe"
    }
    Invoke-Checked $rustupExe 'toolchain' 'install' $RustToolchain '--profile' 'minimal'
    Invoke-Checked $rustupExe 'target' 'add' 'wasm32-unknown-unknown' '--toolchain' $RustToolchain

    if (-not (Test-Path -LiteralPath $trunkExe)) {
        if ($SkipToolchainInstall) {
            throw "Workspace-local Trunk is missing at $trunkExe. Re-run without -SkipToolchainInstall."
        }
        Install-PrebuiltTrunk -Version $TrunkVersion -Destination $trunkExe -TemporaryRoot $tempRoot
    }

    $verifiedSourceRoot = Assert-ChildPath -Path $sourceRoot -Parent $tempRoot -Description 'temporary WordCraft source'
    Invoke-Checked 'git' 'init' $verifiedSourceRoot
    Push-Location $verifiedSourceRoot
    try {
        Invoke-Checked 'git' 'remote' 'add' 'origin' $RepositoryUrl
        Invoke-Checked 'git' 'fetch' '--depth' '1' 'origin' $Commit
        Invoke-Checked 'git' 'checkout' '--detach' 'FETCH_HEAD'
        $actualCommit = (& git rev-parse HEAD).Trim()
        if ($actualCommit -ne $Commit) {
            throw "Fetched WordCraft revision $actualCommit, expected $Commit."
        }
        Invoke-Checked 'git' 'apply' '--check' $patchPath
        Invoke-Checked 'git' 'apply' $patchPath
        $webAppRoot = Get-VerifiedExistingChildPath -Path (Join-Path $sourceRoot 'apps\wordcraft-web') -Parent $sourceRoot -Description 'WordCraft web application source'
        Push-Location $webAppRoot
        try {
            $vsDevCmd = Get-VsDevCmd
            # A .cmd wrapper keeps PowerShell's native-command quoting from
            # dropping the Trunk invocation after the VS environment setup.
            $buildCmd = Assert-ChildPath -Path (Join-Path $tempRoot 'build-wordcraft.cmd') -Parent $tempRoot -Description 'temporary WordCraft build command'
            @(
                '@echo off'
                ('call "{0}" -no_logo -arch=x64' -f $vsDevCmd)
                'if errorlevel 1 exit /b %errorlevel%'
                ('"{0}" build --release' -f $trunkExe)
                'exit /b %errorlevel%'
            ) | Set-Content -LiteralPath $buildCmd -Encoding ascii
            Write-Host 'Building the patched WebAssembly bundle...'
            Invoke-Checked 'cmd.exe' '/d' '/c' $buildCmd
            Write-Host 'Trunk completed; validating generated bundle...'
        }
        finally {
            Pop-Location
        }
    }
    finally {
        Pop-Location
    }

    $expectedOutput = Join-Path $sourceRoot 'dist\web'
    Write-Host "Validating expected build output at $expectedOutput"
    $buildOutput = Get-VerifiedExistingChildPath -Path $expectedOutput -Parent $sourceRoot -Description 'WordCraft web build output'
    $indexPath = Join-Path $buildOutput 'index.html'
    if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
        throw "Build validation failed: index.html is missing from $buildOutput"
    }
    $files = @(Get-ChildItem -LiteralPath $buildOutput -Recurse -File)
    if (@($files | Where-Object { $_.Extension -eq '.wasm' -and $_.Name -match '[0-9a-f]{8,}' }).Count -eq 0) {
        throw 'Build validation failed: no hashed WASM asset was produced.'
    }
    if (@($files | Where-Object { $_.Extension -eq '.js' -and $_.Name -match '[0-9a-f]{8,}' }).Count -eq 0) {
        throw 'Build validation failed: no hashed JavaScript asset was produced.'
    }
    [PSCustomObject]@{
        commit = $Commit
        patch = $PatchName
        embed = $true
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $buildOutput 'demo-build.json') -Encoding utf8

    foreach ($noticeName in @('LICENSE-APACHE', 'LICENSE-MIT', 'NOTICE', 'ATTRIBUTION.md')) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot $noticeName) -Destination (Join-Path $buildOutput $noticeName)
    }
    $fontLicenseOutput = Join-Path $buildOutput 'licenses'
    New-Item -ItemType Directory -Path $fontLicenseOutput -Force | Out-Null
    foreach ($fontNoticeName in @('OFL-SourceSans3.txt', 'OFL-SourceSerif4.txt', 'OFL-Inter.txt', 'OFL-JetBrainsMono.txt')) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot "assets/fonts/$fontNoticeName") -Destination (Join-Path $fontLicenseOutput $fontNoticeName)
    }

    New-Item -ItemType Directory -Path $vendorRoot -Force | Out-Null
    if (Test-Path -LiteralPath $destination) {
        $verifiedDestination = Get-VerifiedExistingChildPath -Path $destination -Parent $vendorRoot -Description 'existing WordCraft destination'
        $verifiedBackup = Assert-ChildPath -Path $backupPath -Parent $vendorRoot -Description 'WordCraft backup directory'
        Move-Item -LiteralPath $verifiedDestination -Destination $verifiedBackup
    }
    try {
        $verifiedOutput = Get-VerifiedExistingChildPath -Path $buildOutput -Parent $sourceRoot -Description 'WordCraft web build output'
        $verifiedDestination = Assert-ChildPath -Path $destination -Parent $vendorRoot -Description 'WordCraft destination'
        Move-Item -LiteralPath $verifiedOutput -Destination $verifiedDestination
        Remove-VerifiedChildDirectory -Path $backupPath -Parent $vendorRoot -Description 'WordCraft backup directory'
    }
    catch {
        if ((-not (Test-Path -LiteralPath $destination)) -and (Test-Path -LiteralPath $backupPath)) {
            $verifiedBackup = Get-VerifiedExistingChildPath -Path $backupPath -Parent $vendorRoot -Description 'WordCraft backup directory'
            $verifiedDestination = Assert-ChildPath -Path $destination -Parent $vendorRoot -Description 'WordCraft destination'
            Move-Item -LiteralPath $verifiedBackup -Destination $verifiedDestination
        }
        throw
    }
    Write-Host "Built WordCraft $Commit with $PatchName and installed it at $destination"
}
finally {
    Remove-VerifiedChildDirectory -Path $tempRoot -Parent $tempParent -Description 'temporary WordCraft build directory'
}
