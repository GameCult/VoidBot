param(
  [string] $StateFilePath,
  [switch] $NoPost,
  [switch] $SkipModel
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$stateFilePath = if ([string]::IsNullOrWhiteSpace($StateFilePath)) {
  Join-Path $repoRoot ".voidbot\private\void-self-state.cc"
} else {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($StateFilePath)
}
$statusDir = if (-not [string]::IsNullOrWhiteSpace($env:VOID_RUMINATION_STATUS_DIR)) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:VOID_RUMINATION_STATUS_DIR)
} else {
  Join-Path $repoRoot ".voidbot\status"
}
$logDir = if (-not [string]::IsNullOrWhiteSpace($env:VOID_RUMINATION_LOG_DIR)) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:VOID_RUMINATION_LOG_DIR)
} else {
  Join-Path $repoRoot ".voidbot\logs"
}
$statusPath = Join-Path $statusDir "moderation-rumination.json"
$summaryLogPath = Join-Path $logDir "moderation-rumination.log"
$tracePath = Join-Path $logDir "moderation-rumination-last.jsonl"
$lastMessagePath = Join-Path $statusDir "moderation-rumination-last-message.txt"
$operationOutputPath = Join-Path $statusDir "moderation-rumination-operations.json"
$contextPath = Join-Path $statusDir "moderation-rumination-context.json"
$lockPath = Join-Path $statusDir "moderation-rumination.lock"
$pendingMentionsPath = if (-not [string]::IsNullOrWhiteSpace($env:VOID_RUMINATION_PENDING_MENTIONS_PATH)) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:VOID_RUMINATION_PENDING_MENTIONS_PATH)
} else {
  Join-Path $statusDir "void-moderation-pending-mentions.json"
}
$promptTemplatePath = Join-Path $repoRoot "prompts\void-moderator-rumination.md"
$contextProjectionScriptPath = Join-Path $repoRoot "scripts\lib\void-rumination-context-projection.ps1"
$recentHistoryScriptPath = Join-Path $repoRoot "scripts\export-recent-discord-history.mjs"
$repoActivityScriptPath = Join-Path $repoRoot "scripts\export-recent-repo-activity.mjs"
$selfStateScriptPath = Join-Path $repoRoot "scripts\void-self-state.mjs"
$sendMessageScriptPath = if (-not [string]::IsNullOrWhiteSpace($env:VOID_SEND_DISCORD_SCRIPT)) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:VOID_SEND_DISCORD_SCRIPT)
} else {
  Join-Path $repoRoot "scripts\send-discord-message.mjs"
}
$bifrostRoot = if (-not [string]::IsNullOrWhiteSpace($env:BIFROST_ROOT)) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:BIFROST_ROOT)
} else {
  "E:\Projects\Bifrost"
}
$bifrostBridgeScriptPath = if (-not [string]::IsNullOrWhiteSpace($env:VOID_BIFROST_BRIDGE_SCRIPT)) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:VOID_BIFROST_BRIDGE_SCRIPT)
} else {
  Join-Path $bifrostRoot "tools\bifrost-bridge.mjs"
}
$discordTransportMode = if (-not [string]::IsNullOrWhiteSpace($env:VOID_DISCORD_TRANSPORT)) {
  $env:VOID_DISCORD_TRANSPORT.Trim().ToLowerInvariant()
} elseif (Test-Path $bifrostBridgeScriptPath) {
  "bifrost"
} else {
  "direct"
}
$startedAtUtc = [DateTime]::UtcNow

. $contextProjectionScriptPath

function Write-JsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,
    [Parameter(Mandatory = $true)]
    $Data
  )

  $directory = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  $json = if ($Data -is [System.Array] -and $Data.Count -eq 0) {
    "[]"
  } else {
    $Data | ConvertTo-Json -Depth 32
  }
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Read-JsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  if (-not (Test-Path $Path)) {
    return $null
  }

  $raw = Get-Content -Path $Path -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $null
  }

  return $raw | ConvertFrom-Json
}

function Read-TextFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  return Get-Content -Path $Path -Raw -Encoding UTF8
}

function Append-RunLog {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Line
  )

  $timestamped = "[{0}] {1}" -f ([DateTime]::UtcNow.ToString("o")), $Line
  Add-Content -Path $summaryLogPath -Value $timestamped -Encoding UTF8
}

function Read-DotEnv {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $values = @{}
  if (-not (Test-Path $Path)) {
    return $values
  }

  foreach ($line in Get-Content -Path $Path -Encoding UTF8) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) {
      continue
    }

    $separator = $trimmed.IndexOf("=")
    if ($separator -lt 0) {
      continue
    }

    $key = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1).Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$key] = $value
  }

  return $values
}

function Get-ConfigValue {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name,
    [hashtable] $Values
  )

  $environmentValue = [Environment]::GetEnvironmentVariable($Name)
  if (-not [string]::IsNullOrWhiteSpace($environmentValue)) {
    return $environmentValue
  }

  if ($null -ne $Values -and $Values.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace($Values[$Name])) {
    return $Values[$Name]
  }

  return $null
}

function Split-CommandArgs {
  param(
    [string] $Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return @()
  }

  return [regex]::Matches($Value, '("[^"]*"|''[^'']*''|\S+)') |
    ForEach-Object { $_.Value.Trim().Trim("'`"") }
}

function Quote-ProcessArgument {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Value
  )

  if ($Value -notmatch '[\s"]') {
    return $Value
  }

  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

function Invoke-CodexExec {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Executable,
    [Parameter(Mandatory = $true)]
    [string[]] $Arguments,
    [Parameter(Mandatory = $true)]
    [string] $WorkingDirectory,
    [Parameter(Mandatory = $true)]
    [string] $InputText,
    [Parameter(Mandatory = $true)]
    [int] $TimeoutSeconds
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Executable
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  $startInfo.StandardOutputEncoding = $utf8NoBom
  $startInfo.StandardErrorEncoding = $utf8NoBom
  $startInfo.Arguments = [string]::Join(" ", ($Arguments | ForEach-Object { Quote-ProcessArgument -Value $_ }))

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo

  try {
    [void]$process.Start()
    $inputWriter = [System.IO.StreamWriter]::new($process.StandardInput.BaseStream, $utf8NoBom, 4096, $true)

    try {
      $inputWriter.Write($InputText)
      $inputWriter.Flush()
    } finally {
      $inputWriter.Dispose()
      $process.StandardInput.Close()
    }

    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try {
        $process.Kill($true)
      } catch {
        $process.Kill()
      }
      $process.WaitForExit()
      throw "Codex rumination exceeded timeout of $TimeoutSeconds seconds."
    }
    $stdoutTask.Wait()
    $stderrTask.Wait()

    return @{
      ExitCode = $process.ExitCode
      StdOut = $stdoutTask.Result
      StdErr = $stderrTask.Result
    }
  } finally {
    $process.Dispose()
  }
}

function Get-RepoActivityCursorOperations {
  param(
    $RepoActivity,
    [DateTime] $ObservedAt
  )

  if ($null -eq $RepoActivity) {
    return @()
  }

  $repos = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $RepoActivity -Name "repos"))
  return @(
    $repos |
      Where-Object {
        $repoStatus = Get-ObjectPropertyString -Value $_ -Name "status"
        $recentCount = Get-ObjectPropertyValue -Value $_ -Name "recentCommitCount"
        $latestCommit = Get-ObjectPropertyValue -Value $_ -Name "latestCommit"
        $repoStatus -eq "ok" -and
          $null -ne $recentCount -and
          [int]$recentCount -gt 0 -and
          $null -ne $latestCommit -and
          -not [string]::IsNullOrWhiteSpace((Get-ObjectPropertyString -Value $latestCommit -Name "hash"))
      } |
      ForEach-Object {
        $latestCommit = Get-ObjectPropertyValue -Value $_ -Name "latestCommit"
        @{
          operation = "update_repo_activity_cursor"
          cursor = @{
            repo = Get-ObjectPropertyString -Value $_ -Name "repoName"
            lastCommitAt = Get-ObjectPropertyString -Value $latestCommit -Name "committedAt"
            lastCommitSha = Get-ObjectPropertyString -Value $latestCommit -Name "hash"
            updatedAt = $ObservedAt.ToString("o")
          }
        }
      }
  )
}

