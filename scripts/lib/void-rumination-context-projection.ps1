Set-StrictMode -Version Latest

function Convert-ToValueArray {
  param($Value)

  if ($null -eq $Value) {
    return @()
  }

  if ($Value -is [System.Array]) {
    return @($Value)
  }

  return @($Value)
}

function Get-ObjectPropertyValue {
  param(
    $Value,
    [Parameter(Mandatory = $true)]
    [string] $Name
  )

  if ($null -eq $Value) {
    return $null
  }

  if ($Value -is [System.Collections.IDictionary]) {
    if ($Value.Contains($Name)) {
      return $Value[$Name]
    }
    return $null
  }

  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Get-ObjectPropertyString {
  param(
    $Value,
    [Parameter(Mandatory = $true)]
    [string] $Name
  )

  $value = Get-ObjectPropertyValue -Value $Value -Name $Name
  if ($null -eq $value) {
    return $null
  }

  $text = [string]$value
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $null
  }
  return $text
}

function Format-RelativeTime {
  param(
    [string] $Value,
    [Parameter(Mandatory = $true)]
    [DateTime] $Now
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  $timestamp = [DateTime]::MinValue
  if (-not [DateTime]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$timestamp)) {
    return $null
  }

  $timestampUtc = $timestamp.ToUniversalTime()
  $delta = $timestampUtc - $Now.ToUniversalTime()
  $future = $delta.TotalSeconds -gt 0
  $seconds = [Math]::Abs($delta.TotalSeconds)

  if ($seconds -lt 45) {
    return "just now"
  }

  if ($seconds -lt 5400) {
    $minutes = [Math]::Max(1, [int][Math]::Round($seconds / 60))
    $unit = if ($minutes -eq 1) { "minute" } else { "minutes" }
    $phrase = "$minutes $unit"
  } elseif ($seconds -lt 129600) {
    $hours = [Math]::Max(1, [int][Math]::Round($seconds / 3600))
    $unit = if ($hours -eq 1) { "hour" } else { "hours" }
    $phrase = "$hours $unit"
  } elseif ($seconds -lt 1814400) {
    $days = [Math]::Max(1, [int][Math]::Round($seconds / 86400))
    $unit = if ($days -eq 1) { "day" } else { "days" }
    $phrase = "$days $unit"
  } elseif ($seconds -lt 6048000) {
    $weeks = [Math]::Max(1, [int][Math]::Round($seconds / 604800))
    $unit = if ($weeks -eq 1) { "week" } else { "weeks" }
    $phrase = "$weeks $unit"
  } elseif ($seconds -lt 47304000) {
    $months = [Math]::Max(1, [int][Math]::Round($seconds / 2592000))
    $unit = if ($months -eq 1) { "month" } else { "months" }
    $phrase = "$months $unit"
  } else {
    $years = [Math]::Max(1, [int][Math]::Round($seconds / 31536000))
    $unit = if ($years -eq 1) { "year" } else { "years" }
    $phrase = "$years $unit"
  }

  if ($future) {
    return "in $phrase"
  }
  return "$phrase ago"
}

function Project-RelativeTimestamp {
  param(
    $Value,
    [string] $Name,
    [DateTime] $Now
  )

  return Format-RelativeTime -Value (Get-ObjectPropertyString -Value $Value -Name $Name) -Now $Now
}

function Project-RecentHistoryForRumination {
  param($History, [DateTime] $Now)

  $messages = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $History -Name "messages"))
  return @{
    source = "discord_history"
    messageCount = [int]$messages.Count
    messages = @(
      $messages | ForEach-Object {
        @{
          id = Get-ObjectPropertyString -Value $_ -Name "id"
          channelId = Get-ObjectPropertyString -Value $_ -Name "channelId"
          authorId = Get-ObjectPropertyString -Value $_ -Name "authorId"
          authorName = Get-ObjectPropertyString -Value $_ -Name "authorName"
          isBot = [bool](Get-ObjectPropertyValue -Value $_ -Name "isBot")
          when = Project-RelativeTimestamp -Value $_ -Name "timestamp" -Now $Now
          content = Get-ObjectPropertyString -Value $_ -Name "content"
        }
      }
    )
  }
}

