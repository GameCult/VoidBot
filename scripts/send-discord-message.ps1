param(
  [switch] $OwnerDm,
  [string] $ChannelId,
  [string] $ReplyToMessageId,
  [string] $PersonaName,
  [string] $PersonaAvatarUrl,
  [string] $Content,
  [string] $ContentFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeScriptPath = Join-Path $repoRoot "scripts\send-discord-message.mjs"

if ($OwnerDm -and -not [string]::IsNullOrWhiteSpace($ChannelId)) {
  throw "Use either -OwnerDm or -ChannelId, not both."
}

if (-not $OwnerDm -and [string]::IsNullOrWhiteSpace($ChannelId)) {
  throw "Provide -OwnerDm or -ChannelId."
}

if ([string]::IsNullOrWhiteSpace($Content) -and [string]::IsNullOrWhiteSpace($ContentFile)) {
  throw "Provide -Content or -ContentFile."
}

if (-not [string]::IsNullOrWhiteSpace($Content) -and -not [string]::IsNullOrWhiteSpace($ContentFile)) {
  throw "Provide only one of -Content or -ContentFile."
}

$arguments = @($nodeScriptPath)
$temporaryContentPath = $null

try {
  if (-not [string]::IsNullOrWhiteSpace($ContentFile)) {
    $arguments += @("--content-file", $ContentFile)
  } else {
    $tempDir = Join-Path $repoRoot ".voidbot\tmp"
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    $temporaryContentPath = Join-Path $tempDir ("discord-message-{0}.txt" -f [guid]::NewGuid())
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($temporaryContentPath, $Content, $utf8NoBom)
    $arguments += @("--content-file", $temporaryContentPath)
  }

  if ($OwnerDm) {
    $arguments += "--owner-dm"
  } else {
    $arguments += @("--channel-id", $ChannelId)
  }

  if (-not [string]::IsNullOrWhiteSpace($ReplyToMessageId)) {
    $arguments += @("--reply-to", $ReplyToMessageId)
  }

  if (-not [string]::IsNullOrWhiteSpace($PersonaName)) {
    $arguments += @("--persona-name", $PersonaName)
  }

  if (-not [string]::IsNullOrWhiteSpace($PersonaAvatarUrl)) {
    $arguments += @("--persona-avatar-url", $PersonaAvatarUrl)
  }

  & node @arguments

  if ($LASTEXITCODE -ne 0) {
    throw "Node send-discord-message helper failed with exit code $LASTEXITCODE."
  }
} finally {
  if ($temporaryContentPath -and (Test-Path $temporaryContentPath)) {
    Remove-Item -LiteralPath $temporaryContentPath -Force -ErrorAction SilentlyContinue
  }
}
