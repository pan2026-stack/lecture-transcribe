# 交付前检查：代码 + 视觉
# 用法：.\检查.ps1            只跑代码检查
#       .\检查.ps1 -Visual    代码 + 视觉（需要本地服务在跑）
param(
  [switch]$Visual,
  [string]$Url = 'http://127.0.0.1:8787/?qa=1',
  [string]$OutDir = 'shots'
)

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$eslint = Join-Path $PSScriptRoot 'tools\node_modules\eslint\bin\eslint.js'
$ruff = Join-Path $PSScriptRoot 'tools\ruffpy\bin\ruff.exe'
$qa = Join-Path $PSScriptRoot 'tools\qa.js'
$fail = 0

Write-Host '=== JS：ESLint ===' -ForegroundColor Cyan
if (Test-Path $eslint) {
  node $eslint --config tools\eslint.config.mjs app.js
  if ($LASTEXITCODE -ne 0) { $fail = 1 }
} else {
  Write-Host '没装 eslint：npm.cmd --prefix tools install eslint @eslint/js' -ForegroundColor Yellow
  $fail = 1
}

Write-Host "`n=== Python：Ruff ===" -ForegroundColor Cyan
if (Test-Path $ruff) {
  & $ruff check server.py make-portable.py --select E,F,W --ignore E501 --output-format concise
  if ($LASTEXITCODE -ne 0) { $fail = 1 }
} else {
  Write-Host '没装 ruff：python -m pip install --target tools/ruffpy ruff' -ForegroundColor Yellow
  $fail = 1
}

if ($Visual) {
  Write-Host "`n=== 视觉：真实渲染 + 几何/对比度 ===" -ForegroundColor Cyan
  if (Test-Path $qa) {
    node $qa $Url $OutDir
    if ($LASTEXITCODE -ne 0) { $fail = 1 }
  } else {
    Write-Host '缺少 tools\qa.js' -ForegroundColor Yellow
    $fail = 1
  }
}

Write-Host ''
if ($fail -eq 0) {
  Write-Host '全部通过' -ForegroundColor Green
} else {
  Write-Host '有问题，看上面的输出' -ForegroundColor Red
}
exit $fail