function Invoke-NodeJson {
  param(
    [Parameter(Mandatory = $true)]
    [string[]] $Arguments
  )

  $output = & node @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Node helper failed: node $($Arguments -join ' ')"
  }
  if ([string]::IsNullOrWhiteSpace($output)) {
    return $null
  }
  return $output | ConvertFrom-Json
}

function Get-TypedSelfState {
  $script = @"
const core = require('./packages/core/dist');
Promise.all([
  core.loadVoidSelfStateTypedDocuments({ canonicalPath: process.argv[1] }),
  core.loadVoidSelfState(process.argv[1]),
]).then(([typedState, context]) => {
  console.log(JSON.stringify({
    typedState,
    summary: context?.summary ?? ''
  }));
}).catch((error) => { console.error(error); process.exit(1); });
"@
  $output = & node -e $script $stateFilePath
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to read typed self-state."
  }
  return $output | ConvertFrom-Json
}

function Apply-TypedOperation {
  param(
    [Parameter(Mandatory = $true)]
    $Operation
  )

  $operationInputPath = Join-Path $statusDir ("moderation-rumination-operation-{0}.json" -f ([Guid]::NewGuid().ToString("n")))
  Write-JsonFile -Path $operationInputPath -Data $Operation

  try {
    return Invoke-NodeJson -Arguments @(
      $selfStateScriptPath,
      "apply-operation",
      "--canonical", $stateFilePath,
      "--operation-file", $operationInputPath
    )
  } finally {
    Remove-Item -LiteralPath $operationInputPath -Force -ErrorAction SilentlyContinue
  }
}

function Convert-ToOperationArray {
  param($Value)

  if ($null -eq $Value) {
    return @()
  }

  if ($Value -is [System.Array]) {
    return @($Value)
  }

  return @($Value)
}

function Convert-ModerationUserStatusesPatchToOperations {
  param($Operation)

  $userStatuses = Get-ObjectPropertyValue -Value $Operation -Name "userStatuses"
  if ($null -eq $userStatuses) {
    $userStatuses = Get-ObjectPropertyValue -Value $Operation -Name "moderationUserStatuses"
  }
  if ($null -eq $userStatuses) {
    return @()
  }

  return @(
    @(Convert-ToValueArray -Value $userStatuses) |
      Where-Object { $null -ne $_ } |
      ForEach-Object {
        @{
          operation = "upsert_moderation_user_status"
          status = $_
        }
      }
  )
}

function Normalize-ProposedRuminationOperations {
  param($Operations)

  $normalized = @()
  foreach ($operation in @(Convert-ToOperationArray -Value $Operations)) {
    if ($null -eq $operation) {
      continue
    }

    $operationName = Get-ObjectPropertyString -Value $operation -Name "operation"
    if ($null -ne $operationName) {
      $normalized += $operation
      continue
    }

    $statusOperations = @(Convert-ModerationUserStatusesPatchToOperations -Operation $operation)
    if ($statusOperations.Count -gt 0) {
      Append-RunLog ("normalized legacy moderation user status patch into {0} operation(s)." -f $statusOperations.Count)
      $normalized += $statusOperations
      continue
    }

    $normalized += $operation
  }

  return @($normalized)
}

function Test-OpenCaseRequiresRumination {
  param($Case)

  $status = Get-ObjectPropertyString -Value $Case -Name "status"
  return $null -ne $status -and -not @("answered", "resolved", "closed", "retired", "dropped").Contains($status)
}

function Get-ThoughtTargetKey {
  param($Target)

  if ($null -eq $Target) {
    return $null
  }

  $kind = Get-ObjectPropertyString -Value $Target -Name "kind"
  $id = Get-ObjectPropertyString -Value $Target -Name "id"
  if ([string]::IsNullOrWhiteSpace($kind) -or [string]::IsNullOrWhiteSpace($id)) {
    return $null
  }
  return ("{0}:{1}" -f $kind.ToLowerInvariant(), $id.ToLowerInvariant())
}

function Test-CandidateMatchesPressure {
  param(
    $Candidate,
    [Parameter(Mandatory = $true)]
    [string] $PressureId,
    [string] $PressureTargetKey,
    [string[]] $AllowedStatuses = @("queued", "deferred")
  )

  $status = Get-ObjectPropertyString -Value $Candidate -Name "status"
  if ($null -eq $status -or -not $AllowedStatuses.Contains($status)) {
    return $false
  }

  $tags = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $Candidate -Name "tags"))
  if ($tags | Where-Object { ([string]$_).ToLowerInvariant() -eq ("source_pressure:{0}" -f $PressureId.ToLowerInvariant()) }) {
    return $true
  }

  $candidateTargetKey = Get-ThoughtTargetKey -Target (Get-ObjectPropertyValue -Value $Candidate -Name "target")
  return $null -ne $PressureTargetKey -and $candidateTargetKey -eq $PressureTargetKey
}

function Get-DeliverableCandidateInterventions {
  param($TypedState)

  return @(
    @(Convert-ToValueArray -Value $TypedState.candidateInterventions.interventions) |
      Where-Object {
        $status = Get-ObjectPropertyString -Value $_ -Name "status"
        $deliveryTarget = Get-ObjectPropertyValue -Value $_ -Name "deliveryTarget"
        $spokenAt = Get-ObjectPropertyString -Value $_ -Name "spokenAt"
        $status -eq "queued" -and
          $null -ne $deliveryTarget -and
          [string]::IsNullOrWhiteSpace($spokenAt) -and
          -not (Test-QueuedCandidateAlreadyAnswered -Candidate $_ -Receipts $TypedState.speechReceipts.recentReceipts)
      } |
      Sort-Object -Property @{ Expression = { [double](Get-ObjectPropertyValue -Value $_ -Name "priority") }; Descending = $true }, @{ Expression = { Get-ObjectPropertyString -Value $_ -Name "updatedAt" }; Descending = $false }
  )
}

function Test-CandidateDeliveryTargetMatchesReceipt {
  param(
    $DeliveryTarget,
    $Receipt
  )

  $channelId = Get-ObjectPropertyString -Value $DeliveryTarget -Name "channelId"
  $replyToMessageId = Get-ObjectPropertyString -Value $DeliveryTarget -Name "replyToMessageId"
  if ([string]::IsNullOrWhiteSpace($channelId) -or [string]::IsNullOrWhiteSpace($replyToMessageId)) {
    return $false
  }

  return (
    (Get-ObjectPropertyString -Value $Receipt -Name "channelId") -eq $channelId -and
    (Get-ObjectPropertyString -Value $Receipt -Name "replyToMessageId") -eq $replyToMessageId
  )
}

function Test-QueuedCandidateAlreadyAnswered {
  param(
    $Candidate,
    $Receipts
  )

  $deliveryTarget = Get-ObjectPropertyValue -Value $Candidate -Name "deliveryTarget"
  if ($null -eq $deliveryTarget) {
    return $false
  }

  return @(
    @(Convert-ToValueArray -Value $Receipts) |
      Where-Object { Test-CandidateDeliveryTargetMatchesReceipt -DeliveryTarget $deliveryTarget -Receipt $_ }
  ).Count -gt 0
}

