param(
  [string] $StateFilePath,
  [switch] $SkipModel,
  [switch] $ForceDistillation
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
$statusDir = if (-not [string]::IsNullOrWhiteSpace($env:VOID_MEMORY_MAINTENANCE_STATUS_DIR)) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:VOID_MEMORY_MAINTENANCE_STATUS_DIR)
} else {
  Join-Path $repoRoot ".voidbot\status"
}
$logDir = if (-not [string]::IsNullOrWhiteSpace($env:VOID_MEMORY_MAINTENANCE_LOG_DIR)) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:VOID_MEMORY_MAINTENANCE_LOG_DIR)
} else {
  Join-Path $repoRoot ".voidbot\logs"
}
$statusPath = Join-Path $statusDir "void-memory-maintenance.json"
$summaryLogPath = Join-Path $logDir "void-memory-maintenance.log"
$lastMessagePath = Join-Path $statusDir "void-memory-maintenance-last-message.txt"
$operationOutputPath = Join-Path $statusDir "void-memory-maintenance-operations.json"
$contextPath = Join-Path $statusDir "void-memory-maintenance-context.json"
$lockPath = Join-Path $statusDir "void-memory-maintenance.lock"
$moderationLockPath = Join-Path $statusDir "moderation-rumination.lock"
$promptTemplatePath = Join-Path $repoRoot "prompts\void-memory-maintenance.md"
$contextProjectionScriptPath = Join-Path $repoRoot "scripts\lib\void-rumination-context-projection.ps1"
$selfStateScriptPath = Join-Path $repoRoot "scripts\void-self-state.mjs"
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
  param([Parameter(Mandatory = $true)][string] $Path)

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
  param([Parameter(Mandatory = $true)][string] $Path)
  return Get-Content -Path $Path -Raw -Encoding UTF8
}

function Append-RunLog {
  param([Parameter(Mandatory = $true)][string] $Line)
  $timestamped = "[{0}] {1}" -f ([DateTime]::UtcNow.ToString("o")), $Line
  Add-Content -Path $summaryLogPath -Value $timestamped -Encoding UTF8
}

function Read-DotEnv {
  param([Parameter(Mandatory = $true)][string] $Path)

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
  param([string] $Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return @()
  }

  return [regex]::Matches($Value, '("[^"]*"|''[^'']*''|\S+)') |
    ForEach-Object { $_.Value.Trim().Trim("'`"") }
}

function Quote-ProcessArgument {
  param([Parameter(Mandatory = $true)][string] $Value)

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
      throw "Codex memory maintenance exceeded timeout of $TimeoutSeconds seconds."
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

function Invoke-NodeJson {
  param([Parameter(Mandatory = $true)][string[]] $Arguments)

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
  console.log(JSON.stringify({ typedState, summary: context?.summary ?? '' }));
}).catch((error) => { console.error(error); process.exit(1); });
"@
  $output = & node -e $script $stateFilePath
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to read typed self-state."
  }
  return $output | ConvertFrom-Json
}

