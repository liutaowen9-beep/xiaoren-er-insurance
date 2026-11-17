$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$revision = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
$model = 'Xenova/multilingual-e5-small'
$projectRoot = Split-Path -Parent $PSScriptRoot
$cacheRoot = Join-Path $projectRoot 'tmp/rag-tests/management/models'
$modelRoot = Join-Path $cacheRoot $model
$metadata = Invoke-RestMethod "https://huggingface.co/api/models/$model/revision/$revision`?blobs=true" -TimeoutSec 60
$files = @('config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx')
foreach ($file in $files) {
  $entry = $metadata.siblings | Where-Object { $_.rfilename -eq $file }
  if (-not $entry) { throw "Missing official model file: $file" }
  $target = Join-Path $modelRoot $file
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  $valid = (Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).Length -eq $entry.size)
  if ($valid -and $entry.lfs.sha256) { $valid = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $entry.lfs.sha256 }
  if ($valid) { Write-Output "Cached: $file"; continue }
  Write-Output "Downloading official model: $file ($($entry.size) bytes)"
  $temporary = "$target.download"
  Invoke-WebRequest "https://huggingface.co/$model/resolve/$revision/$file" -OutFile $temporary -TimeoutSec 600
  if ((Get-Item -LiteralPath $temporary).Length -ne $entry.size) { throw "Size check failed: $file" }
  if ($entry.lfs.sha256 -and (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $entry.lfs.sha256) { throw "SHA256 check failed: $file" }
  Move-Item -LiteralPath $temporary -Destination $target -Force
}
Write-Output 'Embedding files ready. Restart the server or retry indexing.'