function Get-AlreadyAnsweredCandidateRetireOperations {
  param(
    $TypedState,
    [Parameter(Mandatory = $true)]
    [DateTime] $RetiredAt
  )

  $receipts = @(Convert-ToValueArray -Value $TypedState.speechReceipts.recentReceipts)
  return @(
    @(Convert-ToValueArray -Value $TypedState.candidateInterventions.interventions) |
      Where-Object {
        $status = Get-ObjectPropertyString -Value $_ -Name "status"
        $spokenAt = Get-ObjectPropertyString -Value $_ -Name "spokenAt"
        $status -eq "queued" -and
          [string]::IsNullOrWhiteSpace($spokenAt) -and
          (Test-QueuedCandidateAlreadyAnswered -Candidate $_ -Receipts $receipts)
      } |
      ForEach-Object {
        @{
          operation = "retire_candidate_intervention"
          interventionId = Get-ObjectPropertyString -Value $_ -Name "interventionId"
          retiredAt = $RetiredAt.ToString("o")
          reason = "duplicate reply target already answered"
        }
      }
  )
}

function Get-SpeechPressureObligations {
  param($TypedState)

  $candidateInterventions = @(Convert-ToValueArray -Value $TypedState.candidateInterventions.interventions)
  return @(
    @(Convert-ToValueArray -Value $TypedState.agencyPressure.pressures) |
      Where-Object {
        $status = Get-ObjectPropertyString -Value $_ -Name "status"
        $kind = Get-ObjectPropertyString -Value $_ -Name "kind"
        $intensity = Get-ObjectPropertyValue -Value $_ -Name "intensity"
        $status -in @("active", "ready_to_act") -and
          $kind -in @("self_advocacy_request", "world_advocacy_request") -and
          $null -ne $intensity -and [double]$intensity -ge 0.55
      } |
      Where-Object {
        $pressureId = Get-ObjectPropertyString -Value $_ -Name "pressureId"
        $pressureTargetKey = Get-ThoughtTargetKey -Target (Get-ObjectPropertyValue -Value $_ -Name "target")
        -not ($candidateInterventions | Where-Object {
          Test-CandidateMatchesPressure -Candidate $_ -PressureId $pressureId -PressureTargetKey $pressureTargetKey -AllowedStatuses @("queued", "deferred")
        } | Select-Object -First 1)
      } |
      ForEach-Object {
        @{
          pressureId = Get-ObjectPropertyString -Value $_ -Name "pressureId"
          kind = Get-ObjectPropertyString -Value $_ -Name "kind"
          status = Get-ObjectPropertyString -Value $_ -Name "status"
          target = Get-ObjectPropertyValue -Value $_ -Name "target"
          summary = Get-ObjectPropertyString -Value $_ -Name "summary"
          claim = Get-ObjectPropertyString -Value $_ -Name "claim"
          question = Get-ObjectPropertyString -Value $_ -Name "question"
          tension = Get-ObjectPropertyString -Value $_ -Name "tension"
          actionImplication = Get-ObjectPropertyString -Value $_ -Name "actionImplication"
          intensity = Get-ObjectPropertyValue -Value $_ -Name "intensity"
          sourceMemoryIds = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "sourceMemoryIds"))
          tags = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "tags"))
          requiredResolution = "Queue a live candidate intervention with tag source_pressure:$((Get-ObjectPropertyString -Value $_ -Name "pressureId")) or cool/retire this pressure with an explicit reason. An old spoken candidate does not satisfy a still-active pressure."
        }
      }
  )
}

function Test-OperationResolvesSpeechPressure {
  param(
    $Operation,
    $Obligation
  )

  $operationName = Get-ObjectPropertyString -Value $Operation -Name "operation"
  $pressureId = Get-ObjectPropertyString -Value $Obligation -Name "pressureId"
  $pressureTargetKey = Get-ThoughtTargetKey -Target (Get-ObjectPropertyValue -Value $Obligation -Name "target")

  if ($operationName -eq "queue_candidate_intervention") {
    $intervention = Get-ObjectPropertyValue -Value $Operation -Name "intervention"
    $status = Get-ObjectPropertyString -Value $intervention -Name "status"
    if ($messageCount -gt 0 -and -not $NoPost) {
      $deliveryTarget = Get-ObjectPropertyValue -Value $intervention -Name "deliveryTarget"
      $channelId = Get-ObjectPropertyString -Value $deliveryTarget -Name "channelId"
      if ($status -ne "queued" -or [string]::IsNullOrWhiteSpace($channelId)) {
        return $false
      }
    }
    return Test-CandidateMatchesPressure -Candidate $intervention -PressureId $pressureId -PressureTargetKey $pressureTargetKey
  }

  if ($operationName -eq "retire_agency_pressure") {
    return (Get-ObjectPropertyString -Value $Operation -Name "pressureId") -eq $pressureId
  }

  if ($operationName -eq "upsert_agency_pressure") {
    $pressure = Get-ObjectPropertyValue -Value $Operation -Name "pressure"
    if ((Get-ObjectPropertyString -Value $pressure -Name "pressureId") -ne $pressureId) {
      return $false
    }

    $status = Get-ObjectPropertyString -Value $pressure -Name "status"
    return $status -in @("cooling", "resolved", "retired")
  }

  return $false
}

function Assert-SpeechPressureObligationsResolved {
  param(
    [object[]] $Obligations,
    [object[]] $Operations
  )

  foreach ($obligation in $Obligations) {
    $pressureId = Get-ObjectPropertyString -Value $obligation -Name "pressureId"
    $resolved = $Operations | Where-Object {
      Test-OperationResolvesSpeechPressure -Operation $_ -Obligation $obligation
    } | Select-Object -First 1

    if ($null -eq $resolved) {
      throw "Active advocacy pressure '$pressureId' requires a candidate intervention or an explicit cool/retire operation; silent [] would muzzle it."
    }
  }
}

function Assert-AllowedRuminationOperation {
  param($Operation)

  $operationName = Get-ObjectPropertyString -Value $Operation -Name "operation"
  $allowed = @(
    "upsert_open_case",
    "close_open_case",
    "record_short_term_memory",
    "merge_incubation_support",
    "upsert_agency_pressure",
    "retire_agency_pressure",
    "upsert_affect_need",
    "retire_affect_need",
    "upsert_social_bond",
    "retire_social_bond",
    "upsert_status_read",
    "retire_status_read",
    "update_mood_dimensions",
    "queue_candidate_intervention",
    "retire_candidate_intervention",
    "upsert_moderation_user_status"
  )

  if ($null -eq $operationName -or -not $allowed.Contains($operationName)) {
    throw "Rumination proposed disallowed operation '$operationName'."
  }
}

