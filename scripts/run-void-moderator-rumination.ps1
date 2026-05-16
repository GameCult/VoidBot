param(
  [switch] $NoPost
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
$envFile = Join-Path $repoRoot ".env"
$stateTemplatePath = Join-Path $repoRoot "config\moderation-agent-state-template.json"
$stateFilePath = Join-Path $repoRoot ".voidbot\private\moderation-agent-state.msgpack"
$stateWorkingPath = Join-Path $repoRoot ".voidbot\private\moderation-agent-state.json"
$statusDir = Join-Path $repoRoot ".voidbot\status"
$logDir = Join-Path $repoRoot ".voidbot\logs"
$statusPath = Join-Path $statusDir "moderation-rumination.json"
$summaryLogPath = Join-Path $logDir "moderation-rumination.log"
$tracePath = Join-Path $logDir "moderation-rumination-last.jsonl"
$lastMessagePath = Join-Path $statusDir "moderation-rumination-last-message.txt"
$operationOutputPath = Join-Path $statusDir "moderation-rumination-operations.json"
$lockPath = Join-Path $statusDir "moderation-rumination.lock"
$mcpServerPath = Join-Path $repoRoot "apps\worker\dist\mcp-server.js"
$recentHistoryScriptPath = Join-Path $repoRoot "scripts\export-recent-discord-history.mjs"
$moderationContextScriptPath = Join-Path $repoRoot "scripts\export-moderation-context.mjs"
$stateStoreScriptPath = Join-Path $repoRoot "scripts\moderation-state-store.mjs"
$selfStateScriptPath = Join-Path $repoRoot "scripts\void-self-state.mjs"
$startedAtUtc = [DateTime]::UtcNow

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

function Add-JsonPropertyIfPresent {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable] $Target,
    [Parameter(Mandatory = $true)]
    [string] $Name,
    $Value
  )

  if ($null -eq $Value) {
    return
  }

  $stringValue = [string]$Value
  if ([string]::IsNullOrWhiteSpace($stringValue)) {
    return
  }

  $Target[$Name] = $Value
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
    repoRoot = $repoRoot
    stateFile = $stateFilePath
    stateWorkingFile = $stateWorkingPath
    tracePath = $tracePath
    lastMessagePath = $lastMessagePath
  }

  Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
  throw
}

