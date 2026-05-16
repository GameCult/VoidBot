param(
  [switch] $NoPost,
  [switch] $SkipModel
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$stateFilePath = Join-Path $repoRoot ".voidbot\private\void-self-state.cc"
$statusDir = Join-Path $repoRoot ".voidbot\status"
$logDir = Join-Path $repoRoot ".voidbot\logs"
$statusPath = Join-Path $statusDir "moderation-rumination.json"
$summaryLogPath = Join-Path $logDir "moderation-rumination.log"
$tracePath = Join-Path $logDir "moderation-rumination-last.jsonl"
$lastMessagePath = Join-Path $statusDir "moderation-rumination-last-message.txt"
$operationOutputPath = Join-Path $statusDir "moderation-rumination-operations.json"
$contextPath = Join-Path $statusDir "moderation-rumination-context.json"
$lockPath = Join-Path $statusDir "moderation-rumination.lock"
$promptTemplatePath = Join-Path $repoRoot "prompts\void-moderator-rumination.md"
$recentHistoryScriptPath = Join-Path $repoRoot "scripts\export-recent-discord-history.mjs"
$repoActivityScriptPath = Join-Path $repoRoot "scripts\export-recent-repo-activity.mjs"
$selfStateScriptPath = Join-Path $repoRoot "scripts\void-self-state.mjs"
$startedAtUtc = [DateTime]::UtcNow

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
    [string] $InputText
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

    $process.WaitForExit()
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

  $operationJson = $Operation | ConvertTo-Json -Compress -Depth 32
  return Invoke-NodeJson -Arguments @(
    $selfStateScriptPath,
    "apply-operation",
    "--canonical", $stateFilePath,
    "--operation", $operationJson
  )
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

function Get-ObjectPropertyString {
  param(
    $Value,
    [Parameter(Mandatory = $true)]
    [string] $Name
  )

  if ($null -eq $Value) {
    return $null
  }

  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $null
  }

  $text = [string]$property.Value
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $null
  }
  return $text
}