function Convert-LastSpeechToReceiptOperation {
  param(
    $Speech,
    [string] $CandidateInterventionId
  )

  $sentAt = Get-ObjectPropertyString -Value $Speech -Name "sentAt"
  if ($null -eq $Speech -or $null -eq $sentAt) {
    return $null
  }

  $receiptKeyParts = @(
    "speech",
    $CandidateInterventionId,
    $sentAt,
    (Get-ObjectPropertyString -Value $Speech -Name "channelId"),
    (Get-ObjectPropertyString -Value $Speech -Name "replyToMessageId"),
    (Get-ObjectPropertyString -Value $Speech -Name "preview")
  )
  $receiptKey = ($receiptKeyParts -join "|").ToLowerInvariant() -replace '[^a-z0-9]+', '-'
  $receiptKey = $receiptKey.Trim("-")
  if ([string]::IsNullOrWhiteSpace($receiptKey)) {
    $receiptKey = "speech-" + ([Guid]::NewGuid().ToString("n"))
  }

  $receipt = @{
    receiptKey = $receiptKey.Substring(0, [Math]::Min(96, $receiptKey.Length))
    sentAt = $sentAt
    mode = if (Get-ObjectPropertyString -Value $Speech -Name "mode") { Get-ObjectPropertyString -Value $Speech -Name "mode" } else { "channel" }
    transport = if (Get-ObjectPropertyString -Value $Speech -Name "transport") { Get-ObjectPropertyString -Value $Speech -Name "transport" } else { "bot" }
  }

  if (-not [string]::IsNullOrWhiteSpace($CandidateInterventionId)) {
    $receipt.candidateInterventionId = $CandidateInterventionId
  }

  foreach ($key in @("channelId", "replyToMessageId", "personaName", "personaAvatarUrl", "preview", "previewHash")) {
    $propertyValue = Get-ObjectPropertyString -Value $Speech -Name $key
    if ($null -ne $propertyValue) {
      $receipt[$key] = $propertyValue
    }
  }

  foreach ($key in @("contentLength", "chunkCount")) {
    $property = if ($null -ne $Speech) { $Speech.PSObject.Properties[$key] } else { $null }
    if ($null -ne $property -and $null -ne $property.Value) {
      $receipt[$key] = [int]$property.Value
    }
  }

  return @{
    operation = "record_delivery_receipt"
    receipt = $receipt
  }
}

function Convert-LastSpeechToSpokenCandidateOperation {
  param(
    [Parameter(Mandatory = $true)]
    [string] $InterventionId,
    $Speech
  )

  $receiptOperation = Convert-LastSpeechToReceiptOperation -Speech $Speech -CandidateInterventionId $InterventionId
  if ($null -eq $receiptOperation) {
    return $null
  }

  return @{
    operation = "mark_candidate_intervention_spoken"
    interventionId = $InterventionId
    receipt = $receiptOperation.receipt
  }
}

function Invoke-CandidateInterventionDelivery {
  param(
    [Parameter(Mandatory = $true)]
    $Operation
  )

  $intervention = Get-ObjectPropertyValue -Value $Operation -Name "intervention"
  return Invoke-CandidateInterventionDeliveryFromIntervention -Intervention $intervention
}

function Invoke-CandidateInterventionDeliveryFromIntervention {
  param(
    [Parameter(Mandatory = $true)]
    $Intervention
  )

  $intervention = $Intervention
  $deliveryTarget = Get-ObjectPropertyValue -Value $intervention -Name "deliveryTarget"
  if ($null -eq $deliveryTarget) {
    return $null
  }

  $interventionId = Get-ObjectPropertyString -Value $intervention -Name "interventionId"
  $draft = Get-ObjectPropertyString -Value $intervention -Name "draft"
  if ([string]::IsNullOrWhiteSpace($interventionId) -or [string]::IsNullOrWhiteSpace($draft)) {
    return $null
  }

  $contentPath = Join-Path $statusDir ("moderation-rumination-speech-{0}.txt" -f ([Guid]::NewGuid().ToString("n")))
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($contentPath, $draft, $utf8NoBom)

  $mode = Get-ObjectPropertyString -Value $deliveryTarget -Name "mode"
  $arguments = @()
  if ($discordTransportMode -eq "bifrost") {
    if ($mode -eq "owner_dm") {
      throw "Candidate intervention '$interventionId' targets owner_dm. Bifrost is the default public transport; use VOID_DISCORD_TRANSPORT=direct only for standalone owner-private installs."
    }
    $channelId = Get-ObjectPropertyString -Value $deliveryTarget -Name "channelId"
    if ([string]::IsNullOrWhiteSpace($channelId)) {
      throw "Candidate intervention '$interventionId' has deliveryTarget without channelId."
    }
    $arguments = @($bifrostBridgeScriptPath, "discord-post", "--channel-id", $channelId, "--content-file", $contentPath)
  } else {
    $arguments = @($sendMessageScriptPath, "--content-file", $contentPath)
    if ($mode -eq "owner_dm") {
      $arguments += "--owner-dm"
    } else {
      $channelId = Get-ObjectPropertyString -Value $deliveryTarget -Name "channelId"
      if ([string]::IsNullOrWhiteSpace($channelId)) {
        throw "Candidate intervention '$interventionId' has deliveryTarget without channelId."
      }
      $arguments += @("--channel-id", $channelId)
    }
  }

  $replyToMessageId = Get-ObjectPropertyString -Value $deliveryTarget -Name "replyToMessageId"
  if (-not [string]::IsNullOrWhiteSpace($replyToMessageId)) {
    if ($discordTransportMode -eq "bifrost") {
      $arguments += @("--reply-to-message-id", $replyToMessageId)
    } else {
      $arguments += @("--reply-to", $replyToMessageId)
    }
  }

  $personaName = Get-ObjectPropertyString -Value $deliveryTarget -Name "personaName"
  if (-not [string]::IsNullOrWhiteSpace($personaName)) {
    $arguments += @("--persona-name", $personaName)
  }

  $personaAvatarUrl = Get-ObjectPropertyString -Value $deliveryTarget -Name "personaAvatarUrl"
  if (-not [string]::IsNullOrWhiteSpace($personaAvatarUrl)) {
    $arguments += @("--persona-avatar-url", $personaAvatarUrl)
  }

  $previousVoidStatusDir = $env:VOID_STATUS_DIR
  try {
    $env:VOID_STATUS_DIR = $statusDir
    $sendOutput = & node @arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
      $sendDetail = [string]($sendOutput -join [Environment]::NewLine)
      if ([string]::IsNullOrWhiteSpace($sendDetail)) {
        throw "Candidate intervention delivery failed with exit code $LASTEXITCODE."
      }

      throw "Candidate intervention delivery failed with exit code $LASTEXITCODE`: $($sendDetail.Trim())"
    }
  } finally {
    $env:VOID_STATUS_DIR = $previousVoidStatusDir
    Remove-Item -LiteralPath $contentPath -Force -ErrorAction SilentlyContinue
  }

  if ($discordTransportMode -eq "bifrost") {
    $bridgeReceiptText = [string]($sendOutput -join [Environment]::NewLine)
    $speech = Convert-BifrostBridgeReceiptToSpeechStatus -Receipt ($bridgeReceiptText | ConvertFrom-Json) -Preview $draft
    return Convert-LastSpeechToSpokenCandidateOperation -InterventionId $interventionId -Speech $speech
  }

  $lastSpeechPath = Join-Path $statusDir "void-last-speech.json"
  if (-not (Test-Path $lastSpeechPath)) {
    throw "Candidate intervention delivery did not write last speech status."
  }
  $speech = Read-JsonFile -Path $lastSpeechPath
  return Convert-LastSpeechToSpokenCandidateOperation -InterventionId $interventionId -Speech $speech
}

function Convert-BifrostBridgeReceiptToSpeechStatus {
  param(
    $Receipt,
    [string] $Preview
  )

  if ($null -eq $Receipt) {
    return $null
  }

  return [pscustomobject]@{
    sentAt = [DateTime]::UtcNow.ToString("o")
    mode = Get-ObjectPropertyString -Value $Receipt -Name "action"
    transport = Get-ObjectPropertyString -Value $Receipt -Name "transport"
    channelId = Get-ObjectPropertyString -Value $Receipt -Name "channelId"
    messageId = Get-ObjectPropertyString -Value $Receipt -Name "messageId"
    recipientId = Get-ObjectPropertyString -Value $Receipt -Name "recipientId"
    preview = if ([string]::IsNullOrWhiteSpace($Preview)) { $null } else { $Preview.Substring(0, [Math]::Min(280, $Preview.Length)) }
  }
}