function Project-RecentConversationTargetForRumination {
  param(
    $History,
    [string] $PersonaName,
    [string] $PersonaAvatarUrl
  )

  $messages = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $History -Name "messages"))
  if ($messages.Count -eq 0) {
    return $null
  }

  $anchor = $null
  for ($index = $messages.Count - 1; $index -ge 0; $index--) {
    $candidate = $messages[$index]
    $channelId = Get-ObjectPropertyString -Value $candidate -Name "channelId"
    if ([string]::IsNullOrWhiteSpace($channelId)) {
      continue
    }

    if (-not [bool](Get-ObjectPropertyValue -Value $candidate -Name "isBot")) {
      $anchor = $candidate
      break
    }

    if ($null -eq $anchor) {
      $anchor = $candidate
    }
  }

  if ($null -eq $anchor) {
    return $null
  }

  $target = @{
    mode = "channel"
    channelId = Get-ObjectPropertyString -Value $anchor -Name "channelId"
    replyToMessageId = Get-ObjectPropertyString -Value $anchor -Name "id"
    personaName = if ([string]::IsNullOrWhiteSpace($PersonaName)) { "Void" } else { $PersonaName.Trim() }
    reason = "Latest concrete recent-history conversation anchor. Use this instead of the configured public room when replying to that conversation."
  }

  if (-not [string]::IsNullOrWhiteSpace($PersonaAvatarUrl)) {
    $target.personaAvatarUrl = $PersonaAvatarUrl.Trim()
  }

  return $target
}

function Project-OpenCasesForRumination {
  param($Cases, [DateTime] $Now)

  return @(
    @(Convert-ToValueArray -Value $Cases) |
      Where-Object {
        -not (Test-RuminationCaseTerminal -Status (Get-ObjectPropertyString -Value $_ -Name "status"))
      } |
      ForEach-Object {
      @{
        sourceMessageId = Get-ObjectPropertyString -Value $_ -Name "sourceMessageId"
        status = Get-ObjectPropertyString -Value $_ -Name "status"
        summary = Get-ObjectPropertyString -Value $_ -Name "summary"
        authorName = Get-ObjectPropertyString -Value $_ -Name "authorName"
        channelId = Get-ObjectPropertyString -Value $_ -Name "channelId"
        messageUrl = Get-ObjectPropertyString -Value $_ -Name "messageUrl"
        whyItMatters = Get-ObjectPropertyString -Value $_ -Name "whyItMatters"
        created = Project-RelativeTimestamp -Value $_ -Name "createdAt" -Now $Now
        lastTouched = Project-RelativeTimestamp -Value $_ -Name "lastTouchedAt" -Now $Now
        resolved = Project-RelativeTimestamp -Value $_ -Name "resolvedAt" -Now $Now
        tags = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "tags"))
      }
    }
  )
}

function Test-RuminationCaseTerminal {
  param([string] $Status)

  return @("answered", "resolved", "closed", "retired", "dropped").Contains($Status)
}

function Project-SpeechReceiptsForRumination {
  param($Receipts, [DateTime] $Now)

  return @(
    @(Convert-ToValueArray -Value $Receipts) | ForEach-Object {
      @{
        receiptKey = Get-ObjectPropertyString -Value $_ -Name "receiptKey"
        candidateInterventionId = Get-ObjectPropertyString -Value $_ -Name "candidateInterventionId"
        sent = Project-RelativeTimestamp -Value $_ -Name "sentAt" -Now $Now
        mode = Get-ObjectPropertyString -Value $_ -Name "mode"
        transport = Get-ObjectPropertyString -Value $_ -Name "transport"
        channelId = Get-ObjectPropertyString -Value $_ -Name "channelId"
        replyToMessageId = Get-ObjectPropertyString -Value $_ -Name "replyToMessageId"
        preview = Get-ObjectPropertyString -Value $_ -Name "preview"
      }
    }
  )
}