function Convert-LastSpeechToReceiptOperation {
  param($Speech)

  $sentAt = Get-ObjectPropertyString -Value $Speech -Name "sentAt"
  if ($null -eq $Speech -or $null -eq $sentAt) {
    return $null
  }

  $receiptKeyParts = @(
    "speech",
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

function Select-RuminationRepoActivity {
  param($RepoActivity)

  if ($null -eq $RepoActivity) {
    return $null
  }

  $reposProperty = $RepoActivity.PSObject.Properties["repos"]
  $repos = if ($null -ne $reposProperty -and $null -ne $reposProperty.Value) { @($reposProperty.Value) } else { @() }
  $freshRepos = @(
    $repos |
      Where-Object {
        $recent = $_.PSObject.Properties["recentCommitCount"]
        $status = $_.PSObject.Properties["status"]
        $null -ne $recent -and $null -ne $status -and [string]$status.Value -eq "ok" -and [int]$recent.Value -gt 0
      } |
      Select-Object -First 8
  )

  return @{
    generatedAt = Get-ObjectPropertyString -Value $RepoActivity -Name "generatedAt"
    cursorMode = Get-ObjectPropertyString -Value $RepoActivity -Name "cursorMode"
    digest = Get-ObjectPropertyString -Value $RepoActivity -Name "digest"
    freshRepos = $freshRepos
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

if (Test-Path $lockPath) {
  $lockAge = [DateTime]::UtcNow - (Get-Item $lockPath).LastWriteTimeUtc
  if ($lockAge.TotalMinutes -lt 20) {
    Write-JsonFile -Path $statusPath -Data @{
      status = "skipped"
      reason = "lock_present"
      observedAt = ([DateTime]::UtcNow.ToString("o"))
      stateFile = $stateFilePath
    }
    return
  }
  Remove-Item -LiteralPath $lockPath -Force
}

Write-JsonFile -Path $lockPath -Data @{
  pid = $PID
  startedAt = $startedAtUtc.ToString("o")
}

if (Test-Path $operationOutputPath) {
  Remove-Item -LiteralPath $operationOutputPath -Force
}

foreach ($requiredPath in @($recentHistoryScriptPath, $repoActivityScriptPath, $selfStateScriptPath)) {
  if (-not (Test-Path $requiredPath)) {
    throw "Missing required helper at $requiredPath"
  }
}
if (-not (Test-Path $promptTemplatePath)) {
  throw "Missing rumination prompt template at $promptTemplatePath"
}

$envValues = Read-DotEnv -Path (Join-Path $repoRoot ".env")
$codexExecutable = if ($envValues.ContainsKey("CODEX_EXECUTABLE") -and -not [string]::IsNullOrWhiteSpace($envValues["CODEX_EXECUTABLE"])) { $envValues["CODEX_EXECUTABLE"] } else { "codex" }
$codexModel = if ($envValues.ContainsKey("CODEX_MODEL") -and -not [string]::IsNullOrWhiteSpace($envValues["CODEX_MODEL"])) { $envValues["CODEX_MODEL"] } else { "gpt-5.4" }
$codexReasoningEffort = if ($envValues.ContainsKey("CODEX_MODEL_REASONING_EFFORT") -and -not [string]::IsNullOrWhiteSpace($envValues["CODEX_MODEL_REASONING_EFFORT"])) { $envValues["CODEX_MODEL_REASONING_EFFORT"] } else { "medium" }
$codexExecArgs = if ($envValues.ContainsKey("CODEX_EXEC_ARGS")) { Split-CommandArgs -Value $envValues["CODEX_EXEC_ARGS"] } else { @() }

$typedContext = Get-TypedSelfState
$typedState = $typedContext.typedState
$priorCursor = $typedState.moderationCursor

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

Write-JsonFile -Path $contextPath -Data @{
  generatedAt = [DateTime]::UtcNow.ToString("o")
  stateFile = $stateFilePath
  noPost = [bool]$NoPost
  selfStateSummary = $typedContext.summary
  openCases = $typedState.moderationCursor.openCases
  speechReceipts = $typedState.speechReceipts.recentReceipts
  memories = $typedState.thoughtMemory.memories
  incubation = $typedState.thoughtMemory.incubation
  candidateInterventions = $typedState.candidateInterventions.interventions
  scheduledRuntime = $typedState.scheduledRuntime
  priorCursor = @{
    lastReviewedMessageId = Get-ObjectPropertyString -Value $priorCursor -Name "lastReviewedMessageId"
    lastReviewedTimestamp = Get-ObjectPropertyString -Value $priorCursor -Name "lastReviewedTimestamp"
  }
  observedCursor = @{
    lastReviewedMessageId = Get-ObjectPropertyString -Value $observedCursor -Name "lastReviewedMessageId"
    lastReviewedTimestamp = Get-ObjectPropertyString -Value $observedCursor -Name "lastReviewedTimestamp"
  }
  recentHistory = $history
  repoActivity = Select-RuminationRepoActivity -RepoActivity $repoActivity
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

  $execution = Invoke-CodexExec -Executable $codexExecutable -Arguments $codexArgs -WorkingDirectory $repoRoot -InputText $prompt
  $exitCode = $execution.ExitCode
  $combinedText = (($execution.StdOut, $execution.StdErr) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine
}

if ($exitCode -ne 0) {
  $failureMessage = if ([string]::IsNullOrWhiteSpace($combinedText)) { "Codex rumination failed with exit code $exitCode." } else { $combinedText }
  throw $failureMessage
}

if (-not (Test-Path $operationOutputPath)) {
  throw "Rumination completed without writing operation output at $operationOutputPath."
}

Append-RunLog "reading proposed operation output."
$proposedOperations = @(Convert-ToOperationArray -Value (Read-JsonFile -Path $operationOutputPath))
$appliedOperations = @()

Append-RunLog ("applying proposed operations: {0}" -f @($proposedOperations).Count)
foreach ($operation in $proposedOperations) {
  $operationName = Get-ObjectPropertyString -Value $operation -Name "operation"
  if ($null -eq $operation -or $null -eq $operationName) {
    continue
  }
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

$lastSpeechPath = Join-Path $statusDir "void-last-speech.json"
if ((-not $NoPost) -and (Test-Path $lastSpeechPath)) {
  $speech = Read-JsonFile -Path $lastSpeechPath
  $receiptOperation = Convert-LastSpeechToReceiptOperation -Speech $speech
  if ($null -ne $receiptOperation) {
    $appliedOperations += Apply-TypedOperation -Operation $receiptOperation
  }
}

Append-RunLog "writing final rumination status."
$finishedAtUtc = [DateTime]::UtcNow
Append-RunLog "final status timestamp captured."
$lastMessage = if (Test-Path $lastMessagePath) { Get-Content -Path $lastMessagePath -Raw -Encoding UTF8 } else { "" }
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
  stateUpdated = [bool](@($appliedOperations).Count -gt 0)
  tracePath = [string]$tracePath
  lastMessagePath = [string]$lastMessagePath
}
Write-JsonFile -Path $statusPath -Data $finalStatus

Append-RunLog ("mode=typed_rumination messages={0} proposed={1} applied={2} cursor={3}" -f $messageCount, @($proposedOperations).Count, @($appliedOperations).Count, $observedCursorTimestamp)
Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
