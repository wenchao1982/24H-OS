# 24H-OS：在 Windows 上构建随包运行时（build-runtime.sh 的 PowerShell 版）
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-runtime.ps1 -Ref main
#
# 为什么不用 .sh：Windows 没有 bash（除非装了 Git Bash）。这个版本只用 PowerShell 5.1 自带能力
# （Invoke-WebRequest + tar.exe，Win10 1803 起系统自带 tar）。
#
# 关键约束：Hermes 的 setup.py 拒绝构建 wheel/sdist，所以运行时 = 依赖装进 venv + 核心源码树一起放。
#
# 产物（**必须在目标平台上构建**，Linux 上建的 venv 拿到 Windows 用不了）：
#   runtime\venv\        只装依赖的虚拟环境
#   runtime\core\        核心源码树
#   runtime\.24h-os-runtime.json
#
# 注意：本脚本尚未在 Windows 上实测过（写它时手上没有 Windows 环境）——
#       第一次跑如果报错，把输出发我，我按报错改。

param(
  [string]$Ref = "main",
  [string]$Mirror = "https://mirrors.aliyun.com/pypi/simple/",
  [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Runtime = Join-Path $RepoRoot "runtime"
$Cache = Join-Path $env:TEMP "24h-os-runtime"
$SafeRef = $Ref -replace "[/:]", "_"
$Tgz = Join-Path $Cache "hermes-agent-$SafeRef.tgz"
$Src = Join-Path $Cache "src-$SafeRef"

Write-Host "==> 构建核心运行时 (Windows)"
Write-Host "    ref=$Ref  产物=$Runtime"

# ── 1. 找 python（3.11–3.13） ────────────────────────────────────────────────
function Resolve-Python([string]$explicit) {
  $cands = @()
  if ($explicit) { $cands += $explicit }
  $cands += @("py -3.12", "py -3.11", "python", "python3")
  foreach ($c in $cands) {
    $parts = $c.Split(" ")
    $bin = $parts[0]
    $args = @()
    if ($parts.Count -gt 1) { $args = $parts[1..($parts.Count - 1)] }
    try {
      $ver = & $bin @args -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
      if ($LASTEXITCODE -eq 0 -and $ver -match "^(3\.11|3\.12|3\.13)$") {
        return @{ Bin = $bin; Pre = $args; Ver = $ver }
      }
    } catch { }
  }
  return $null
}

$pyInfo = Resolve-Python $Python
if (-not $pyInfo) {
  Write-Error "找不到 Python 3.11–3.13。装一个：winget install Python.Python.3.12，或用 -Python 指定路径。"
}
Write-Host "    python $($pyInfo.Ver) ($($pyInfo.Bin) $($pyInfo.Pre -join ' '))"

function Invoke-Py([string[]]$PyArgs) {
  $all = @()
  $all += $pyInfo.Pre
  $all += $PyArgs
  & $pyInfo.Bin @all
  if ($LASTEXITCODE -ne 0) { throw "python 命令失败：$($all -join ' ')" }
}

# ── 2. 取源码（codeload，不需要 git 访问 github.com） ─────────────────────────
New-Item -ItemType Directory -Force -Path $Cache | Out-Null
if (-not (Test-Path (Join-Path $Src "pyproject.toml"))) {
  if (-not (Test-Path $Tgz)) {
    $url = "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/$Ref"
    Write-Host "==> 下载 $url"
    Invoke-WebRequest -Uri $url -OutFile $Tgz -TimeoutSec 600
  }
  Write-Host "==> 解压到 $Src"
  if (Test-Path $Src) { Remove-Item -Recurse -Force $Src }
  New-Item -ItemType Directory -Force -Path $Src | Out-Null
  # Win10 1803+ 自带 tar.exe
  tar -xzf $Tgz -C $Src --strip-components=1
  if ($LASTEXITCODE -ne 0) { throw "解压失败：确认系统有 tar.exe（Win10 1803+）" }
}

$coreVer = (Select-String -Path (Join-Path $Src "pyproject.toml") -Pattern '^version\s*=\s*"([^"]+)"' |
            Select-Object -First 1).Matches.Groups[1].Value
Write-Host "    核心版本: $coreVer"

# ── 3. 拷贝源码树（去掉 tests/website 等，省体积） ───────────────────────────
Write-Host "==> 拷贝源码树 → runtime\core"
if (Test-Path $Runtime) { Remove-Item -Recurse -Force $Runtime }
$coreDir = Join-Path $Runtime "core"
New-Item -ItemType Directory -Force -Path $coreDir | Out-Null
$excludeDirs = @("tests", "website", ".git", "node_modules", "__pycache__", ".github", "contributors")
Get-ChildItem -Path $Src -Force | Where-Object { $excludeDirs -notcontains $_.Name } | ForEach-Object {
  Copy-Item -Recurse -Force $_.FullName -Destination $coreDir
}

# ── 4. 解析依赖（pyproject 的 [project].dependencies） ───────────────────────
Write-Host "==> 解析依赖清单"
$raw = Get-Content (Join-Path $coreDir "pyproject.toml") -Raw
$block = [regex]::Match($raw, '(?ms)^dependencies\s*=\s*\[(.*?)^\]').Groups[1].Value
$deps = New-Object System.Collections.Generic.List[string]
foreach ($line in ($block -split "`n")) {
  $code = ($line -split '#', 2)[0]
  foreach ($mm in [regex]::Matches($code, '"([^"]+)"')) {
    $item = $mm.Groups[1].Value
    if ($item -match '^[A-Za-z0-9_.\-]+(\[[^\]]*\])?\s*(==|>=|<=|~=|>|<|!=)') { $deps.Add($item) }
  }
}
$depsFile = Join-Path $Runtime "deps.txt"
$deps | Set-Content -Encoding UTF8 $depsFile
Write-Host "    $($deps.Count) 个直接依赖"

# ── 5. venv + 装依赖 ────────────────────────────────────────────────────────
$venv = Join-Path $Runtime "venv"
Write-Host "==> 建 venv 并安装依赖（最慢的一步，几分钟）"
Invoke-Py @("-m", "venv", $venv)
$venvPy = Join-Path $venv "Scripts\python.exe"
& $venvPy -m pip install -q --upgrade pip -i $Mirror
if ($LASTEXITCODE -ne 0) { throw "pip 升级失败" }
& $venvPy -m pip install -q -r $depsFile -i $Mirror
if ($LASTEXITCODE -ne 0) { throw "依赖安装失败" }

# ── 6. 冒烟：从源码树把核心启动起来 ─────────────────────────────────────────
Write-Host "==> 冒烟：用 PYTHONPATH 指向源码树启动核心"
$tmpHome = Join-Path $env:TEMP ("24h-os-smoke-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmpHome | Out-Null
$outLog = Join-Path $env:TEMP "24h-os-core-out.log"
$errLog = Join-Path $env:TEMP "24h-os-core-err.log"
$env:PYTHONPATH = $coreDir
$env:HERMES_HOME = $tmpHome
$proc = Start-Process -FilePath $venvPy `
  -ArgumentList @("-m", "hermes_cli.main", "serve", "--host", "127.0.0.1", "--port", "0") `
  -WorkingDirectory $coreDir -PassThru -NoNewWindow `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 500
  $text = ""
  if (Test-Path $outLog) { $text += (Get-Content $outLog -Raw -ErrorAction SilentlyContinue) }
  if (Test-Path $errLog) { $text += (Get-Content $errLog -Raw -ErrorAction SilentlyContinue) }
  if ($text -match "HERMES_BACKEND_READY port=(\d+)") { $ready = $true; $port = $Matches[1]; break }
  if ($proc.HasExited) { break }
}
if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }

if (-not $ready) {
  Write-Host "--- 核心输出 ---"
  if (Test-Path $outLog) { Get-Content $outLog -Tail 30 }
  if (Test-Path $errLog) { Get-Content $errLog -Tail 30 }
  Write-Error "核心没能起来（见上面输出）"
}
Write-Host "    核心就绪，端口 $port"

# ── 7. 元数据 ───────────────────────────────────────────────────────────────
$sizeMB = [math]::Round(((Get-ChildItem $Runtime -Recurse -Force | Measure-Object -Property Length -Sum).Sum / 1MB), 0)
$meta = [ordered]@{
  schema       = 1
  coreRef      = $Ref
  coreVersion  = $coreVer
  builtAt      = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  python       = $pyInfo.Ver
  pipMirror    = $Mirror
  layout       = "venv+core-source"
  platform     = "win32"
} | ConvertTo-Json -Compress
$meta | Set-Content -Encoding UTF8 (Join-Path $Runtime ".24h-os-runtime.json")

Write-Host "==> 完成：$Runtime（约 $sizeMB MB）"
Write-Host ""
Write-Host "下一步："
Write-Host "  npm run smoke    # 壳会自动发现 runtime\ 并跑端到端自检"
Write-Host "  npm run dev      # 起界面"