function Project-MemoriesForRumination {
  param($Memories, [DateTime] $Now)

  return @(
    @(Convert-ToValueArray -Value $Memories) | ForEach-Object {
      @{
        memoryId = Get-ObjectPropertyString -Value $_ -Name "memoryId"
        kind = Get-ObjectPropertyString -Value $_ -Name "kind"
        target = Get-ObjectPropertyValue -Value $_ -Name "target"
        summary = Get-ObjectPropertyString -Value $_ -Name "summary"
        claim = Get-ObjectPropertyString -Value $_ -Name "claim"
        question = Get-ObjectPropertyString -Value $_ -Name "question"
        tension = Get-ObjectPropertyString -Value $_ -Name "tension"
        actionImplication = Get-ObjectPropertyString -Value $_ -Name "actionImplication"
        created = Project-RelativeTimestamp -Value $_ -Name "createdAt" -Now $Now
        updated = Project-RelativeTimestamp -Value $_ -Name "updatedAt" -Now $Now
        retired = Project-RelativeTimestamp -Value $_ -Name "retiredAt" -Now $Now
        anchorRefs = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "anchorRefs"))
        evidenceRefs = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "evidenceRefs"))
        tags = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "tags"))
      }
    }
  )
}

function Project-IncubationForRumination {
  param($Threads, [DateTime] $Now)

  return @(
    @(Convert-ToValueArray -Value $Threads) | ForEach-Object {
      @{
        threadId = Get-ObjectPropertyString -Value $_ -Name "threadId"
        target = Get-ObjectPropertyValue -Value $_ -Name "target"
        topic = Get-ObjectPropertyString -Value $_ -Name "topic"
        summary = Get-ObjectPropertyString -Value $_ -Name "summary"
        supportMemoryIds = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "supportMemoryIds"))
        anchorRefs = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "anchorRefs"))
        evidenceRefs = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "evidenceRefs"))
        maturation = Get-ObjectPropertyValue -Value $_ -Name "maturation"
        noveltyToRoom = Get-ObjectPropertyValue -Value $_ -Name "noveltyToRoom"
        noveltyToSelf = Get-ObjectPropertyValue -Value $_ -Name "noveltyToSelf"
        desireToSpeak = Get-ObjectPropertyValue -Value $_ -Name "desireToSpeak"
        saturationScore = Get-ObjectPropertyValue -Value $_ -Name "saturationScore"
        status = Get-ObjectPropertyString -Value $_ -Name "status"
        created = Project-RelativeTimestamp -Value $_ -Name "createdAt" -Now $Now
        updated = Project-RelativeTimestamp -Value $_ -Name "updatedAt" -Now $Now
      }
    }
  )
}

function Project-InterventionsForRumination {
  param($Interventions, [DateTime] $Now)

  return @(
    @(Convert-ToValueArray -Value $Interventions) | ForEach-Object {
      @{
        interventionId = Get-ObjectPropertyString -Value $_ -Name "interventionId"
        kind = Get-ObjectPropertyString -Value $_ -Name "kind"
        status = Get-ObjectPropertyString -Value $_ -Name "status"
        target = Get-ObjectPropertyValue -Value $_ -Name "target"
        summary = Get-ObjectPropertyString -Value $_ -Name "summary"
        draft = Get-ObjectPropertyString -Value $_ -Name "draft"
        priority = Get-ObjectPropertyValue -Value $_ -Name "priority"
        mustEventuallyShare = Get-ObjectPropertyValue -Value $_ -Name "mustEventuallyShare"
        created = Project-RelativeTimestamp -Value $_ -Name "createdAt" -Now $Now
        updated = Project-RelativeTimestamp -Value $_ -Name "updatedAt" -Now $Now
        spoken = Project-RelativeTimestamp -Value $_ -Name "spokenAt" -Now $Now
        retired = Project-RelativeTimestamp -Value $_ -Name "retiredAt" -Now $Now
        tags = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "tags"))
      }
    }
  )
}

function Project-PublicSpeechTargetForRumination {
  param(
    [string] $ChannelId,
    [string] $PersonaName,
    [string] $PersonaAvatarUrl
  )

  if ([string]::IsNullOrWhiteSpace($ChannelId)) {
    return $null
  }

  $target = @{
    mode = "channel"
    channelId = $ChannelId.Trim()
    personaName = if ([string]::IsNullOrWhiteSpace($PersonaName)) { "Void" } else { $PersonaName.Trim() }
    reason = "Configured public room for Void to present self-authored public artifacts and other ripe public thoughts."
  }

  if (-not [string]::IsNullOrWhiteSpace($PersonaAvatarUrl)) {
    $target.personaAvatarUrl = $PersonaAvatarUrl.Trim()
  }

  return $target
}

