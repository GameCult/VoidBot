param(
  [switch] $Open
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"
. (Join-Path $PSScriptRoot "voidbot-operations-dashboard-lib.ps1")

function Read-DotEnv {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Missing .env at $Path"
  }

  $values = @{}

  foreach ($line in Get-Content -LiteralPath $Path) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }

    if ($line.TrimStart().StartsWith("#")) {
      continue
    }

    $separatorIndex = $line.IndexOf("=")

    if ($separatorIndex -lt 1) {
      continue
    }

    $key = $line.Substring(0, $separatorIndex).Trim()
    $value = $line.Substring($separatorIndex + 1)
    $values[$key] = $value
  }

  return $values
}

function Resolve-ConfigPath {
  param(
    [Parameter(Mandatory = $true)]
    [string] $RepoRoot,
    [Parameter(Mandatory = $false)]
    [AllowEmptyString()]
    [string] $Value,
    [Parameter(Mandatory = $true)]
    [string] $Fallback
  )

  $raw = if ([string]::IsNullOrWhiteSpace($Value)) { $Fallback } else { $Value }
  return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $raw))
}

$config = Read-DotEnv -Path $envFile
$storageRoot = Resolve-ConfigPath -RepoRoot $repoRoot -Value $config["STORAGE_ROOT"] -Fallback ".voidbot"
$result = Update-VoidBotOperationsDashboard -RepoRoot $repoRoot -StorageRoot $storageRoot

Write-Host "Dashboard HTML: $($result.DashboardPath)"
Write-Host "Dashboard snapshot: $($result.SnapshotPath)"

if ($Open) {
  Invoke-Item -LiteralPath $result.DashboardPath
}