function Apply-TypedOperation {
  param([Parameter(Mandatory = $true)] $Operation)

  $operationInputPath = Join-Path $statusDir ("void-memory-maintenance-operation-{0}.json" -f ([Guid]::NewGuid().ToString("n")))
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

function Assert-TypedOperationSchema {
  param([Parameter(Mandatory = $true)] $Operation)

  $operationInputPath = Join-Path $statusDir ("void-memory-maintenance-validate-operation-{0}.json" -f ([Guid]::NewGuid().ToString("n")))
  Write-JsonFile -Path $operationInputPath -Data $Operation

  try {
    $script = @"
const { readFileSync } = require('node:fs');
const core = require('./packages/core/dist');
const operation = JSON.parse(readFileSync(process.argv[1], 'utf8'));
core.voidSelfStateOperationSchema.parse(operation);
console.log(JSON.stringify({ ok: true }));
"@
    $output = & node -e $script $operationInputPath 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Typed operation failed schema validation: $output"
    }
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

function Assert-AllowedMemoryMaintenanceOperation {
  param($Operation)

  $operationName = Get-ObjectPropertyString -Value $Operation -Name "operation"
  $allowed = @(
    "merge_incubation_support",
    "queue_candidate_intervention",
    "retire_candidate_intervention",
    "upsert_agency_pressure",
    "retire_agency_pressure",
    "upsert_affect_need",
    "retire_affect_need",
    "upsert_social_bond",
    "retire_social_bond",
    "upsert_status_read",
    "retire_status_read",
    "update_mood_dimensions",
    "propose_memory_distillation",
    "apply_memory_distillation",
    "revise_durable_memory",
    "retire_durable_memory",
    "crystallize_memory_into_identity",
    "prune_short_term_memories"
  )

  if ($null -eq $operationName -or -not $allowed.Contains($operationName)) {
    throw "Memory maintenance proposed disallowed operation '$operationName'."
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
    skipModel = [bool]$SkipModel
    stateFile = $stateFilePath
    contextPath = $contextPath
    operationOutputPath = $operationOutputPath
  }

  Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
  throw
}

New-Item -ItemType Directory -Force -Path $statusDir, $logDir, (Split-Path -Parent $stateFilePath) | Out-Null

$maxRuntimeMinutes = if (-not [string]::IsNullOrWhiteSpace($env:VOID_MEMORY_MAINTENANCE_MAX_RUNTIME_MINUTES)) {
  [int]$env:VOID_MEMORY_MAINTENANCE_MAX_RUNTIME_MINUTES
} else {
  15
}

if (Test-Path $moderationLockPath) {
  $moderationLock = Read-JsonFile -Path $moderationLockPath
  $moderationProcessAlive = Test-LockProcessAlive -LockRecord $moderationLock
  if ($moderationProcessAlive) {
    Write-JsonFile -Path $statusPath -Data @{
      status = "skipped"
      reason = if (Test-LockWithinRuntimeLimit -LockRecord $moderationLock -MaxRuntimeMinutes $maxRuntimeMinutes) { "moderation_loop_active" } else { "moderation_loop_over_runtime_active" }
      observedAt = ([DateTime]::UtcNow.ToString("o"))
      stateFile = $stateFilePath
      moderationLockPath = $moderationLockPath
      maxRuntimeMinutes = $maxRuntimeMinutes
      pid = Get-ObjectPropertyValue -Value $moderationLock -Name "pid"
      startedAt = Get-ObjectPropertyString -Value $moderationLock -Name "startedAt"
    }
    return
  }
  Remove-Item -LiteralPath $moderationLockPath -Force
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

foreach ($requiredPath in @($contextProjectionScriptPath, $selfStateScriptPath, $promptTemplatePath)) {
  if (-not (Test-Path $requiredPath)) {
    throw "Missing required helper at $requiredPath"
  }
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
$codexSandbox = if (-not [string]::IsNullOrWhiteSpace($env:VOID_MEMORY_MAINTENANCE_CODEX_SANDBOX)) {
  $env:VOID_MEMORY_MAINTENANCE_CODEX_SANDBOX
} elseif ($envValues.ContainsKey("VOID_MEMORY_MAINTENANCE_CODEX_SANDBOX") -and -not [string]::IsNullOrWhiteSpace($envValues["VOID_MEMORY_MAINTENANCE_CODEX_SANDBOX"])) {
  $envValues["VOID_MEMORY_MAINTENANCE_CODEX_SANDBOX"]
} else {
  "workspace-write"
}
$codexTimeoutSeconds = if (-not [string]::IsNullOrWhiteSpace($env:VOID_MEMORY_MAINTENANCE_CODEX_TIMEOUT_SECONDS)) {
  [int]$env:VOID_MEMORY_MAINTENANCE_CODEX_TIMEOUT_SECONDS
} elseif ($envValues.ContainsKey("VOID_MEMORY_MAINTENANCE_CODEX_TIMEOUT_SECONDS") -and -not [string]::IsNullOrWhiteSpace($envValues["VOID_MEMORY_MAINTENANCE_CODEX_TIMEOUT_SECONDS"])) {
  [int]$envValues["VOID_MEMORY_MAINTENANCE_CODEX_TIMEOUT_SECONDS"]
} else {
  [Math]::Max(60, $maxRuntimeMinutes * 60)
}

$typedContext = Get-TypedSelfState
$typedState = $typedContext.typedState
$isSleepMaintenance = [bool]$ForceDistillation -or [bool]$typedState.scheduledRuntime.sleepCycle.isNapping
$shortTermMemoryCount = @(Convert-ToValueArray -Value $typedState.thoughtMemory.shortTerm).Count
$longTermMemoryCount = @(Convert-ToValueArray -Value $typedState.thoughtMemory.memories).Count
$incubationCount = @(Convert-ToValueArray -Value $typedState.thoughtMemory.incubation).Count
$activeAgencyPressureCount = @(
  @(Convert-ToValueArray -Value $typedState.agencyPressure.pressures) |
    Where-Object {
      $status = Get-ObjectPropertyString -Value $_ -Name "status"
      $status -eq "active" -or $status -eq "cooling" -or $status -eq "ready_to_act"
    }
).Count
$activeCandidateCount = @(
  @(Convert-ToValueArray -Value $typedState.candidateInterventions.interventions) |
    Where-Object {
      $status = Get-ObjectPropertyString -Value $_ -Name "status"
      $status -eq "queued" -or $status -eq "deferred"
    }
).Count
$maintenancePressure = $shortTermMemoryCount + $incubationCount + $activeAgencyPressureCount + $activeCandidateCount

Write-JsonFile -Path $contextPath -Data @{
  generated = "now"
  stateFile = $stateFilePath
  selfStateSummary = $typedContext.summary
  mode = if ($isSleepMaintenance) { "sleep_maintenance" } else { "awake_memory_maintenance" }
  maintenanceBoundary = "This pass may propose only typed memory/incubation/candidate operations. Exact timestamps stay in typed state; prompt-facing chronology uses relative phrases."
  sleepDirective = @{
    forceDistillation = [bool]($isSleepMaintenance -and $maintenancePressure -gt 0)
    maintenancePressure = [int]$maintenancePressure
    shortTermMemoryCount = [int]$shortTermMemoryCount
    longTermMemoryCount = [int]$longTermMemoryCount
    incubationCount = [int]$incubationCount
    activeAgencyPressureCount = [int]$activeAgencyPressureCount
    activeCandidateCount = [int]$activeCandidateCount
    rule = "During sleep, yesterday's rumination residue must be pruned or compressed. Return [] only when the typed surfaces are already minimal or no meaning-preserving operation is possible."
  }
  shortTermMemories = @(Project-MemoriesForRumination -Memories $typedState.thoughtMemory.shortTerm -Now $startedAtUtc)
  memories = @(Project-MemoriesForRumination -Memories $typedState.thoughtMemory.memories -Now $startedAtUtc)
  incubation = @(Project-IncubationForRumination -Threads $typedState.thoughtMemory.incubation -Now $startedAtUtc)
  agencyPressure = @(Project-AgencyPressureForRumination -Pressures $typedState.agencyPressure.pressures -Now $startedAtUtc)
  candidateInterventions = @(Project-InterventionsForRumination -Interventions $typedState.candidateInterventions.interventions -Now $startedAtUtc)
  scheduledRuntime = Project-ScheduledRuntimeForRumination -Runtime $typedState.scheduledRuntime -Now $startedAtUtc
  speechReceipts = @(Project-SpeechReceiptsForRumination -Receipts $typedState.speechReceipts.recentReceipts -Now $startedAtUtc)
}

$prompt = Read-TextFile -Path $promptTemplatePath
$prompt = $prompt.Replace("{{CONTEXT_PATH}}", $contextPath)
$prompt = $prompt.Replace("{{STATE_FILE_PATH}}", $stateFilePath)
$prompt = $prompt.Replace("{{OPERATION_OUTPUT_PATH}}", $operationOutputPath)

$exitCode = 0
$combinedText = ""

Write-JsonFile -Path $statusPath -Data @{
  status = if ($SkipModel) { "running_skip_model" } else { "running" }
  startedAt = $startedAtUtc.ToString("o")
  skipModel = [bool]$SkipModel
  forceDistillation = [bool]$ForceDistillation
  stateFile = $stateFilePath
  contextPath = $contextPath
  operationOutputPath = $operationOutputPath
  codexExecutable = $codexExecutable
  codexModel = $codexModel
}

if ($SkipModel) {
  Append-RunLog "skip-model: writing empty memory-maintenance proposal."
  Write-JsonFile -Path $operationOutputPath -Data @()
  $combinedText = "Skipped model memory maintenance by explicit -SkipModel smoke mode."
} else {
  $codexArgs = @()
  $codexArgs += $codexExecArgs
  $codexArgs += @(
    "exec",
    "--ignore-user-config",
    "-m", $codexModel,
    "-c", 'approval_policy="never"',
    "-c", ("model_reasoning_effort={0}" -f (ConvertTo-Json $codexReasoningEffort -Compress)),
    "-s", $codexSandbox,
    "--skip-git-repo-check",
    "--json",
    "-o", $lastMessagePath,
    "-"
  )

  $execution = Invoke-CodexExec -Executable $codexExecutable -Arguments $codexArgs -WorkingDirectory $statusDir -InputText $prompt -TimeoutSeconds $codexTimeoutSeconds
  $exitCode = $execution.ExitCode
  $combinedText = (($execution.StdOut, $execution.StdErr) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine
}

if ($exitCode -ne 0) {
  throw $(if ([string]::IsNullOrWhiteSpace($combinedText)) { "Codex memory maintenance failed with exit code $exitCode." } else { $combinedText })
}

if (-not (Test-Path $operationOutputPath)) {
  throw "Memory maintenance completed without writing operation output at $operationOutputPath."
}

$proposedOperations = @(Convert-ToOperationArray -Value (Read-JsonFile -Path $operationOutputPath))
$appliedOperations = @()

if ((-not $SkipModel) -and $isSleepMaintenance -and $maintenancePressure -gt 0 -and @($proposedOperations).Count -eq 0) {
  throw "Sleep memory maintenance returned no operations despite maintenance pressure $maintenancePressure."
}

foreach ($operation in $proposedOperations) {
  Assert-AllowedMemoryMaintenanceOperation -Operation $operation
  Assert-TypedOperationSchema -Operation $operation
}

foreach ($operation in $proposedOperations) {
  $appliedOperations += Apply-TypedOperation -Operation $operation
}

if ((-not $SkipModel) -and $isSleepMaintenance) {
  $refreshedTypedState = Get-TypedSelfState
  $remainingShortTermCount = @(Convert-ToValueArray -Value $refreshedTypedState.typedState.thoughtMemory.shortTerm).Count
  if ($remainingShortTermCount -gt 0) {
    throw "Sleep memory maintenance left $remainingShortTermCount short-term memories unpromoted."
  }
}

$finishedAtUtc = [DateTime]::UtcNow
$lastMessage = if (Test-Path $lastMessagePath) { Get-Content -Path $lastMessagePath -Raw -Encoding UTF8 } else { "" }

Write-JsonFile -Path $statusPath -Data @{
  status = "ok"
  mode = if ($SkipModel) { "typed_memory_maintenance_skip_model" } else { "typed_memory_maintenance" }
  startedAt = $startedAtUtc.ToString("o")
  finishedAt = $finishedAtUtc.ToString("o")
  durationSeconds = [Math]::Round(($finishedAtUtc - $startedAtUtc).TotalSeconds, 2)
  exitCode = [int]$exitCode
  skipModel = [bool]$SkipModel
  forceDistillation = [bool]$ForceDistillation
  stateFile = [string]$stateFilePath
  contextPath = [string]$contextPath
  operationOutputPath = [string]$operationOutputPath
  proposedOperationCount = [int]@($proposedOperations).Count
  appliedOperationCount = [int]@($appliedOperations).Count
  stateUpdated = [bool](@($appliedOperations).Count -gt 0)
  lastMessagePath = [string]$lastMessagePath
}

Append-RunLog ("mode=typed_memory_maintenance proposed={0} applied={1}" -f @($proposedOperations).Count, @($appliedOperations).Count)
Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