function Project-AgencyPressureForRumination {
  param($Pressures, [DateTime] $Now)

  return @(
    @(Convert-ToValueArray -Value $Pressures) | ForEach-Object {
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
        created = Project-RelativeTimestamp -Value $_ -Name "createdAt" -Now $Now
        updated = Project-RelativeTimestamp -Value $_ -Name "updatedAt" -Now $Now
        resolved = Project-RelativeTimestamp -Value $_ -Name "resolvedAt" -Now $Now
        retired = Project-RelativeTimestamp -Value $_ -Name "retiredAt" -Now $Now
        anchorRefs = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "anchorRefs"))
        evidenceRefs = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "evidenceRefs"))
        sourceMemoryIds = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "sourceMemoryIds"))
        tags = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "tags"))
      }
    }
  )
}

function Project-ScheduledRuntimeForRumination {
  param($Runtime, [DateTime] $Now)

  $sleepCycle = Get-ObjectPropertyValue -Value $Runtime -Name "sleepCycle"
  $speakingPressure = Get-ObjectPropertyValue -Value $Runtime -Name "speakingPressure"
  $lastRuns = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $Runtime -Name "lastRuns"))

  return @{
    sleepCycle = @{
      isNapping = [bool](Get-ObjectPropertyValue -Value $sleepCycle -Name "isNapping")
      currentNapStarted = Project-RelativeTimestamp -Value $sleepCycle -Name "currentNapStartedAt" -Now $Now
      currentNapEnds = Project-RelativeTimestamp -Value $sleepCycle -Name "currentNapEndsAt" -Now $Now
      nextNapStarts = Project-RelativeTimestamp -Value $sleepCycle -Name "nextNapStartsAt" -Now $Now
      activeDreamThemes = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $sleepCycle -Name "activeDreamThemes"))
    }
    speakingPressure = @{
      needToSpeak = Get-ObjectPropertyValue -Value $speakingPressure -Name "needToSpeak"
      confessionPressure = Get-ObjectPropertyValue -Value $speakingPressure -Name "confessionPressure"
      noveltyPressure = Get-ObjectPropertyValue -Value $speakingPressure -Name "noveltyPressure"
      recentSpeechDamping = Get-ObjectPropertyValue -Value $speakingPressure -Name "recentSpeechDamping"
      lastSpoke = Project-RelativeTimestamp -Value $speakingPressure -Name "lastSpokeAt" -Now $Now
      lastHerald = Project-RelativeTimestamp -Value $speakingPressure -Name "lastHeraldAt" -Now $Now
    }
    lastRuns = @(
      $lastRuns | ForEach-Object {
        @{
          runner = Get-ObjectPropertyString -Value $_ -Name "runner"
          ran = Project-RelativeTimestamp -Value $_ -Name "ranAt" -Now $Now
          summary = Get-ObjectPropertyString -Value $_ -Name "summary"
        }
      }
    )
  }
}

function Project-CursorForRumination {
  param($Cursor, [DateTime] $Now)

  return @{
    lastReviewedMessageId = Get-ObjectPropertyString -Value $Cursor -Name "lastReviewedMessageId"
    lastReviewed = Project-RelativeTimestamp -Value $Cursor -Name "lastReviewedTimestamp" -Now $Now
  }
}

function Get-VoidAuthoredArtifactsFromContentHints {
  param($ContentHints)

  return @(
    @(Convert-ToValueArray -Value $ContentHints) |
      Where-Object {
        $frontmatter = Get-ObjectPropertyValue -Value $_ -Name "frontmatter"
        $author = Get-ObjectPropertyValue -Value $frontmatter -Name "author"
        @(Convert-ToValueArray -Value $author) |
          Where-Object { ([string]$_).Trim().ToLowerInvariant() -eq "void" } |
          Select-Object -First 1
      } |
      ForEach-Object {
        $frontmatter = Get-ObjectPropertyValue -Value $_ -Name "frontmatter"
        @{
          path = Get-ObjectPropertyString -Value $_ -Name "path"
          title = Get-ObjectPropertyString -Value $frontmatter -Name "title"
          description = Get-ObjectPropertyString -Value $frontmatter -Name "description"
          socialDeck = Get-ObjectPropertyString -Value $frontmatter -Name "socialDeck"
        }
      }
  )
}

