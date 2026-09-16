<#
  写运行时清单（runtime\.24h-os-runtime.json）—— 被 build-runtime.ps1 调用。
  字段含义见 scripts/write-runtime-manifest.sh 的注释；两边保持一致。

  用法：powershell -ExecutionPolicy Bypass -File scripts\write-runtime-manifest.ps1 `
            -Runtime <目录> -Ref main -CoreVersion 0.21.3 -PythonVersion 3.12
#>
param(
  [Parameter(Mandatory = $true)][string]$Runtime,
  [string]$Ref = "main",
  [string]$CoreVersion = "unknown",
  [string]$PythonVersion = "unknown",
  [string]$Mirror = ""
)

$ErrorActionPreference = "Stop"

# 上游 commit：能连 api.github.com 就记下来，连不上就留空（不阻塞构建）
$coreCommit = ""
try {
  $resp = Invoke-RestMethod -Uri ("https://api.github.com/repos/NousResearch/hermes-agent/commits/" + $Ref) `
    -Headers @{ "User-Agent" = "24h-os-build" } -TimeoutSec 20
  if ($resp.sha) { $coreCommit = $resp.sha }
} catch {
  Write-Host "    （取上游 commit 失败，清单里留空：$($_.Exception.Message)）"
}

# 源码树指纹：按 "相对路径 大小" 排序后取 sha256
$treeSha = ""
$coreDir = Join-Path $Runtime "core"
if (Test-Path $coreDir) {
  $lines = @()
  Get-ChildItem $coreDir -Recurse -Force -File | ForEach-Object {
    $rel = $_.FullName.Substring($coreDir.Length).TrimStart("\").Replace("\", "/")
    $lines += ("{0} {1}" -f $rel, $_.Length)
  }
  $sorted = ($lines | Sort-Object) -join "`n"
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sorted))
  $treeSha = ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLower()
}

$meta = [ordered]@{
  schema        = 1
  coreRef       = $Ref
  coreVersion   = $CoreVersion
  coreCommit    = $coreCommit
  coreTreeSha256 = $treeSha
  builtAt       = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  python        = $PythonVersion
  platform      = "win32"
  pipMirror     = $Mirror
  layout        = "venv+core-source"
}

$meta | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 (Join-Path $Runtime ".24h-os-runtime.json")
$shortCommit = if ($coreCommit.Length -ge 8) { $coreCommit.Substring(0, 8) } else { $coreCommit }
$shortTree = if ($treeSha.Length -ge 8) { $treeSha.Substring(0, 8) } else { $treeSha }
Write-Host ("    清单: coreVersion={0} commit={1} tree={2} platform=win32" -f $CoreVersion, $shortCommit, $shortTree)