function Get-PendingModerationStatusNotices {
  param($TypedState)

  $statuses = @(Convert-ToValueArray -Value $TypedState.moderationCursor.userStatuses)
  return @(
    $statuses | ForEach-Object {
      $status = $_
      $userId = Get-ObjectPropertyString -Value $status -Name "userId"
      if ([string]::IsNullOrWhiteSpace($userId)) {
        return
      }

      @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $status -Name "pendingNotices")) |
        Where-Object { [string]::IsNullOrWhiteSpace((Get-ObjectPropertyString -Value $_ -Name "sentAt")) } |
        ForEach-Object {
          [pscustomobject]@{
            userId = $userId
            userName = Get-ObjectPropertyString -Value $status -Name "userName"
            notice = $_
          }
        }
    }
  )
}

function Convert-LastSpeechToModerationStatusNoticeSentOperation {
  param(
    [Parameter(Mandatory = $true)]
    [string] $UserId,
    [Parameter(Mandatory = $true)]
    [string] $NoticeId,
    $Speech
  )

  $sentAt = Get-ObjectPropertyString -Value $Speech -Name "sentAt"
  if ($null -eq $Speech -or [string]::IsNullOrWhiteSpace($sentAt)) {
    return $null
  }

  $operation = @{
    operation = "mark_moderation_status_notice_sent"
    userId = $UserId
    noticeId = $NoticeId
    sentAt = $sentAt
  }

  foreach ($key in @("channelId", "messageId")) {
    $propertyValue = Get-ObjectPropertyString -Value $Speech -Name $key
    if ($null -ne $propertyValue) {
      $operation[$key] = $propertyValue
    }
  }

  return $operation
}

function Invoke-ModerationStatusNoticeDelivery {
  param(
    [Parameter(Mandatory = $true)]
    $PendingNotice
  )

  $userId = Get-ObjectPropertyString -Value $PendingNotice -Name "userId"
  $notice = Get-ObjectPropertyValue -Value $PendingNotice -Name "notice"
  $noticeId = Get-ObjectPropertyString -Value $notice -Name "noticeId"
  $body = Get-ObjectPropertyString -Value $notice -Name "body"
  if (
    [string]::IsNullOrWhiteSpace($userId) -or
    [string]::IsNullOrWhiteSpace($noticeId) -or
    [string]::IsNullOrWhiteSpace($body)
  ) {
    return $null
  }

  $contentPath = Join-Path $statusDir ("moderation-status-dm-{0}.txt" -f ([Guid]::NewGuid().ToString("n")))
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($contentPath, $body, $utf8NoBom)

  $arguments = if ($discordTransportMode -eq "bifrost") {
    @($bifrostBridgeScriptPath, "discord-dm", "--recipient-id", $userId, "--content-file", $contentPath)
  } else {
    @($sendMessageScriptPath, "--content-file", $contentPath, "--user-dm", $userId)
  }
  $previousVoidStatusDir = $env:VOID_STATUS_DIR
  try {
    $env:VOID_STATUS_DIR = $statusDir
    $sendOutput = & node @arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
      $sendDetail = [string]($sendOutput -join [Environment]::NewLine)
      if ([string]::IsNullOrWhiteSpace($sendDetail)) {
        throw "Moderation status DM '$noticeId' failed with exit code $LASTEXITCODE."
      }

      throw "Moderation status DM '$noticeId' failed with exit code $LASTEXITCODE`: $($sendDetail.Trim())"
    }
  } finally {
    $env:VOID_STATUS_DIR = $previousVoidStatusDir
    Remove-Item -LiteralPath $contentPath -Force -ErrorAction SilentlyContinue
  }

  if ($discordTransportMode -eq "bifrost") {
    $bridgeReceiptText = [string]($sendOutput -join [Environment]::NewLine)
    $speech = Convert-BifrostBridgeReceiptToSpeechStatus -Receipt ($bridgeReceiptText | ConvertFrom-Json) -Preview $body
    return Convert-LastSpeechToModerationStatusNoticeSentOperation -UserId $userId -NoticeId $noticeId -Speech $speech
  }

  $lastSpeechPath = Join-Path $statusDir "void-last-speech.json"
  if (-not (Test-Path $lastSpeechPath)) {
    throw "Moderation status DM '$noticeId' did not write last speech status."
  }
  $speech = Read-JsonFile -Path $lastSpeechPath
  return Convert-LastSpeechToModerationStatusNoticeSentOperation -UserId $userId -NoticeId $noticeId -Speech $speech
}

function Test-LockProcessAlive {
  param($LockRecord)

  $lockPid = Get-ObjectPropertyValue -Value $LockRecord -Name "pid"
  if ($null -eq $lockPid) {
    return $false
  }

  try {
    $process = Get-Process -Id ([int]$lockPid) -ErrorAction Stop
    return $null -ne $process
  } catch {
    return $false
  }
}

function Test-LockWithinRuntimeLimit {
  param(
    $LockRecord,
    [Parameter(Mandatory = $true)]
    [int] $MaxRuntimeMinutes
  )

  $startedAtRaw = Get-ObjectPropertyString -Value $LockRecord -Name "startedAt"
  if ([string]::IsNullOrWhiteSpace($startedAtRaw)) {
    return $false
  }

  try {
    $startedAt = [DateTime]::Parse($startedAtRaw).ToUniversalTime()
  } catch {
    return $false
  }

  return (([DateTime]::UtcNow - $startedAt).TotalMinutes -lt $MaxRuntimeMinutes)
}

function Test-ActiveLock {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,
    [Parameter(Mandatory = $true)]
    [int] $MaxRuntimeMinutes
  )

  if (-not (Test-Path $Path)) {
    return $false
  }

  $lockRecord = Read-JsonFile -Path $Path
  return (Test-LockProcessAlive -LockRecord $lockRecord) -and
    (Test-LockWithinRuntimeLimit -LockRecord $lockRecord -MaxRuntimeMinutes $MaxRuntimeMinutes)
}

function Assert-SpokenCandidateApplied {
  param(
    [Parameter(Mandatory = $true)]
    [string] $InterventionId,
    [Parameter(Mandatory = $true)]
    [string] $ReceiptKey
  )

  $state = (Get-TypedSelfState).typedState
  $candidate = @(
    @(Convert-ToValueArray -Value $state.candidateInterventions.interventions) |
      Where-Object { (Get-ObjectPropertyString -Value $_ -Name "interventionId") -eq $InterventionId }
  ) | Select-Object -First 1
  $receipt = @(
    @(Convert-ToValueArray -Value $state.speechReceipts.recentReceipts) |
      Where-Object { (Get-ObjectPropertyString -Value $_ -Name "receiptKey") -eq $ReceiptKey }
  ) | Select-Object -First 1

  if ($null -ne $candidate) {
    throw "Delivery receipt '$ReceiptKey' was recorded but terminal candidate '$InterventionId' stayed in current state."
  }
  if ($null -eq $receipt -or (Get-ObjectPropertyString -Value $receipt -Name "candidateInterventionId") -ne $InterventionId) {
    throw "Candidate '$InterventionId' was delivered without a linked delivery receipt '$ReceiptKey'."
  }
}

trap {
  $finishedAtUtc = [DateTime]::UtcNow
  $failureMessage = $_.Exception.Message

  Write-JsonFile -Path $statusPath -Data @{
    status = "failed"
    startedAt = $startedAtUtc.ToString("o")
    finishedAt = $finishedAtUtc.ToString("o")
    durationSeconds = [Math]::Round(($finishedAtUtc - $startedAtUtc).TotalSeconds, 2)
    failureMessage = $failureMessage
    noPost = [bool]$NoPost
    skipModel = [bool]$SkipModel
    stateFile = $stateFilePath
    contextPath = $contextPath
    operationOutputPath = $operationOutputPath
    tracePath = $tracePath
  }

  Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
  throw
}