function Project-RepoCommitForRumination {
  param($Commit, [DateTime] $Now)

  if ($null -eq $Commit) {
    return $null
  }

  $hash = Get-ObjectPropertyString -Value $Commit -Name "hash"
  $contentHints = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $Commit -Name "contentHints"))
  $authoredPublicArtifacts = @(Get-VoidAuthoredArtifactsFromContentHints -ContentHints $contentHints)
  return @{
    hash = if ($hash -and $hash.Length -gt 12) { $hash.Substring(0, 12) } else { $hash }
    committed = Project-RelativeTimestamp -Value $Commit -Name "committedAt" -Now $Now
    author = Get-ObjectPropertyString -Value $Commit -Name "author"
    subject = Get-ObjectPropertyString -Value $Commit -Name "subject"
    diffstat = Get-ObjectPropertyValue -Value $Commit -Name "diffstat"
    changedPaths = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $Commit -Name "changedPaths"))
    contentHints = $contentHints
    authoredPublicArtifacts = $authoredPublicArtifacts
  }
}

function Test-RepoHasVoidAuthoredArtifact {
  param($Repo)

  $commits = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $Repo -Name "commits"))
  foreach ($commit in $commits) {
    $contentHints = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $commit -Name "contentHints"))
    if (@(Get-VoidAuthoredArtifactsFromContentHints -ContentHints $contentHints).Count -gt 0) {
      return $true
    }
  }

  return $false
}

function Test-RepoIsWeatherEligible {
  param($Repo)

  $repoName = Get-ObjectPropertyString -Value $Repo -Name "repoName"
  if ([string]::IsNullOrWhiteSpace($repoName)) {
    return $false
  }

  # Generated agent worktrees can be useful source archives, but they make bad
  # public weather. The weather skyline should name durable bodies, not clones.
  return -not (
    $repoName -match "(?i)-agent-\d{8}t\d+-pass-" -or
    $repoName -match "(?i)-check-[0-9a-f]{7,}$" -or
    $repoName -match "^_"
  )
}

function Project-RepoWeatherEntryForRumination {
  param($Repo, [DateTime] $Now)

  if ($null -eq $Repo) {
    return $null
  }

  $windowRecentCommitCount = Get-ObjectPropertyValue -Value $Repo -Name "windowRecentCommitCount"
  $suppressedRecentCommitCount = Get-ObjectPropertyValue -Value $Repo -Name "suppressedRecentCommitCount"
  $recentCommitCount = Get-ObjectPropertyValue -Value $Repo -Name "recentCommitCount"
  $latestCommit = Project-RepoCommitForRumination -Commit (Get-ObjectPropertyValue -Value $Repo -Name "latestCommit") -Now $Now
  $repoName = Get-ObjectPropertyString -Value $Repo -Name "repoName"
  $latestSubject = if ($null -ne $latestCommit) { Get-ObjectPropertyString -Value $latestCommit -Name "subject" } else { $null }
  $countText = if ($null -ne $windowRecentCommitCount -and [int]$windowRecentCommitCount -eq 1) { "1 commit" } else { "{0} commits" -f $windowRecentCommitCount }

  return @{
    repoName = $repoName
    branch = Get-ObjectPropertyString -Value $Repo -Name "branch"
    status = Get-ObjectPropertyString -Value $Repo -Name "status"
    recentCommitCount = $recentCommitCount
    windowRecentCommitCount = $windowRecentCommitCount
    suppressedRecentCommitCount = $suppressedRecentCommitCount
    latestCommit = $latestCommit
    weatherLine = if (-not [string]::IsNullOrWhiteSpace($latestSubject)) {
      '{0}: {1}, latest `{2}`' -f $repoName, $countText, $latestSubject
    } else {
      "{0}: {1}, no readable latest subject" -f $repoName, $countText
    }
  }
}

