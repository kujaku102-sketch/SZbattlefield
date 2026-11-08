# Runs a command with the Gemini key in the environment of that command only (as FORGE_LLM_API_KEY), read from the user's Windows environment variable GEMINI_API_KEY.
#
#   powershell -NoProfile -File scripts/with-gemini-key.ps1 -Configs cfg-a.json,cfg-b.json -- node src/llm-compare.mjs --config cfg-a.json ...
#
# - It runs only when every settings file named in -Configs says "provider": "gemini"; nothing else gets the key. It is never picked up automatically.
# - The value is not printed, not written, not put in an argument; it goes into the environment of the child process and is dropped when the command ends.
param(
  [Parameter(Mandatory = $true)][string[]]$Configs,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Command
)
$ErrorActionPreference = 'Stop'
foreach ($file in $Configs) {
  $settings = Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json
  if ($settings.provider -ne 'gemini') { Write-Error "$file is not provider gemini: the key is not given"; exit 2 }
}
$Command = @($Command | Where-Object { $_ -ne '--' })
if ($Command.Count -eq 0) { Write-Error 'no command'; exit 2 }
$value = [Environment]::GetEnvironmentVariable('GEMINI_API_KEY', 'User')
if ([string]::IsNullOrEmpty($value)) { Write-Error 'GEMINI_API_KEY is not set in the user environment'; exit 3 }
$env:FORGE_LLM_API_KEY = $value
$value = $null
try {
  $rest = if ($Command.Count -gt 1) { $Command[1..($Command.Count - 1)] } else { @() }
  & $Command[0] @rest
  exit $LASTEXITCODE
} finally {
  Remove-Item Env:FORGE_LLM_API_KEY -ErrorAction SilentlyContinue
}