New-Item -ItemType Directory -Force -Path $statusDir, $logDir, (Split-Path -Parent $stateFilePath) | Out-Null

$maxRuntimeMinutes = if (-not [string]::IsNullOrWhiteSpace($env:VOID_RUMINATION_MAX_RUNTIME_MINUTES)) {
  [int]$env:VOID_RUMINATION_MAX_RUNTIME_MINUTES
} else {
  15
}

if (Test-Path $lockPath) {
  $existingLock = Read-JsonFile -Path $lockPath
  $lockProcessAlive = Test-LockProcessAlive -LockRecord $existingLock
  if ($lockProcessAlive -and (Test-LockWithinRuntimeLimit -LockRecord $existingLock -MaxRuntimeMinutes $maxRuntimeMinutes)) {
    Write-JsonFile -Path $statusPath -Data @{
      status = "skipped"
      reason = "lock_present"
      observedAt = ([DateTime]::UtcNow.ToString("o"))
      stateFile = $stateFilePath
    }
    return
  }
  if ($lockProcessAlive) {
    Write-JsonFile -Path $statusPath -Data @{
      status = "skipped"
      reason = "lock_over_runtime_active"
      observedAt = ([DateTime]::UtcNow.ToString("o"))
      stateFile = $stateFilePath
      lockPath = $lockPath
      maxRuntimeMinutes = $maxRuntimeMinutes
      pid = Get-ObjectPropertyValue -Value $existingLock -Name "pid"
      startedAt = Get-ObjectPropertyString -Value $existingLock -Name "startedAt"
    }
    return
  }
  Remove-Item -LiteralPath $lockPath -Force
}

Write-JsonFile -Path $lockPath -Data @{
  pid = $PID
  startedAt = $startedAtUtc.ToString("o")
}
Write-JsonFile -Path $statusPath -Data @{
  status = "starting"
  startedAt = $startedAtUtc.ToString("o")
  stateFile = $stateFilePath
  lockPath = $lockPath
  pid = $PID
}

if (Test-Path $operationOutputPath) {
  Remove-Item -LiteralPath $operationOutputPath -Force
}

foreach ($requiredPath in @($contextProjectionScriptPath, $recentHistoryScriptPath, $repoActivityScriptPath, $selfStateScriptPath)) {
  if (-not (Test-Path $requiredPath)) {
    throw "Missing required helper at $requiredPath"
  }
}
if ($discordTransportMode -eq "bifrost") {
  if (-not (Test-Path $bifrostBridgeScriptPath)) {
    throw "VOID_DISCORD_TRANSPORT=bifrost but Bifrost bridge helper is missing at $bifrostBridgeScriptPath"
  }
} elseif ($discordTransportMode -eq "direct") {
  if (-not (Test-Path $sendMessageScriptPath)) {
    throw "VOID_DISCORD_TRANSPORT=direct but direct Discord helper is missing at $sendMessageScriptPath"
  }
} else {
  throw "Unsupported VOID_DISCORD_TRANSPORT '$discordTransportMode'. Use bifrost or direct."
}
if (-not (Test-Path $promptTemplatePath)) {
  throw "Missing rumination prompt template at $promptTemplatePath"
}

$envValues = Read-DotEnv -Path (Join-Path $repoRoot ".env")
$codexExecutable = if (-not [string]::IsNullOrWhiteSpace($env:CODEX_EXECUTABLE)) {
  $env:CODEX_EXECUTABLE
} elseif ($envValues.ContainsKey("CODEX_EXECUTABLE") -and -not [string]::IsNullOrWhiteSpace($envValues["CODEX_EXECUTABLE"])) {
  $envValues["CODEX_EXECUTABLE"]
} else {
  "codex"
}
$codexModel = if (-not [string]::IsNullOrWhiteSpace($env:CODEX_MODEL)) {
  $env:CODEX_MODEL
} elseif ($envValues.ContainsKey("CODEX_MODEL") -and -not [string]::IsNullOrWhiteSpace($envValues["CODEX_MODEL"])) {
  $envValues["CODEX_MODEL"]
} else {
  "gpt-5.4"
}
$codexReasoningEffort = if (-not [string]::IsNullOrWhiteSpace($env:CODEX_MODEL_REASONING_EFFORT)) {
  $env:CODEX_MODEL_REASONING_EFFORT
} elseif ($envValues.ContainsKey("CODEX_MODEL_REASONING_EFFORT") -and -not [string]::IsNullOrWhiteSpace($envValues["CODEX_MODEL_REASONING_EFFORT"])) {
  $envValues["CODEX_MODEL_REASONING_EFFORT"]
} else {
  "medium"
}
$codexExecArgs = if (-not [string]::IsNullOrWhiteSpace($env:CODEX_EXEC_ARGS)) {
  Split-CommandArgs -Value $env:CODEX_EXEC_ARGS
} elseif ($envValues.ContainsKey("CODEX_EXEC_ARGS")) {
  Split-CommandArgs -Value $envValues["CODEX_EXEC_ARGS"]
} else {
  @()
}
$codexTimeoutSeconds = if (-not [string]::IsNullOrWhiteSpace($env:VOID_RUMINATION_CODEX_TIMEOUT_SECONDS)) {
  [int]$env:VOID_RUMINATION_CODEX_TIMEOUT_SECONDS
} elseif ($envValues.ContainsKey("VOID_RUMINATION_CODEX_TIMEOUT_SECONDS") -and -not [string]::IsNullOrWhiteSpace($envValues["VOID_RUMINATION_CODEX_TIMEOUT_SECONDS"])) {
  [int]$envValues["VOID_RUMINATION_CODEX_TIMEOUT_SECONDS"]
} else {
  [Math]::Max(60, $maxRuntimeMinutes * 60)
}
$publicRoomChannelId = Get-ConfigValue -Name "VOID_PUBLIC_ROOM_CHANNEL_ID" -Values $envValues
$publicRoomPersonaName = Get-ConfigValue -Name "VOID_PUBLIC_ROOM_PERSONA_NAME" -Values $envValues
$publicRoomPersonaAvatarUrl = Get-ConfigValue -Name "VOID_PUBLIC_ROOM_PERSONA_AVATAR_URL" -Values $envValues

$typedContext = Get-TypedSelfState
$typedState = $typedContext.typedState
$priorCursor = $typedState.moderationCursor
$speechPressureObligations = @(Get-SpeechPressureObligations -TypedState $typedState)
$deliverableCandidates = @(Get-DeliverableCandidateInterventions -TypedState $typedState)
$pendingModerationStatusNotices = @(Get-PendingModerationStatusNotices -TypedState $typedState)

$historyArgs = @($recentHistoryScriptPath)
$priorCursorTimestamp = Get-ObjectPropertyString -Value $priorCursor -Name "lastReviewedTimestamp"
if ($null -ne $priorCursor -and $null -ne $priorCursorTimestamp) {
  $historyArgs += @("--after", $priorCursorTimestamp, "--limit", "120")
} else {
  $historyArgs += @("--hours", "6", "--limit", "120")
}

$history = Invoke-NodeJson -Arguments $historyArgs
$observedCursor = $priorCursor
$messageCount = 0
$historyMessagesProperty = if ($null -ne $history) { $history.PSObject.Properties["messages"] } else { $null }
if ($null -ne $historyMessagesProperty -and $null -ne $historyMessagesProperty.Value) {
  $messageCount = $historyMessagesProperty.Value.Count
}

