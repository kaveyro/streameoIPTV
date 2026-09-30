<#
.SYNOPSIS
  Downloads the playback binaries a Windows build bundles (mpv.exe, ffmpeg.exe,
  yt-dlp.exe) into src-tauri/deps.

.DESCRIPTION
  Fixed versions from their official GitHub releases, each checked against the
  SHA256 digest GitHub publishes for the release asset. Bump a version by
  updating its URL and digest together:

    gh api repos/<owner>/<repo>/releases/tags/<tag> --jq '.assets[] | {name, digest}'

  Used by the release workflow and for local builds. Existing files are only
  replaced with -Force.
#>
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$deps = Join-Path $PSScriptRoot "..\src-tauri\deps"
$work = Join-Path ([System.IO.Path]::GetTempPath()) "streameo-deps-$PID"

$downloads = @(
    @{
        Name   = "yt-dlp.exe"
        Url    = "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe"
        Sha256 = "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a"
        Inner  = $null
    },
    @{
        Name   = "ffmpeg.exe"
        Url    = "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip"
        Sha256 = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba"
        Inner  = "ffmpeg.exe"
    },
    @{
        Name   = "mpv.exe"
        Url    = "https://github.com/zhongfly/mpv-winbuild/releases/download/2026-09-30-3186d369f9/mpv-x86_64-20260930-git-3186d369f9.7z"
        Sha256 = "0abb26323a109b043697953f6a7b20471704ad1fcd75620fed5ffff67d888145"
        Inner  = "mpv.exe"
    }
)

function Expand-Download([string]$archive, [string]$target) {
    New-Item -ItemType Directory -Force $target | Out-Null
    if ($archive.EndsWith(".zip")) {
        Expand-Archive -LiteralPath $archive -DestinationPath $target -Force
        return
    }
    $sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
    if ($sevenZip) {
        & $sevenZip.Source x $archive "-o$target" -y | Out-Null
    } else {
        # Windows' bsdtar reads 7z archives too.
        tar -xf $archive -C $target
    }
    if ($LASTEXITCODE -ne 0) { throw "could not unpack $archive" }
}

New-Item -ItemType Directory -Force $deps | Out-Null
New-Item -ItemType Directory -Force $work | Out-Null
try {
    foreach ($d in $downloads) {
        $dest = Join-Path $deps $d.Name
        if ((Test-Path $dest) -and -not $Force) {
            Write-Host "$($d.Name): already there (use -Force to replace)"
            continue
        }
        $file = Join-Path $work ([System.IO.Path]::GetFileName($d.Url))
        Write-Host "$($d.Name): downloading $($d.Url)"
        Invoke-WebRequest -Uri $d.Url -OutFile $file -UseBasicParsing
        $hash = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLowerInvariant()
        if ($hash -ne $d.Sha256) {
            throw "$($d.Name): SHA256 mismatch (expected $($d.Sha256), got $hash)"
        }
        if ($d.Inner) {
            $unpacked = Join-Path $work ($d.Name + "-unpacked")
            Expand-Download $file $unpacked
            $found = Get-ChildItem -Path $unpacked -Recurse -Filter $d.Inner | Select-Object -First 1
            if (-not $found) { throw "$($d.Inner) not found in $($d.Url)" }
            Copy-Item $found.FullName $dest -Force
        } else {
            Copy-Item $file $dest -Force
        }
        Write-Host "$($d.Name): ok"
    }
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