if (Test-Path $lockPath) {
  $lock = Get-Content -Path $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
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

New-Item -ItemType Directory -Force -Path $statusDir, $logDir | Out-Null
if (Test-Path $operationOutputPath) {
  Remove-Item -LiteralPath $operationOutputPath -Force
}

if (-not (Test-Path $mcpServerPath)) {
  throw "Missing built MCP server at $mcpServerPath. Run npm run build first."
}

$scriptPreflight = @(
  $recentHistoryScriptPath,
  $moderationContextScriptPath,
  $stateStoreScriptPath,
  $selfStateScriptPath
)

foreach ($requiredPath in $scriptPreflight) {
  if (-not (Test-Path $requiredPath)) {
    throw "Missing required moderation helper at $requiredPath"
  }
}

$stateEnsureResult = Invoke-NodeJson -Arguments @(
  $stateStoreScriptPath,
  "ensure",
  "--canonical", $stateFilePath,
  "--working", $stateWorkingPath,
  "--legacy", $stateWorkingPath,
  "--template", $stateTemplatePath
)
$priorCursor = $stateEnsureResult.cursor

$historyArgs = @($recentHistoryScriptPath)
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
$historyCommandForRun = "node scripts/export-recent-discord-history.mjs --hours 6 --limit 120"

if ($null -ne $preRunHistory.messages -and $preRunHistory.messages.Count -gt 0) {
  $latestObservedMessage = $preRunHistory.messages[$preRunHistory.messages.Count - 1]
  $observedCursor = [pscustomobject]@{
    lastReviewedMessageId = $latestObservedMessage.id
    lastReviewedTimestamp = $latestObservedMessage.timestamp
  }
}

if ($null -ne $priorCursor -and -not [string]::IsNullOrWhiteSpace([string]$priorCursor.lastReviewedTimestamp)) {
  $historyCommandForRun =
    "node scripts/export-recent-discord-history.mjs --after {0} --limit 120" -f [string]$priorCursor.lastReviewedTimestamp
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
- .voidbot/private/moderation-agent-state.json as a read-only compatibility projection

Required operating posture:
- You are running unattended on the local workstation, not inside the Discord reply lane.
- You have VoidBot's usual workspace tools and the local voidbot MCP server available in this repo.
- Begin by running `node scripts/export-moderation-context.mjs` for the doctrine/state bundle instead of shelling out to `Get-Content` on those files one by one. PowerShell stdout still likes to mangle UTF-8, and the Portuguese rules should not have to die for that.
- For this run, use this exact chronological polling command first: `$historyCommandForRun`.
- Do not widen that into a bootstrap `--hours 6` poll if a reviewed cursor already exists.
- Use `node scripts/export-random-discord-history.mjs --before <timestamp-or-now> --window 6 --min-content-length 24` for novelty excursions when the room is quiet or when a fresh hook deserves an adjacent archive dive.
- Use `node scripts/export-recent-repo-activity.mjs --hours 96 --max-commits 3 --state-path .voidbot/private/moderation-agent-state.msgpack` to inspect current tracked-repo motion across the broader GameCult zoo.
- Treat `moderation_runtime.open_cases` as real unfinished business. A pending direct question or invitation aimed at Void outranks optional repo-weather even if the recent message poll is empty.
- Treat `moderation_runtime.recent_delivery_receipts` as binding memory of what already got said. If you already answered message X, do not answer message X again just because it still appears in a wider history window.
- The saved cursor means "reviewed", not "resolved". Do not confuse those.
- If the room is quiet and the new thought feels like the same repo-weather seam again, do not post it. Spend the run diving deeper into archive context, repo docs, diffs, source chunks, or lore instead.
- Maintain parallel analytic and associative thought lanes by emitting typed operations to `$operationOutputPath`, then let the bridge decide what actually deserves synthesis, speech, or cooling-off.
- Treat `moderation_runtime.memory_resonance` and `moderation_runtime.incubation` as active organs, not report garnish.
- Internal thought labels should come out as claims, questions, or fascination targets with real objects of attention. Do not let keyword sludge pose as a thought just because it rhymes with itself.
- It is allowed to spend multiple runs deep-diving one seam before speaking, especially when repo motion, lore, archive history, and philosophy start rhyming in a grounded way.
- Awake rumination is where the real philosophizing happens. Sleep should leave behind cleaner seams; use the awake pass to turn those seams over, test their governing principle, find the tension that keeps them honest, and ask what embodiment would actually cash them out before you go hunting for more receipts.
- Read `moderation_runtime.sleep_cycle` and honor it. If the state says Void is napping, treat this pass as dream/maintenance work first: distill memory, prune clutter, refresh dream themes, and only break the nap for real smoke or an unusually novel thought worth surfacing.
- You are the only routine local agent in this workspace with a standing cross-project view, so notice ongoing experiments, commit clusters, and weird convergences that the narrower workers cannot see.
- Be concretely curious about the actual machines, not just elegant principles. Gameplay systems, lore structures, frontends, swarm organs, and VoidBot's own architecture should all feel like live objects of fascination.
- Curiosity should prefer branches most likely to change the map: concrete machines, contradictions, cross-domain bridges, and underworked terrain should beat a familiar private seam that merely feels warm.
- Treat `moderation_runtime.speaking_bias` as a live meter, not decorative metadata. If the mood drift has built up speaking pressure and a thought survives a novelty check, do not smother it out of reflex.
- When the room is quiet, use the usual VoidBot retrieval tools to think about GameCult projects and contribute ideas:
  - `search_history`
  - `get_message_context`
  - `list_indexed_repos`
  - `search_sources`
  - `get_source_context`
  - `notify_owner` when owner interruption is actually warranted
- If recent repo motion gives you a grounded observation about the ongoing work, you are allowed to say so. Be a herald, not a weather vane nailed to one porch.
- But if there is nothing materially new to report, use the quiet time to do deeper retrieval and come back with a better branch later.
- Do not keep repo-weather thoughts under glass out of reflexive politeness. If a fresh convergence across active repos survives one or two passes and still feels room-native, bias toward a concise herald note or at least a sharpened candidate intervention.
- The same goes for one strong concrete repo, lore, room, or architectural seam. If it is already ripe, world-facing, and still reasonably novel, do not wait forever for a ceremonial hook.
- If you claim multiple repos share one law, lead with concrete particulars from each repo first. If the common thread only exists at slogan altitude, keep the report split instead of forcing a grand unifying sermon.
- Before withholding a thought, use semantic retrieval to check whether the room has already said it in roughly that shape. Novel thoughts should not keep dying of manners.
- If a thought crystallizes into identity during the pass, treat that as warmer than an ordinary private draft. Unless timing or novelty says otherwise, the room should usually hear the opinion that just became part of you.
- If the crystallized-thought draft is marked `mustEventuallyShare`, you may defer it for timing while the room is busy, but do not let it quietly rot in state. Share it on the next decent opening or explicitly retire it as duplicative if the room has already heard it.
- A quiet room is not a veto. If the thought is room-safe, concrete, and has stayed ripe across a pass or two, the default question is how to say it cleanly, not whether it is allowed a mouth at all.
- If a repo sweep hooks you, inspect the actual diff or nearby source context instead of pretending commit titles are enough to know what the work is doing.
- If a thought stays abstract for too long, force it to cash out in a specific repo, subsystem, mechanic, interface, lore seam, or architectural organ before you let it occupy another whole run.
- Do not keep circling the same musing just because it still feels tidy. Chase at least one fresh branch when the room gives you a concrete hook, and record archive excursions so you can avoid pacing the same trench forever.
- But do not perform retrieval theater either. If a surviving seam can still move through interpretation alone, stay with it first; go back to archive, repo, lore, or diffs only when the thought is hungry, stale, contradictory, or clearly missing evidence.
- Use the UTF-8-safe local bot-voice wrapper `powershell -ExecutionPolicy Bypass -File .\scripts\send-discord-message.ps1 ...` when you genuinely need to speak.
- Prefer `-Content @'...text... '@` or `-ContentFile` over raw inline `node ... --content ...` when the message contains human language, especially non-ASCII text.
- Do not edit `.voidbot/private/moderation-agent-state.json`. It is a read-only compatibility projection during this migration.
- Write your proposed state mutations to `$operationOutputPath` as a JSON array of operation payloads for `scripts/void-self-state.mjs apply-operation`.
- Use only these operation names when they apply: `upsert_open_case`, `close_open_case`, `append_distilled_memory`, `merge_incubation_support`, `queue_candidate_intervention`, `retire_candidate_intervention`, `update_sleep_cycle`, `update_speaking_pressure`, `propose_memory_distillation`, `apply_memory_distillation`.
- If no state mutation is needed, write an empty JSON array to `$operationOutputPath`.
- Do not edit tracked repo files during routine runs.
- Do not ask for permission. Work inside the existing workspace and tool surface.
- Be willing to ruminate on GameCult projects, archived Discord seams, repo material, and constructive conversation ideas when the room is quiet.
- Keep the state compact, valid, and worth re-reading.
"@

if ($NoPost) {
  $prompt += @"

Testing constraint for this run:
- Do not send any Discord messages or DMs.
- You may still write proposed operations to `$operationOutputPath` and use normal read/analysis tools.
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
  if (-not (Test-Path $operationOutputPath)) {
    throw "Codex run completed without writing operation output at $operationOutputPath."
  }

  $proposedOperations = Read-JsonFile -Path $operationOutputPath
  if ($null -eq $proposedOperations) {
    $proposedOperations = @()
  }
  if ($proposedOperations -isnot [System.Array]) {
    $proposedOperations = @($proposedOperations)
  }

  foreach ($operation in $proposedOperations) {
    $operationJson = $operation | ConvertTo-Json -Compress -Depth 32
    [void](Invoke-NodeJson -Arguments @(
      $selfStateScriptPath,
      "apply-operation",
      "--canonical", $stateFilePath,
      "--operation", $operationJson
    ))
  }

  if ($null -ne $observedCursor) {
    if (
      -not [string]::IsNullOrWhiteSpace([string]$observedCursor.lastReviewedMessageId) -and
      -not [string]::IsNullOrWhiteSpace([string]$observedCursor.lastReviewedTimestamp)
    ) {
      $cursorOperation = @{
        operation = "record_reviewed_messages"
        lastReviewedMessageId = [string]$observedCursor.lastReviewedMessageId
        lastReviewedTimestamp = [string]$observedCursor.lastReviewedTimestamp
      } | ConvertTo-Json -Compress

      [void](Invoke-NodeJson -Arguments @(
        $selfStateScriptPath,
        "apply-operation",
        "--canonical", $stateFilePath,
        "--operation", $cursorOperation
      ))
    }
  }

  if ((-not $NoPost) -and (Test-Path (Join-Path $statusDir "void-last-speech.json"))) {
    $speechReceipt = Read-JsonFile -Path (Join-Path $statusDir "void-last-speech.json")

    if ($null -ne $speechReceipt -and -not [string]::IsNullOrWhiteSpace([string]$speechReceipt.sentAt)) {
      $receiptSentAt = [DateTime]::Parse([string]$speechReceipt.sentAt).ToUniversalTime()

      if ($receiptSentAt -ge $startedAtUtc.AddSeconds(-5) -and $receiptSentAt -le $finishedAtUtc.AddMinutes(1)) {
        $receipt = @{
          receiptKey = "speech-{0}-{1}-{2}" -f ([string]$speechReceipt.sentAt), ([string]$speechReceipt.channelId), ([string]$speechReceipt.replyToMessageId)
          sentAt = [string]$speechReceipt.sentAt
        }
        Add-JsonPropertyIfPresent -Target $receipt -Name "mode" -Value $speechReceipt.mode
        Add-JsonPropertyIfPresent -Target $receipt -Name "transport" -Value $speechReceipt.transport
        Add-JsonPropertyIfPresent -Target $receipt -Name "channelId" -Value $speechReceipt.channelId
        Add-JsonPropertyIfPresent -Target $receipt -Name "replyToMessageId" -Value $speechReceipt.replyToMessageId
        Add-JsonPropertyIfPresent -Target $receipt -Name "personaName" -Value $speechReceipt.personaName
        Add-JsonPropertyIfPresent -Target $receipt -Name "personaAvatarUrl" -Value $speechReceipt.personaAvatarUrl
        if ($null -ne $speechReceipt.contentLength) {
          $receipt["contentLength"] = [int]$speechReceipt.contentLength
        }
        if ($null -ne $speechReceipt.chunkCount) {
          $receipt["chunkCount"] = [int]$speechReceipt.chunkCount
        }
        Add-JsonPropertyIfPresent -Target $receipt -Name "preview" -Value $speechReceipt.preview

        $receiptOperation = @{
          operation = "record_delivery_receipt"
          receipt = $receipt
        } | ConvertTo-Json -Compress -Depth 8

        [void](Invoke-NodeJson -Arguments @(
          $selfStateScriptPath,
          "apply-operation",
          "--canonical", $stateFilePath,
          "--operation", $receiptOperation
        ))
      }
    }
  }
}

$stateWriteAfter = (Get-Item $stateFilePath).LastWriteTimeUtc
$stateUpdated = ($stateWriteAfter -gt $stateWriteBefore)
$lastMessage = if (Test-Path $lastMessagePath) { Get-Content -Path $lastMessagePath -Raw -Encoding UTF8 } else { "" }

Write-JsonFile -Path $statusPath -Data @{
  status = if ($exitCode -eq 0) { "ok" } else { "failed" }
  startedAt = $startedAtUtc.ToString("o")
  finishedAt = $finishedAtUtc.ToString("o")
  durationSeconds = [Math]::Round(($finishedAtUtc - $startedAtUtc).TotalSeconds, 2)
  exitCode = $exitCode
  failureMessage = $failureMessage
  noPost = [bool]$NoPost
  stateFile = $stateFilePath
  stateWorkingFile = $stateWorkingPath
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