if ($messageCount -gt 0) {
  $latestObservedMessage = $historyMessagesProperty.Value[$messageCount - 1]
  $observedCursor = [pscustomobject]@{
    lastReviewedMessageId = Get-ObjectPropertyString -Value $latestObservedMessage -Name "id"
    lastReviewedTimestamp = Get-ObjectPropertyString -Value $latestObservedMessage -Name "timestamp"
  }
}

$repoActivity = $null
try {
  $repoActivity = Invoke-NodeJson -Arguments @(
    $repoActivityScriptPath,
    "--hours", "96",
    "--max-commits", "3",
    "--read-only",
    "--state-path", $stateFilePath
  )
} catch {
  $repoActivity = @{
    status = "failed"
    error = $_.Exception.Message
  }
}

$pendingMentions = @()
$pendingMentionPacket = Read-JsonFile -Path $pendingMentionsPath
if ($null -ne $pendingMentionPacket) {
  $pendingMentionsValue = Get-ObjectPropertyValue -Value $pendingMentionPacket -Name "pendingMentions"
  if ($null -ne $pendingMentionsValue) {
    $pendingMentions = @(Convert-ToValueArray -Value $pendingMentionsValue)
  }
}

Write-JsonFile -Path $contextPath -Data @{
  generated = "now"
  stateFile = $stateFilePath
  noPost = [bool]$NoPost
  selfStateSummary = $typedContext.summary
  chronology = "Times in this prompt-facing context are relative phrases. Exact timestamps stay parent-owned for typed state and cursor bookkeeping."
  openCases = @(Project-OpenCasesForRumination -Cases $typedState.moderationCursor.openCases -Now $startedAtUtc)
  moderationUserStatuses = @(Project-ModerationUserStatusesForRumination -Statuses $typedState.moderationCursor.userStatuses -Now $startedAtUtc)
  speechReceipts = @(Project-SpeechReceiptsForRumination -Receipts $typedState.speechReceipts.recentReceipts -Now $startedAtUtc)
  memories = @(Project-MemoriesForRumination -Memories $typedState.thoughtMemory.memories -Now $startedAtUtc)
  shortTermMemories = @(Project-MemoriesForRumination -Memories $typedState.thoughtMemory.shortTerm -Now $startedAtUtc)
  incubation = @(Project-IncubationForRumination -Threads $typedState.thoughtMemory.incubation -Now $startedAtUtc)
  agencyPressure = @(Project-AgencyPressureForRumination -Pressures $typedState.agencyPressure.pressures -Now $startedAtUtc)
  speechPressureObligations = $speechPressureObligations
  pendingMentions = $pendingMentions
  recentConversationTarget = Project-RecentConversationTargetForRumination -History $history -PersonaName $publicRoomPersonaName -PersonaAvatarUrl $publicRoomPersonaAvatarUrl
  publicSpeechTarget = Project-PublicSpeechTargetForRumination -ChannelId $publicRoomChannelId -PersonaName $publicRoomPersonaName -PersonaAvatarUrl $publicRoomPersonaAvatarUrl
  deliverableCandidateCount = [int]$deliverableCandidates.Count
  candidateInterventions = @(Project-InterventionsForRumination -Interventions $typedState.candidateInterventions.interventions -Now $startedAtUtc)
  scheduledRuntime = Project-ScheduledRuntimeForRumination -Runtime $typedState.scheduledRuntime -Now $startedAtUtc
  priorCursor = Project-CursorForRumination -Cursor $priorCursor -Now $startedAtUtc
  observedCursor = Project-CursorForRumination -Cursor $observedCursor -Now $startedAtUtc
  recentHistory = Project-RecentHistoryForRumination -History $history -Now $startedAtUtc
  repoActivity = Select-RuminationRepoActivity -RepoActivity $repoActivity -Now $startedAtUtc
}

$isNapping = [bool](Get-ObjectPropertyValue -Value $typedState.scheduledRuntime.sleepCycle -Name "isNapping")
$openCaseCount = @(
  @(Convert-ToValueArray -Value $typedState.moderationCursor.openCases) |
    Where-Object { Test-OpenCaseRequiresRumination -Case $_ }
).Count
if ($isNapping -and $messageCount -eq 0 -and $openCaseCount -eq 0 -and $deliverableCandidates.Count -eq 0 -and $pendingModerationStatusNotices.Count -eq 0) {
  Append-RunLog "napping: no new room messages or open cases; skipping awake rumination."
  Write-JsonFile -Path $operationOutputPath -Data @()
  $finishedAtUtc = [DateTime]::UtcNow
  Write-JsonFile -Path $statusPath -Data @{
    status = "skipped"
    reason = "napping_without_room_debt"
    startedAt = $startedAtUtc.ToString("o")
    finishedAt = $finishedAtUtc.ToString("o")
    durationSeconds = [Math]::Round(($finishedAtUtc - $startedAtUtc).TotalSeconds, 2)
    noPost = [bool]$NoPost
    skipModel = [bool]$SkipModel
    stateFile = [string]$stateFilePath
    contextPath = [string]$contextPath
    operationOutputPath = [string]$operationOutputPath
    observedMessageCount = [int]$messageCount
    openCaseCount = [int]$openCaseCount
    deliverableCandidateCount = [int]$deliverableCandidates.Count
    pendingModerationStatusNoticeCount = [int]$pendingModerationStatusNotices.Count
    tracePath = [string]$tracePath
    lastMessagePath = [string]$lastMessagePath
  }
  Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
  return
}

$stateWriteBefore = if (Test-Path $stateFilePath) { (Get-Item $stateFilePath).LastWriteTimeUtc } else { [DateTime]::MinValue }

$prompt = Read-TextFile -Path $promptTemplatePath
$prompt = $prompt.Replace("{{CONTEXT_PATH}}", $contextPath)
$prompt = $prompt.Replace("{{STATE_FILE_PATH}}", $stateFilePath)
$prompt = $prompt.Replace("{{OPERATION_OUTPUT_PATH}}", $operationOutputPath)
$prompt = $prompt.Replace("{{NO_POST}}", ([bool]$NoPost).ToString().ToLowerInvariant())

$exitCode = 0
$failureMessage = $null
$combinedText = ""

Write-JsonFile -Path $statusPath -Data @{
  status = if ($SkipModel) { "running_skip_model" } else { "running" }
  startedAt = $startedAtUtc.ToString("o")
  noPost = [bool]$NoPost
  skipModel = [bool]$SkipModel
  stateFile = $stateFilePath
  contextPath = $contextPath
  operationOutputPath = $operationOutputPath
  codexExecutable = $codexExecutable
  codexModel = $codexModel
  tracePath = $tracePath
}

