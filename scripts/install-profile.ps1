<#
.SYNOPSIS
  把 dsh-second-sight 重新打包并装进 DSH profile，然后自检。

.DESCRIPTION
  这台机器上 pnpm 建不了符号链接（link:/junction 都报 Access is denied，缺
  SeCreateSymbolicLinkPrivilege），所以 profile 用的是 hoisted nodeLinker + tarball：
  每次改完代码要重新 pack 一次，宿主才能看到新版本。

  等价于手写：
    npm pack --pack-destination dist
    dsh plugin --profile web add .\dist\dsh-second-sight-<version>.tgz
    node scripts/verify-install.mjs
  装完还要手动重启 dsh web 才会加载。

.PARAMETER Profile
  profile 名，默认 web。

.PARAMETER SkipTests
  跳过 npm test（只想快速重装时用）。
#>
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    if (-not $SkipTests) {
        Write-Host '» npm test' -ForegroundColor Cyan
        & npm test
        if ($LASTEXITCODE -ne 0) { throw "测试未通过（exit $LASTEXITCODE），已中止安装" }
    }

    $version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    Write-Host "» 打包 dsh-second-sight@$version" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force (Join-Path $root 'dist') | Out-Null
    $tarball = Join-Path $root "dist\dsh-second-sight-$version.tgz"
    if (Test-Path $tarball) { Remove-Item $tarball -Force }
    & npm pack --pack-destination (Join-Path $root 'dist') --silent | Out-Null
    if (-not (Test-Path $tarball)) { throw "打包失败：$tarball 不存在" }

    Write-Host "» 装进 profile '$Profile'" -ForegroundColor Cyan
    & dsh plugin --profile $Profile add $tarball
    if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（exit $LASTEXITCODE）" }

    Write-Host '» 自检' -ForegroundColor Cyan
    & node (Join-Path $root 'scripts\verify-install.mjs')
    if ($LASTEXITCODE -ne 0) { throw "自检未通过（exit $LASTEXITCODE）" }

    Write-Host ''
    Write-Host '装好了。重启 dsh web 后才会加载：' -ForegroundColor Green
    Write-Host '  C:\Users\win10\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\dsh-web-lan.vbs'
    Write-Host ''
    Write-Host "bundle 顺序在 $env:USERPROFILE\.dsh\profiles\$Profile\package.json 的 dsh.profile.bundles 里（pnpm 已自动追加）"
}
finally {
    Pop-Location
}
