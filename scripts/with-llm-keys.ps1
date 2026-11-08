# Runs a command line with the keys of the providers named in the settings files, in the environment of that command only, read from the user's Windows environment variables.
#
#   powershell -NoProfile -File scripts/with-llm-keys.ps1 -Configs panel.json -Run "node src/llm-compare.mjs --panel panel.json ..."
#
# The name of the variable is fixed for each provider (the same table as src/teachers/secrets.mjs):  anthropic -> FORGE_ANTHROPIC_API_KEY,  gemini -> GEMINI_API_KEY.
# ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are never read (Claude Code itself reads those names). Only the providers that the settings files use are read; nothing is picked up by itself.
# A value is not printed, not written, not put in an argument; it goes into the environment of the command and is dropped when the command ends.
param(
  [Parameter(Mandatory = $true)][string[]]$Configs,
  [Parameter(Mandatory = $true)][string]$Run
)
$ErrorActionPreference = 'Stop'
$table = @{ anthropic = 'FORGE_ANTHROPIC_API_KEY'; gemini = 'GEMINI_API_KEY' }
$providers = @{}
foreach ($file in $Configs) {
  $settings = Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json
  $models = if ($settings.models) { @($settings.models.PSObject.Properties | ForEach-Object { $_.Value }) } else { @($settings) }
  foreach ($model in $models) {
    $provider = if ($model.provider) { [string]$model.provider } else { 'anthropic' }
    if (-not $table.ContainsKey($provider)) { throw "provider $provider is not known" }
    $providers[$provider] = $true
  }
}
$given = @()
foreach ($provider in $providers.Keys) {
  $name = $table[$provider]
  $value = [Environment]::GetEnvironmentVariable($name, 'User')
  if ([string]::IsNullOrEmpty($value)) { Write-Host "($name is not set in the user environment: the models of $provider will answer with a no-key error)"; continue }
  Set-Item -Path "Env:$name" -Value $value
  $given += $name
  $value = $null
}
try {
  Invoke-Expression $Run
  exit $LASTEXITCODE
} finally {
  foreach ($name in $given) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}