if ($SkipModel) {
  Append-RunLog "skip-model: writing empty operation proposal."
  Write-JsonFile -Path $operationOutputPath -Data @()
  $combinedText = "Skipped model rumination by explicit -SkipModel smoke mode."
} else {
  $codexArgs = @()
  $codexArgs += $codexExecArgs
  $codexArgs += @(
    "exec",
    "--ignore-user-config",
    "-m", $codexModel,
    "-c", 'approval_policy="never"',
    "-c", ("model_reasoning_effort={0}" -f (ConvertTo-Json $codexReasoningEffort -Compress)),
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--json",
    "-o", $lastMessagePath,
    "-"
  )

  $execution = Invoke-CodexExec -Executable $codexExecutable -Arguments $codexArgs -WorkingDirectory $repoRoot -InputText $prompt -TimeoutSeconds $codexTimeoutSeconds
  $exitCode = $execution.ExitCode
  $combinedText = (($execution.StdOut, $execution.StdErr) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine
}

if ([string]::IsNullOrWhiteSpace($combinedText)) {
  [System.IO.File]::WriteAllText($tracePath, "Codex rumination produced no stdout/stderr trace." + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
} else {
  [System.IO.File]::WriteAllText($tracePath, $combinedText + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

if ($exitCode -ne 0) {
  $failureMessage = if ([string]::IsNullOrWhiteSpace($combinedText)) { "Codex rumination failed with exit code $exitCode." } else { $combinedText }
  throw $failureMessage
}

if (-not (Test-Path $operationOutputPath)) {
  throw "Rumination completed without writing operation output at $operationOutputPath."
}

Append-RunLog "reading proposed operation output."
$proposedOperations = @(Normalize-ProposedRuminationOperations -Operations (Read-JsonFile -Path $operationOutputPath))
$appliedOperations = @()

Assert-SpeechPressureObligationsResolved -Obligations $speechPressureObligations -Operations $proposedOperations

Append-RunLog ("applying proposed operations: {0}" -f @($proposedOperations).Count)
foreach ($operation in $proposedOperations) {
  $operationName = Get-ObjectPropertyString -Value $operation -Name "operation"
  if ($null -eq $operation -or $null -eq $operationName) {
    continue
  }
  Assert-AllowedRuminationOperation -Operation $operation
  $appliedOperations += Apply-TypedOperation -Operation $operation
}

$observedCursorMessageId = Get-ObjectPropertyString -Value $observedCursor -Name "lastReviewedMessageId"
$observedCursorTimestamp = Get-ObjectPropertyString -Value $observedCursor -Name "lastReviewedTimestamp"
if (
  $messageCount -gt 0 -and
  $null -ne $observedCursorMessageId -and
  $null -ne $observedCursorTimestamp
) {
  Append-RunLog "recording reviewed message cursor."
  $appliedOperations += Apply-TypedOperation -Operation @{
    operation = "record_reviewed_messages"
    lastReviewedMessageId = $observedCursorMessageId
    lastReviewedTimestamp = $observedCursorTimestamp
  }
}

$repoCursorOperations = @()
$disableRepoCursorAdvance = -not [string]::IsNullOrWhiteSpace($env:VOID_RUMINATION_DISABLE_REPO_CURSOR_ADVANCE)
if (-not $NoPost -and -not $SkipModel -and -not $disableRepoCursorAdvance) {
  $repoCursorOperations = @(Get-RepoActivityCursorOperations -RepoActivity $repoActivity -ObservedAt ([DateTime]::UtcNow))
  if ($repoCursorOperations.Count -gt 0) {
    Append-RunLog ("recording repo activity cursors: {0}" -f $repoCursorOperations.Count)
    foreach ($operation in $repoCursorOperations) {
      $appliedOperations += Apply-TypedOperation -Operation $operation
    }
  }
}

$deliveredCandidateCount = 0
$deliveredModerationStatusNoticeCount = 0
if (-not $NoPost) {
  $refreshedTypedContext = Get-TypedSelfState
  $alreadyAnsweredCandidateOperations = @(Get-AlreadyAnsweredCandidateRetireOperations -TypedState $refreshedTypedContext.typedState -RetiredAt ([DateTime]::UtcNow))
  if ($alreadyAnsweredCandidateOperations.Count -gt 0) {
    Append-RunLog ("retiring already-answered queued candidates: {0}" -f $alreadyAnsweredCandidateOperations.Count)
    foreach ($operation in $alreadyAnsweredCandidateOperations) {
      $appliedOperations += Apply-TypedOperation -Operation $operation
    }
    $refreshedTypedContext = Get-TypedSelfState
  }

  $deliverableCandidates = @(Get-DeliverableCandidateInterventions -TypedState $refreshedTypedContext.typedState)
  foreach ($candidate in $deliverableCandidates) {
    if ($deliveredCandidateCount -ge 1) {
      break
    }
    $spokenOperation = Invoke-CandidateInterventionDeliveryFromIntervention -Intervention $candidate
    if ($null -ne $spokenOperation) {
      $appliedOperations += Apply-TypedOperation -Operation $spokenOperation
      Assert-SpokenCandidateApplied -InterventionId $spokenOperation.interventionId -ReceiptKey $spokenOperation.receipt.receiptKey
      $deliveredCandidateCount += 1
    }
  }

  $refreshedTypedContext = Get-TypedSelfState
  $pendingModerationStatusNotices = @(Get-PendingModerationStatusNotices -TypedState $refreshedTypedContext.typedState)
  foreach ($pendingNotice in $pendingModerationStatusNotices) {
    if ($deliveredModerationStatusNoticeCount -ge 3) {
      break
    }
    $noticeOperation = Invoke-ModerationStatusNoticeDelivery -PendingNotice $pendingNotice
    if ($null -ne $noticeOperation) {
      $appliedOperations += Apply-TypedOperation -Operation $noticeOperation
      $deliveredModerationStatusNoticeCount += 1
    }
  }
}

Append-RunLog "writing final rumination status."
$finishedAtUtc = [DateTime]::UtcNow
Append-RunLog "final status timestamp captured."
$lastMessageSummary = @(
  "Void moderation rumination finished."
  "mode=" + $(if ($SkipModel) { "typed_rumination_skip_model" } else { "typed_rumination" })
  "proposed=" + [string]@($proposedOperations).Count
  "applied=" + [string]@($appliedOperations).Count
  "deliveredCandidates=" + [string]$deliveredCandidateCount
  "deliveredModerationStatusNotices=" + [string]$deliveredModerationStatusNoticeCount
  "discordTransport=" + [string]$discordTransportMode
  "finishedAt=" + $finishedAtUtc.ToString("o")
) -join [Environment]::NewLine
[System.IO.File]::WriteAllText($lastMessagePath, $lastMessageSummary + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
$lastMessage = Get-Content -Path $lastMessagePath -Raw -Encoding UTF8
Append-RunLog "final status last message loaded."

$finalStatus = [ordered]@{
  status = "ok"
  mode = if ($SkipModel) { "typed_rumination_skip_model" } else { "typed_rumination" }
  startedAt = $startedAtUtc.ToString("o")
  finishedAt = $finishedAtUtc.ToString("o")
  durationSeconds = [Math]::Round(($finishedAtUtc - $startedAtUtc).TotalSeconds, 2)
  exitCode = [int]$exitCode
  noPost = [bool]$NoPost
  skipModel = [bool]$SkipModel
  stateFile = [string]$stateFilePath
  contextPath = [string]$contextPath
  operationOutputPath = [string]$operationOutputPath
  observedMessageCount = [int]$messageCount
  previousCursorTimestamp = [string](Get-ObjectPropertyString -Value $priorCursor -Name "lastReviewedTimestamp")
  observedCursorTimestamp = [string]$observedCursorTimestamp
  proposedOperationCount = [int]@($proposedOperations).Count
  appliedOperationCount = [int]@($appliedOperations).Count
  repoCursorOperationCount = [int]@($repoCursorOperations).Count
  deliveredCandidateCount = [int]$deliveredCandidateCount
  deliveredModerationStatusNoticeCount = [int]$deliveredModerationStatusNoticeCount
  discordTransport = [string]$discordTransportMode
  stateUpdated = [bool](@($appliedOperations).Count -gt 0)
  tracePath = [string]$tracePath
  lastMessagePath = [string]$lastMessagePath
  lastMessage = [string]$lastMessage
}
Write-JsonFile -Path $statusPath -Data $finalStatus

Append-RunLog ("mode=typed_rumination messages={0} proposed={1} applied={2} cursor={3}" -f $messageCount, @($proposedOperations).Count, @($appliedOperations).Count, $observedCursorTimestamp)
Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
