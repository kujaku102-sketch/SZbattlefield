# Runs a command line with the Gemini key in the environment of that command only (as FORGE_LLM_API_KEY), read from the user's Windows environment variable GEMINI_API_KEY.
#
#   powershell -NoProfile -File scripts/with-gemini-key.ps1 -Configs cfg-a.json,cfg-b.json -Run "node src/llm-compare.mjs --config cfg-a.json --config cfg-b.json ..."
#
# - It runs only when every settings file named in -Configs says "provider": "gemini"; nothing else gets the key. It is never picked up automatically.
# - The value is not printed, not written, not put in an argument; it goes into the environment of the command and is dropped when the command ends.
param(
  [Parameter(Mandatory = $true)][string[]]$Configs,
  [Parameter(Mandatory = $true)][string]$Run
)
$ErrorActionPreference = 'Stop'
foreach ($file in $Configs) {
  $settings = Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json
  if ($settings.provider -ne 'gemini') { Write-Error "$file is not provider gemini: the key is not given"; exit 2 }
}
$value = [Environment]::GetEnvironmentVariable('GEMINI_API_KEY', 'User')
if ([string]::IsNullOrEmpty($value)) { Write-Error 'GEMINI_API_KEY is not set in the user environment'; exit 3 }
$env:FORGE_LLM_API_KEY = $value
$value = $null
try {
  Invoke-Expression $Run
  exit $LASTEXITCODE
} finally {
  Remove-Item Env:FORGE_LLM_API_KEY -ErrorAction SilentlyContinue
}
