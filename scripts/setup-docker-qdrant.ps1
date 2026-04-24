Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$dockerDesktopPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
$dockerCliDir = "C:\Program Files\Docker\Docker\resources\bin"
$startQdrantScript = Join-Path $PSScriptRoot "start-qdrant.ps1"
$dockerInstallerDownloadDir = Join-Path $env:LOCALAPPDATA "Temp\VoidBot\DockerDesktopInstaller"
$dockerInstallerOverrideUrl = $env:VOIDBOT_DOCKER_DESKTOP_DOWNLOAD_URL

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-WslInstalled {
  try {
    & wsl --status *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Get-DockerInstallerPath {
  New-Item -ItemType Directory -Force -Path $dockerInstallerDownloadDir | Out-Null

  if ($dockerInstallerOverrideUrl) {
    $fileName = [System.IO.Path]::GetFileName(([System.Uri]$dockerInstallerOverrideUrl).AbsolutePath)

    if ([string]::IsNullOrWhiteSpace($fileName)) {
      throw "VOIDBOT_DOCKER_DESKTOP_DOWNLOAD_URL does not point to a valid installer filename."
    }

    $overrideInstallerPath = Join-Path $dockerInstallerDownloadDir $fileName
    Write-Host "Downloading Docker Desktop installer from override URL..."
    & curl.exe -L --fail --silent --show-error --output $overrideInstallerPath $dockerInstallerOverrideUrl

    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $overrideInstallerPath)) {
      throw "Failed to download Docker Desktop installer from override URL."
    }

    return $overrideInstallerPath
  }

  Write-Host "Downloading Docker Desktop installer via winget..."
  $downloadOutput = & winget download `
    --id Docker.DockerDesktop `
    --exact `
    --accept-source-agreements `
    --accept-package-agreements `
    --download-directory $dockerInstallerDownloadDir

  if ($downloadOutput) {
    $downloadOutput | ForEach-Object { Write-Host $_ }
  }

  $installer = Get-ChildItem -Path $dockerInstallerDownloadDir -Filter "*.exe" -File -Recurse |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($null -eq $installer) {
    throw "winget download completed without leaving a Docker Desktop installer behind."
  }

  return $installer.FullName
}

if (-not (Test-Administrator)) {
  throw "Run this script from an elevated PowerShell window. Docker Desktop and WSL feature installation require administrator privileges."
}

$processor = Get-CimInstance Win32_Processor | Select-Object -First 1

if (-not $processor.VirtualizationFirmwareEnabled) {
  throw "Hardware virtualization is disabled in BIOS/UEFI. Enable AMD-V/SVM or Intel VT-x/Virtualization Technology, reboot Windows, then rerun this script."
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw "winget is not available on this machine."
}

$restartRequired = $false

if (-not (Test-WslInstalled)) {
  Write-Host "Installing WSL..."

  try {
    & wsl --install --no-distribution
  } catch {
    Write-Warning "wsl --install --no-distribution failed; retrying with wsl --install."
    & wsl --install
  }

  $restartRequired = $true
}

if (-not (Test-Path $dockerDesktopPath)) {
  $dockerInstallerPath = Get-DockerInstallerPath

  Write-Host "Installing Docker Desktop from $dockerInstallerPath..."
  $installProcess = Start-Process `
    -FilePath $dockerInstallerPath `
    -ArgumentList @(
      "install",
      "--accept-license",
      "--backend=wsl-2"
    ) `
    -Wait `
    -PassThru

  if ($installProcess.ExitCode -ne 0) {
    throw "Docker Desktop installer exited with code $($installProcess.ExitCode). Check $env:LOCALAPPDATA\Docker\install-log.txt for details."
  }

  & net.exe localgroup docker-users $env:USERNAME /add *> $null
}

if ($restartRequired) {
  Write-Warning "A restart may be required before Docker Desktop and WSL are usable."
  Write-Warning "Reboot Windows, open an elevated PowerShell window in this repo, and rerun scripts\\setup-docker-qdrant.ps1."
  exit 0
}

if (Test-Path $dockerCliDir) {
  $env:Path = "$dockerCliDir;$env:Path"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker Desktop appears to be installed, but docker.exe is not on PATH yet. Sign out and back in, or start Docker Desktop once and rerun this script."
}

if (-not (Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue)) {
  Write-Host "Starting Docker Desktop..."
  Start-Process -FilePath $dockerDesktopPath | Out-Null
}

$dockerReady = $false
for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
  & docker version *> $null

  if ($LASTEXITCODE -eq 0) {
    $dockerReady = $true
    break
  }

  Start-Sleep -Seconds 5
}

if (-not $dockerReady) {
  throw "Docker Desktop did not become ready in time. Open Docker Desktop, finish any first-run prompts, then rerun this script."
}

& powershell -ExecutionPolicy Bypass -File $startQdrantScript
