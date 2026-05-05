param(
  [switch] $NoPost
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"
$stateTemplatePath = Join-Path $repoRoot "config\moderation-agent-state-template.json"
$stateFilePath = Join-Path $repoRoot ".voidbot\private\moderation-agent-state.json"
$statusDir = Join-Path $repoRoot ".voidbot\status"
$logDir = Join-Path $repoRoot ".voidbot\logs"
$statusPath = Join-Path $statusDir "moderation-rumination.json"
$summaryLogPath = Join-Path $logDir "moderation-rumination.log"
$tracePath = Join-Path $logDir "moderation-rumination-last.jsonl"
$lastMessagePath = Join-Path $statusDir "moderation-rumination-last-message.txt"
$lockPath = Join-Path $statusDir "moderation-rumination.lock"
$mcpServerPath = Join-Path $repoRoot "apps\worker\dist\mcp-server.js"

function Read-DotEnv {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $values = @{}

  if (-not (Test-Path $Path)) {
    return $values
  }

  foreach ($line in Get-Content -Path $Path) {
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
    $value = $line.Substring($separatorIndex + 1).Trim()
    $values[$key] = $value.Trim("'`"")
  }

  return $values
}

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

  $json = $Data | ConvertTo-Json -Depth 12
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Append-RunLog {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Line
  )

  $timestamped = "[{0}] {1}" -f ([DateTime]::UtcNow.ToString("o")), $Line
  Add-Content -Path $summaryLogPath -Value $timestamped -Encoding UTF8
}

function Ensure-ModerationState {
  if (Test-Path $stateFilePath) {
    return
  }

  if (-not (Test-Path $stateTemplatePath)) {
    throw "Missing moderation state template at $stateTemplatePath"
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stateFilePath) | Out-Null
  Copy-Item -Path $stateTemplatePath -Destination $stateFilePath -Force
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

function Set-ModerationCursor {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,
    [AllowNull()] $Cursor
  )

  $state = Read-JsonFile -Path $Path

  if ($null -eq $state) {
    return
  }

  if ($null -eq $state.moderation_runtime) {
    $state | Add-Member -NotePropertyName moderation_runtime -NotePropertyValue ([pscustomobject]@{}) -Force
  }

  $state.moderation_runtime.cursor = $Cursor
  Write-JsonFile -Path $Path -Data $state
}

function Split-CommandArgs {
  param(
    [string] $Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return @()
  }

  return [regex]::Matches($Value, '("[^"]*"|''[^'']*''|\S+)') |
    ForEach-Object {
      $_.Value.Trim().Trim("'`"")
    }
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
  $startInfo.Arguments = [string]::Join(" ", ($Arguments | ForEach-Object { Quote-ProcessArgument -Value $_ }))

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo

  try {
    [void]$process.Start()
    $process.StandardInput.Write($InputText)
    $process.StandardInput.Close()

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

if (Test-Path $lockPath) {
  $lock = Get-Content -Path $lockPath -Raw | ConvertFrom-Json
  $startedAt = $null

  if ($lock.startedAt) {
    try {
      $startedAt = [DateTime]::Parse($lock.startedAt).ToUniversalTime()
    } catch {
      $startedAt = $null
    }
  }

  if ($lock.pid -and (Get-Process -Id $lock.pid -ErrorAction SilentlyContinue)) {
    if ($startedAt -and (([DateTime]::UtcNow - $startedAt).TotalMinutes -lt 20)) {
      Append-RunLog "Skipped run because PID $($lock.pid) still owns the moderation loop lock."
      Write-JsonFile -Path $statusPath -Data @{
        status = "skipped_locked"
        reason = "Previous moderation run still active."
        observedAt = [DateTime]::UtcNow.ToString("o")
        lock = $lock
      }
      exit 0
    }
  }
}

$startedAtUtc = [DateTime]::UtcNow
$envValues = Read-DotEnv -Path $envFile
$codexExecutable = if ($envValues.ContainsKey("CODEX_EXECUTABLE") -and -not [string]::IsNullOrWhiteSpace($envValues["CODEX_EXECUTABLE"])) {
  $envValues["CODEX_EXECUTABLE"]
} else {
  "codex"
}
$codexModel = if ($envValues.ContainsKey("CODEX_MODEL") -and -not [string]::IsNullOrWhiteSpace($envValues["CODEX_MODEL"])) {
  $envValues["CODEX_MODEL"]
} else {
  "gpt-5.4"
}
$codexReasoningEffort = if ($envValues.ContainsKey("CODEX_MODEL_REASONING_EFFORT") -and -not [string]::IsNullOrWhiteSpace($envValues["CODEX_MODEL_REASONING_EFFORT"])) {
  $envValues["CODEX_MODEL_REASONING_EFFORT"]
} else {
  "medium"
}
$codexExecArgs = if ($envValues.ContainsKey("CODEX_EXEC_ARGS")) {
  Split-CommandArgs -Value $envValues["CODEX_EXEC_ARGS"]
} else {
  @()
}

Ensure-ModerationState
New-Item -ItemType Directory -Force -Path $statusDir, $logDir | Out-Null

if (-not (Test-Path $mcpServerPath)) {
  throw "Missing built MCP server at $mcpServerPath. Run npm run build first."
}

$preRunState = Read-JsonFile -Path $stateFilePath
$priorCursor = if ($null -ne $preRunState -and $null -ne $preRunState.moderation_runtime) {
  $preRunState.moderation_runtime.cursor
} else {
  $null
}

$historyArgs = @("scripts/export-recent-discord-history.mjs")
if ($null -ne $priorCursor -and -not [string]::IsNullOrWhiteSpace($priorCursor.lastReviewedTimestamp)) {
  $historyArgs += @("--after", [string]$priorCursor.lastReviewedTimestamp, "--limit", "120")
} else {
  $historyArgs += @("--hours", "6", "--limit", "120")
}

$preRunHistoryJson = & node @historyArgs
if ($LASTEXITCODE -ne 0) {
  throw "Failed to poll recent Discord history before moderation run."
}

$preRunHistory = $preRunHistoryJson | ConvertFrom-Json
$observedCursor = $priorCursor

if ($null -ne $preRunHistory.messages -and $preRunHistory.messages.Count -gt 0) {
  $latestObservedMessage = $preRunHistory.messages[$preRunHistory.messages.Count - 1]
  $observedCursor = [pscustomobject]@{
    lastReviewedMessageId = $latestObservedMessage.id
    lastReviewedTimestamp = $latestObservedMessage.timestamp
  }
}

Write-JsonFile -Path $lockPath -Data @{
  pid = $PID
  startedAt = $startedAtUtc.ToString("o")
}

$stateWriteBefore = (Get-Item $stateFilePath).LastWriteTimeUtc
$prompt = @"
Perform one scheduled Void moderation-participation loop in this workspace.

Required reading before you act:
- config/moderation-review-agent.md
- config/discord-server-rules.md
- config/moderation-agent-state-template.json
- styles/void-default.md
- .voidbot/private/moderation-agent-state.json

Required operating posture:
- You are running unattended on the local workstation, not inside the Discord reply lane.
- You have VoidBot's usual workspace tools and the local voidbot MCP server available in this repo.
- Use `node scripts/export-recent-discord-history.mjs --after <timestamp> --limit 120` for chronological polling.
- If there is no saved cursor yet, use `node scripts/export-recent-discord-history.mjs --hours 6 --limit 120`.
- Use `node scripts/export-random-discord-history.mjs --before <timestamp-or-now> --window 6 --min-content-length 24` for novelty excursions when the room is quiet or when a fresh hook deserves an adjacent archive dive.
- Use `node scripts/export-recent-repo-activity.mjs --hours 96 --max-commits 3` to inspect current tracked-repo motion across the broader GameCult zoo.
- Maintain parallel analytic and associative thought lanes in `.voidbot/private/moderation-agent-state.json`, then let the bridge decide what actually deserves synthesis, speech, or cooling-off.
- Read `moderation_runtime.sleep_cycle` and honor it. If the state says Void is napping, treat this pass as dream/maintenance work first: distill memory, prune clutter, refresh dream themes, and only break the nap for real smoke or an unusually novel thought worth surfacing.
- You are the only routine local agent in this workspace with a standing cross-project view, so notice ongoing experiments, commit clusters, and weird convergences that the narrower workers cannot see.
- Treat `moderation_runtime.speaking_bias` as a live meter, not decorative metadata. If the mood drift has built up speaking pressure and a thought survives a novelty check, do not smother it out of reflex.
- When the room is quiet, use the usual VoidBot retrieval tools to think about GameCult projects and contribute ideas:
  - `search_history`
  - `get_message_context`
  - `list_indexed_repos`
  - `search_sources`
  - `get_source_context`
  - `notify_owner` when owner interruption is actually warranted
- If recent repo motion gives you a grounded observation about the ongoing work, you are allowed to say so. Be a herald, not a weather vane nailed to one porch.
- Do not keep repo-weather thoughts under glass out of reflexive politeness. If a fresh convergence across active repos survives one or two passes and still feels room-native, bias toward a concise herald note or at least a sharpened candidate intervention.
- Before withholding a thought, use semantic retrieval to check whether the room has already said it in roughly that shape. Novel thoughts should not keep dying of manners.
- Do not keep circling the same musing just because it still feels tidy. Chase at least one fresh branch when the room gives you a concrete hook, and record archive excursions so you can avoid pacing the same trench forever.
- Use the local bot-voice script `node scripts/send-discord-message.mjs ...` when you genuinely need to speak.
- Update only `.voidbot/private/moderation-agent-state.json` as routine writable memory.
- Do not edit tracked repo files during routine runs.
- Do not ask for permission. Work inside the existing workspace and tool surface.
- Be willing to ruminate on GameCult projects, archived Discord seams, repo material, and constructive conversation ideas when the room is quiet.
- Keep the state compact, valid, and worth re-reading.
"@

if ($NoPost) {
  $prompt += @"

Testing constraint for this run:
- Do not send any Discord messages or DMs.
- You may still update `.voidbot/private/moderation-agent-state.json` and use normal read/analysis tools.
"@
}

$prompt += @"

At the end:
- Print a short plain-text run summary as your final message.
"@

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

$combinedText = ""
$exitCode = 1
$failureMessage = $null

Write-JsonFile -Path $statusPath -Data @{
  status = "running"
  startedAt = $startedAtUtc.ToString("o")
  noPost = [bool]$NoPost
  repoRoot = $repoRoot
  codexExecutable = $codexExecutable
  codexModel = $codexModel
  tracePath = $tracePath
  lastMessagePath = $lastMessagePath
}

try {
  $execution = Invoke-CodexExec -Executable $codexExecutable -Arguments $codexArgs -WorkingDirectory $repoRoot -InputText $prompt
  $exitCode = $execution.ExitCode
  $combinedText = (($execution.StdOut, $execution.StdErr) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine
} catch {
  $failureMessage = $_.Exception.Message
}
$combinedText | Set-Content -Path $tracePath -Encoding UTF8

$finishedAtUtc = [DateTime]::UtcNow
$stateUpdated = $false

if ($exitCode -eq 0) {
  Set-ModerationCursor -Path $stateFilePath -Cursor $observedCursor
}

$stateWriteAfter = (Get-Item $stateFilePath).LastWriteTimeUtc
$stateUpdated = ($stateWriteAfter -gt $stateWriteBefore)
$lastMessage = if (Test-Path $lastMessagePath) { Get-Content -Path $lastMessagePath -Raw } else { "" }

Write-JsonFile -Path $statusPath -Data @{
  status = if ($exitCode -eq 0) { "ok" } else { "failed" }
  startedAt = $startedAtUtc.ToString("o")
  finishedAt = $finishedAtUtc.ToString("o")
  durationSeconds = [Math]::Round(($finishedAtUtc - $startedAtUtc).TotalSeconds, 2)
  exitCode = $exitCode
  failureMessage = $failureMessage
  noPost = [bool]$NoPost
  stateFile = $stateFilePath
  stateWriteBeforeUtc = $stateWriteBefore.ToString("o")
  stateWriteAfterUtc = $stateWriteAfter.ToString("o")
  stateUpdated = $stateUpdated
  tracePath = $tracePath
  lastMessagePath = $lastMessagePath
  lastMessage = $lastMessage.Trim()
}

Append-RunLog ("exit={0} stateUpdated={1} summary={2}" -f $exitCode, $stateUpdated, ($lastMessage.Trim()))

Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue

if ($exitCode -ne 0) {
  if ($failureMessage) {
    throw "Void moderator rumination failed with exit code $exitCode. $failureMessage"
  }

  throw "Void moderator rumination failed with exit code $exitCode."
}
