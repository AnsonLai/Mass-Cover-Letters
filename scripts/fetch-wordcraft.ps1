[CmdletBinding()]
param(
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This script intentionally uses the released web bundle.  Do not replace the tag
# without also updating the plan and re-evaluating WordCraft against our documents.
$Repository = 'storytold/wordcraft'
$ReleaseTag = 'v0.6.1'
$AssetName = 'wordcraft-web-0.6.1.zip'

$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$vendorRoot = Join-Path $workspaceRoot 'vendor'
$destination = Join-Path $vendorRoot 'wordcraft'

function Assert-WorkspacePath {
    param([Parameter(Mandatory)][string] $Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $workspacePrefix = $workspaceRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside the workspace: $fullPath"
    }
    return $fullPath
}

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

function Get-TotalBytes {
    param([object[]] $Files)

    if ($Files.Count -eq 0) {
        return [int64]0
    }
    return [int64](($Files | Measure-Object -Property Length -Sum).Sum)
}

$destination = Assert-WorkspacePath $destination
$vendorRoot = Assert-WorkspacePath $vendorRoot

if ((Test-Path -LiteralPath $destination) -and -not $Force) {
    throw "Destination already exists: $destination. Re-run with -Force to replace this generated vendor bundle."
}

$tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = Assert-ChildPath -Path (Join-Path $tempParent ("wordcraft-fetch-" + [guid]::NewGuid().ToString('N'))) -Parent $tempParent -Description 'temporary fetch directory'
$archivePath = Join-Path $tempRoot $AssetName
$stagingPath = Join-Path $tempRoot 'extracted'
$backupPath = Assert-ChildPath -Path (Join-Path $vendorRoot ("wordcraft.backup-" + [guid]::NewGuid().ToString('N'))) -Parent $vendorRoot -Description 'WordCraft backup directory'

try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null

    $headers = @{ 'User-Agent' = 'Mass-Cover-Letters-WordCraft-Fetcher' }
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/tags/$ReleaseTag" -Headers $headers
    $asset = @($release.assets | Where-Object { $_.name -eq $AssetName })
    if ($asset.Count -ne 1) {
        throw "Expected exactly one '$AssetName' asset on $Repository $ReleaseTag; found $($asset.Count)."
    }
    if ($asset[0].size -le 0 -or [string]::IsNullOrWhiteSpace($asset[0].browser_download_url)) {
        throw "GitHub release metadata for '$AssetName' is incomplete."
    }
    $targetCommit = [string]$release.target_commitish
    if ([string]::IsNullOrWhiteSpace($targetCommit)) {
        $targetCommit = '(not supplied by GitHub)'
    }
    $releaseDigestProperty = $asset[0].PSObject.Properties['digest']
    $releaseDigest = if ($null -eq $releaseDigestProperty) { '' } else { [string]$releaseDigestProperty.Value }
    Write-Host "Release tag target from GitHub metadata: $targetCommit"
    if ([string]::IsNullOrWhiteSpace($releaseDigest)) {
        Write-Host 'GitHub release metadata does not provide an asset digest.'
    }
    else {
        Write-Host "GitHub release asset digest: $releaseDigest"
    }

    Write-Host "Downloading $Repository $ReleaseTag ($AssetName; $($asset[0].size) bytes)..."
    Invoke-WebRequest -Uri $asset[0].browser_download_url -Headers $headers -OutFile $archivePath
    $downloadedSize = (Get-Item -LiteralPath $archivePath).Length
    if ($downloadedSize -ne [int64]$asset[0].size) {
        throw "Archive size mismatch: GitHub metadata reports $($asset[0].size) bytes, downloaded $downloadedSize bytes."
    }
    Write-Host "Archive size verified: $downloadedSize bytes."
    if ($releaseDigest -match '^sha256:([0-9a-fA-F]{64})$') {
        $actualDigest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        $expectedDigest = $Matches[1].ToLowerInvariant()
        if ($actualDigest -ne $expectedDigest) {
            throw "Archive SHA-256 mismatch: GitHub metadata reports $expectedDigest, downloaded $actualDigest."
        }
        Write-Host "Archive SHA-256 verified: $actualDigest"
    }
    elseif (-not [string]::IsNullOrWhiteSpace($releaseDigest)) {
        Write-Warning "Skipping unknown GitHub asset digest format: $releaseDigest"
    }

    New-Item -ItemType Directory -Path $stagingPath | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingPath

    # GitHub's release archive currently has one enclosing directory.  Accept
    # that layout, but install the directory which actually contains index.html.
    $indexCandidates = @(Get-ChildItem -LiteralPath $stagingPath -Recurse -File -Filter 'index.html')
    if ($indexCandidates.Count -ne 1) {
        throw "Archive validation failed: expected one index.html, found $($indexCandidates.Count)."
    }
    $indexPath = $indexCandidates[0].FullName
    $contentRoot = Get-VerifiedExistingChildPath -Path (Split-Path -Parent $indexPath) -Parent $stagingPath -Description 'extracted WordCraft content'
    $allFiles = @(Get-ChildItem -LiteralPath $contentRoot -Recurse -File)
    $hashedJs = @($allFiles | Where-Object { $_.Extension -eq '.js' -and $_.Name -match '[0-9a-f]{8,}' })
    $hashedWasm = @($allFiles | Where-Object { $_.Extension -eq '.wasm' -and $_.Name -match '[0-9a-f]{8,}' })
    if ($hashedJs.Count -eq 0 -or $hashedWasm.Count -eq 0) {
        throw "Archive validation failed: expected hashed JavaScript and WASM assets (found $($hashedJs.Count) JS, $($hashedWasm.Count) WASM)."
    }
    $indexHtml = Get-Content -LiteralPath $indexPath -Raw
    foreach ($assetFile in $hashedJs) {
        if ($indexHtml -notmatch [regex]::Escape($assetFile.Name)) {
            throw "Archive validation failed: index.html does not reference $($assetFile.Name)."
        }
    }

    $extractedSize = Get-TotalBytes $allFiles
    $fontSize = Get-TotalBytes @($allFiles | Where-Object { $_.Extension -match '^\.(ttf|otf|woff2?|eot)$' })
    $wasmSize = Get-TotalBytes @($allFiles | Where-Object { $_.Extension -eq '.wasm' })
    $jsSize = Get-TotalBytes @($allFiles | Where-Object { $_.Extension -eq '.js' })
    Write-Host ("Extracted size: {0:N0} bytes ({1:N2} MiB)" -f $extractedSize, ($extractedSize / 1MB))
    Write-Host ("Breakdown: fonts {0:N0} bytes; WASM {1:N0} bytes; JavaScript {2:N0} bytes." -f $fontSize, $wasmSize, $jsSize)
    Write-Host "Validated index.html, $($hashedJs.Count) hashed JS asset(s), and $($hashedWasm.Count) hashed WASM asset(s)."

    New-Item -ItemType Directory -Path $vendorRoot -Force | Out-Null
    if (Test-Path -LiteralPath $destination) {
        $verifiedDestination = Get-VerifiedExistingChildPath -Path $destination -Parent $vendorRoot -Description 'existing WordCraft destination'
        $verifiedBackupPath = Assert-ChildPath -Path $backupPath -Parent $vendorRoot -Description 'WordCraft backup directory'
        Move-Item -LiteralPath $verifiedDestination -Destination $verifiedBackupPath
    }
    try {
        $verifiedContentRoot = Get-VerifiedExistingChildPath -Path $contentRoot -Parent $stagingPath -Description 'extracted WordCraft content'
        $verifiedDestination = Assert-ChildPath -Path $destination -Parent $vendorRoot -Description 'WordCraft destination'
        Move-Item -LiteralPath $verifiedContentRoot -Destination $verifiedDestination
        if (Test-Path -LiteralPath $backupPath) {
            Remove-VerifiedChildDirectory -Path $backupPath -Parent $vendorRoot -Description 'WordCraft backup directory'
        }
    }
    catch {
        if ((-not (Test-Path -LiteralPath $destination)) -and (Test-Path -LiteralPath $backupPath)) {
            $verifiedBackupPath = Get-VerifiedExistingChildPath -Path $backupPath -Parent $vendorRoot -Description 'WordCraft backup directory'
            $verifiedDestination = Assert-ChildPath -Path $destination -Parent $vendorRoot -Description 'WordCraft destination'
            Move-Item -LiteralPath $verifiedBackupPath -Destination $verifiedDestination
        }
        throw
    }

    Write-Host "Installed WordCraft $ReleaseTag at $destination"
}
finally {
    Remove-VerifiedChildDirectory -Path $tempRoot -Parent $tempParent -Description 'temporary fetch directory'
}