function Select-RuminationRepoActivity {
  param($RepoActivity, [DateTime] $Now)

  if ($null -eq $RepoActivity) {
    return $null
  }

  $status = Get-ObjectPropertyString -Value $RepoActivity -Name "status"
  if ($status -eq "failed") {
    return @{
      status = "failed"
      error = Get-ObjectPropertyString -Value $RepoActivity -Name "error"
    }
  }

  $repos = @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $RepoActivity -Name "repos"))
  $activeRepos = @(
    $repos |
      Where-Object {
        $repoStatus = Get-ObjectPropertyString -Value $_ -Name "status"
        $windowRecent = Get-ObjectPropertyValue -Value $_ -Name "windowRecentCommitCount"
        $repoStatus -eq "ok" -and $null -ne $windowRecent -and [int]$windowRecent -gt 0 -and (Test-RepoIsWeatherEligible -Repo $_)
      } |
      Sort-Object -Property @{
        Expression = { [int](Get-ObjectPropertyValue -Value $_ -Name "windowRecentCommitCount") }
        Descending = $true
      }, @{
        Expression = {
          $latestCommit = Get-ObjectPropertyValue -Value $_ -Name "latestCommit"
          Get-ObjectPropertyString -Value $latestCommit -Name "committedAt"
        }
        Descending = $true
      } |
      Select-Object -First 10
  )
  $freshRepos = @(
    $repos |
      Where-Object {
        $recent = Get-ObjectPropertyValue -Value $_ -Name "recentCommitCount"
        $repoStatus = Get-ObjectPropertyString -Value $_ -Name "status"
        $null -ne $recent -and $repoStatus -eq "ok" -and [int]$recent -gt 0
      } |
      Sort-Object -Property @{
        Expression = { if (Test-RepoHasVoidAuthoredArtifact -Repo $_) { 0 } else { 1 } }
      } |
      Select-Object -First 8
  )
  $projectedRepos = @(
    $freshRepos | ForEach-Object {
      @{
        repoName = Get-ObjectPropertyString -Value $_ -Name "repoName"
        branch = Get-ObjectPropertyString -Value $_ -Name "branch"
        status = Get-ObjectPropertyString -Value $_ -Name "status"
        recentCommitCount = Get-ObjectPropertyValue -Value $_ -Name "recentCommitCount"
        windowRecentCommitCount = Get-ObjectPropertyValue -Value $_ -Name "windowRecentCommitCount"
        suppressedRecentCommitCount = Get-ObjectPropertyValue -Value $_ -Name "suppressedRecentCommitCount"
        latestCommit = Project-RepoCommitForRumination -Commit (Get-ObjectPropertyValue -Value $_ -Name "latestCommit") -Now $Now
        commits = @(
          @(Convert-ToValueArray -Value (Get-ObjectPropertyValue -Value $_ -Name "commits")) | ForEach-Object {
            Project-RepoCommitForRumination -Commit $_ -Now $Now
          }
        )
      }
    }
  )
  $projectedActiveRepos = @(
    $activeRepos | ForEach-Object {
      Project-RepoWeatherEntryForRumination -Repo $_ -Now $Now
    }
  )
  $weatherDigest = @(
    $projectedActiveRepos |
      Select-Object -First 6 |
      ForEach-Object { Get-ObjectPropertyString -Value $_ -Name "weatherLine" }
  )
  $weatherDigestText = if ($weatherDigest.Count -gt 0) {
    "Active tracked repo weather: " + ($weatherDigest -join "; ")
  } else {
    "No tracked repo weather inside the recent activity window."
  }

  return @{
    generated = Project-RelativeTimestamp -Value $RepoActivity -Name "generatedAt" -Now $Now
    cursorMode = Get-ObjectPropertyString -Value $RepoActivity -Name "cursorMode"
    summary = if ($projectedRepos.Count -gt 0) { "New tracked repo commits crossed the saved repo-activity cursor." } else { "No new tracked repo commits crossed the saved repo-activity cursor." }
    freshRepos = $projectedRepos
    activeRepos = $projectedActiveRepos
    weatherDigest = $weatherDigestText
    weatherLines = $weatherDigest
    weatherSummary = if ($projectedActiveRepos.Count -gt 0) {
      "Recent tracked repo weather is active even when the fresh cursor is quiet; synthesize the skyline, not just the newest commit."
    } else {
      "No tracked repo weather inside the recent activity window."
    }
  }
}
