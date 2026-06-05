import "dotenv/config";

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  buildVoidSelfStateContext,
  loadVoidSelfStateTypedDocuments,
  writeVoidSelfStateTypedDocuments,
  type VoidSelfStateTypedProjection,
} from "@voidbot/core";
import { loadConfig } from "@voidbot/config";
import { FileMessageArchiveRepository, type ArchivedMessageRecord } from "@voidbot/rag";
import type { SourceMessage } from "@voidbot/shared";

const DEFAULT_METACRAT_AUTHOR_ID = "113785782975594501";

interface CliOptions {
  targetMessageId: string;
  statePath: string;
  personaId: string;
  publicName: string;
  metacratAuthorId: string;
  before: number;
  after: number;
  heldoutMinutes: number;
  outRoot: string;
  runCodex: boolean;
  evaluateCodex: boolean;
}

interface CodexResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  finalMessage: string;
}

async function main(): Promise<void> {
  if (!process.env.DISCORD_OWNER_ID) {
    process.env.DISCORD_OWNER_ID = "__persona_replay__";
  }

  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const archive = new FileMessageArchiveRepository(config.ragArchivePath);
  const target = await archive.get(options.targetMessageId);

  if (!target) {
    throw new Error(`Target Discord message ${options.targetMessageId} was not found in ${config.ragArchivePath}.`);
  }

  const messages = await archive.listContextWindow(options.targetMessageId, options.before, options.after);
  if (messages.length === 0) {
    throw new Error(`No context window was found for ${options.targetMessageId}.`);
  }

  const cutoff = new Date(Date.parse(target.timestamp) - 1).toISOString();
  const anchorTimestamps = new Map(
    (await archive.listAll()).map((message) => [message.id, message.timestamp]),
  );
  const sourceState = await loadVoidSelfStateTypedDocuments({
    canonicalPath: options.statePath,
    identity: {
      agentId: options.personaId,
      publicName: options.publicName,
    },
  });
  const pruneResult = pruneStateAfter(sourceState, cutoff, anchorTimestamps);
  const artifactDir = buildArtifactDir(options.outRoot, options.targetMessageId);
  const temporalStatePath = join(artifactDir, "temporal-state.cc");
  const promptPath = join(artifactDir, "replay-prompt.md");
  const evalPromptPath = join(artifactDir, "evaluation-prompt.md");
  const reportPath = join(artifactDir, "replay-report.json");

  await mkdir(artifactDir, { recursive: true });
  await writeVoidSelfStateTypedDocuments({
    canonicalPath: temporalStatePath,
    identity: {
      agentId: options.personaId,
      publicName: options.publicName,
    },
  }, pruneResult.state);

  const inputMessages = messages.filter((message) => message.timestamp <= target.timestamp);
  const heldOutMessages = messages.filter((message) =>
    message.timestamp > target.timestamp &&
    isWithinHeldoutWindow(message.timestamp, target.timestamp, options.heldoutMinutes)
  );
  const actualMetacratMessages = heldOutMessages.filter((message) => message.authorId === options.metacratAuthorId);
  const prompt = buildReplayPrompt({
    state: pruneResult.state,
    sourcePath: temporalStatePath,
    target,
    inputMessages,
    heldOutMessages,
    actualMetacratMessages,
    pruneWarnings: pruneResult.warnings,
    options,
  });

  await writeFile(promptPath, prompt, "utf8");

  let generation: CodexResult | undefined;
  if (options.runCodex) {
    generation = await runCodex(prompt, config);
    await writeFile(join(artifactDir, "codex-generation.stdout.jsonl"), generation.stdout, "utf8");
    await writeFile(join(artifactDir, "codex-generation.stderr.txt"), generation.stderr, "utf8");
  }

  const predictedText = generation?.finalMessage ?? "";
  const actualText = actualMetacratMessages.map(renderMessageContentOnly).join("\n");
  const deterministicComparison = compareText(predictedText, actualText);

  let evaluation: CodexResult | undefined;
  if (options.evaluateCodex && generation) {
    const evalPrompt = buildEvaluationPrompt({
      target,
      inputMessages,
      actualMetacratMessages,
      predictedText,
      deterministicComparison,
    });
    await writeFile(evalPromptPath, evalPrompt, "utf8");
    evaluation = await runCodex(evalPrompt, config);
    await writeFile(join(artifactDir, "codex-evaluation.stdout.jsonl"), evaluation.stdout, "utf8");
    await writeFile(join(artifactDir, "codex-evaluation.stderr.txt"), evaluation.stderr, "utf8");
  }

  const report = {
    targetMessageId: options.targetMessageId,
    targetTimestamp: target.timestamp,
    stateCutoff: cutoff,
    targetAuthor: target.authorName,
    channelId: target.channelId,
    channelName: target.metadata?.channelName,
    artifactDir,
    temporalStatePath,
    promptPath,
    evaluationPromptPath: options.evaluateCodex && generation ? evalPromptPath : undefined,
    counts: {
      inputMessages: inputMessages.length,
      heldOutMessages: heldOutMessages.length,
      actualMetacratMessages: actualMetacratMessages.length,
      survivingMemories: pruneResult.state.thoughtMemory.memories.length,
      survivingBonds: pruneResult.state.personaAffect.socialBonds.length,
      survivingNeeds: pruneResult.state.personaAffect.needs.length,
      survivingDoctrineStances: pruneResult.state.personaAffect.doctrineStances.length,
    },
    prune: {
      removed: pruneResult.removed,
      warnings: pruneResult.warnings,
    },
    actualMetacratMessages: actualMetacratMessages.map(toReportMessage),
    predictedReply: predictedText || undefined,
    deterministicComparison,
    modelEvaluation: evaluation?.finalMessage,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    artifactDir,
    temporalStatePath,
    promptPath,
    reportPath,
    target: {
      id: target.id,
      timestamp: target.timestamp,
      authorName: target.authorName,
    },
    counts: report.counts,
    removed: pruneResult.removed,
    warnings: pruneResult.warnings,
    ranCodex: options.runCodex,
    evaluated: Boolean(evaluation),
    deterministicComparison,
  }, null, 2));
}

function parseArgs(args: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    statePath: "state/personas/metacrat.cc",
    personaId: "metacrat",
    publicName: "Metacrat",
    metacratAuthorId: DEFAULT_METACRAT_AUTHOR_ID,
    before: 18,
    after: 18,
    heldoutMinutes: 30,
    outRoot: ".voidbot/artifacts/persona-replay",
    runCodex: false,
    evaluateCodex: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--target-message-id" && next) {
      options.targetMessageId = next;
      index += 1;
    } else if (arg === "--state" && next) {
      options.statePath = next;
      index += 1;
    } else if (arg === "--persona-id" && next) {
      options.personaId = next;
      index += 1;
    } else if (arg === "--public-name" && next) {
      options.publicName = next;
      index += 1;
    } else if (arg === "--metacrat-author-id" && next) {
      options.metacratAuthorId = next;
      index += 1;
    } else if (arg === "--before" && next) {
      options.before = parsePositiveInt(next, "--before");
      index += 1;
    } else if (arg === "--after" && next) {
      options.after = parsePositiveInt(next, "--after");
      index += 1;
    } else if (arg === "--heldout-minutes" && next) {
      options.heldoutMinutes = parsePositiveInt(next, "--heldout-minutes");
      index += 1;
    } else if (arg === "--out" && next) {
      options.outRoot = next;
      index += 1;
    } else if (arg === "--run-codex") {
      options.runCodex = true;
    } else if (arg === "--evaluate-codex") {
      options.evaluateCodex = true;
      options.runCodex = true;
    } else if (arg === "--help") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!options.targetMessageId) {
    throw new Error("--target-message-id is required.");
  }

  return {
    targetMessageId: options.targetMessageId,
    statePath: resolve(options.statePath ?? "state/personas/metacrat.cc"),
    personaId: options.personaId ?? "metacrat",
    publicName: options.publicName ?? "Metacrat",
    metacratAuthorId: options.metacratAuthorId ?? DEFAULT_METACRAT_AUTHOR_ID,
    before: options.before ?? 18,
    after: options.after ?? 18,
    heldoutMinutes: options.heldoutMinutes ?? 30,
    outRoot: resolve(options.outRoot ?? ".voidbot/artifacts/persona-replay"),
    runCodex: options.runCodex ?? false,
    evaluateCodex: options.evaluateCodex ?? false,
  };
}

function printHelpAndExit(): never {
  console.log([
    "Usage: npm run persona:replay-thread -- --target-message-id <discord-id> [options]",
    "",
    "Builds a temporal copy of Metacrat's Persona .cc, removes state after the target event,",
    "feeds the model the actual Discord thread up to the target message, and compares any",
    "generated reply against held-out real Metacrat messages after the target.",
    "",
    "Options:",
    "  --state <path>              Source Persona .cc. Defaults to state/personas/metacrat.cc",
    "  --before <n>                Context messages before target. Defaults to 18",
    "  --after <n>                 Held-out messages after target. Defaults to 18",
    "  --heldout-minutes <n>       Limit held-out truth to n minutes after target. Defaults to 30; 0 disables the time limit",
    "  --out <dir>                 Artifact root. Defaults to .voidbot/artifacts/persona-replay",
    "  --run-codex                 Generate a predicted reply with local Codex exec",
    "  --evaluate-codex            Also ask Codex to compare prediction to held-out truth",
  ].join("\n"));
  process.exit(0);
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function isWithinHeldoutWindow(timestamp: string, targetTimestamp: string, minutes: number): boolean {
  if (minutes === 0) {
    return true;
  }
  return Date.parse(timestamp) <= Date.parse(targetTimestamp) + minutes * 60_000;
}

function pruneStateAfter(
  sourceState: VoidSelfStateTypedProjection,
  cutoff: string,
  anchorTimestamps: Map<string, string>,
): {
  state: VoidSelfStateTypedProjection;
  removed: Record<string, number>;
  warnings: string[];
} {
  const state = deepClone(sourceState);
  const warnings: string[] = [];
  const removed: Record<string, number> = {};

  if (state.selfProfile.updatedAt > cutoff) {
    removed.privateNotes = state.selfProfile.privateNotes.length;
    removed.values = state.selfProfile.values.length;
    state.selfProfile.privateNotes = [];
    state.selfProfile.values = [];
    state.selfProfile.activationProfile = {
      underlyingOrganization: {},
      stableDispositions: {},
      behavioralDimensions: {},
      presentationStrategy: {},
      voiceStyle: {},
      situationalState: {},
    };
    warnings.push("selfProfile values/privateNotes/activationProfile have no per-entry timestamps; cleared because selfProfile.updatedAt is after cutoff.");
  }

  state.moderationCursor.openCases = keepByCreatedAt(
    state.moderationCursor.openCases,
    cutoff,
    "moderationOpenCases",
    removed,
    anchorTimestamps,
  );
  state.moderationCursor.userStatuses = keepByUpdatedAt(
    state.moderationCursor.userStatuses,
    cutoff,
    "moderationUserStatuses",
    removed,
  );
  state.speechReceipts.recentReceipts = keepByTimestampField(
    state.speechReceipts.recentReceipts,
    "sentAt",
    cutoff,
    "speechReceipts",
    removed,
    anchorTimestamps,
  );
  state.thoughtMemory.shortTerm = keepByCreatedAt(
    state.thoughtMemory.shortTerm,
    cutoff,
    "shortTermMemories",
    removed,
    anchorTimestamps,
  );
  state.thoughtMemory.memories = keepByCreatedAt(
    state.thoughtMemory.memories,
    cutoff,
    "durableMemories",
    removed,
    anchorTimestamps,
  ).map((memory) => {
    if (memory.semanticIndex && memory.semanticIndex.indexedAt > cutoff) {
      removed.semanticIndexes = (removed.semanticIndexes ?? 0) + 1;
      const { semanticIndex: _semanticIndex, ...rest } = memory;
      return rest;
    }
    return memory;
  });
  state.thoughtMemory.incubation = keepByCreatedAt(
    state.thoughtMemory.incubation,
    cutoff,
    "incubationThreads",
    removed,
    anchorTimestamps,
  );
  state.agencyPressure.pressures = keepByCreatedAt(
    state.agencyPressure.pressures,
    cutoff,
    "agencyPressures",
    removed,
    anchorTimestamps,
  );
  state.candidateInterventions.interventions = keepByCreatedAt(
    state.candidateInterventions.interventions,
    cutoff,
    "candidateInterventions",
    removed,
    anchorTimestamps,
  );
  state.personaAffect.needs = keepByCreatedAt(
    state.personaAffect.needs,
    cutoff,
    "affectNeeds",
    removed,
    anchorTimestamps,
  );
  state.personaAffect.socialBonds = keepByCreatedAt(
    state.personaAffect.socialBonds,
    cutoff,
    "socialBonds",
    removed,
    anchorTimestamps,
  );
  state.personaAffect.statusReads = keepByCreatedAt(
    state.personaAffect.statusReads,
    cutoff,
    "statusReads",
    removed,
    anchorTimestamps,
  );
  state.personaAffect.doctrineStances = keepByCreatedAt(
    state.personaAffect.doctrineStances,
    cutoff,
    "doctrineStances",
    removed,
    anchorTimestamps,
  );
  state.personaAffect.moodDimensions = keepByUpdatedAt(
    state.personaAffect.moodDimensions,
    cutoff,
    "moodDimensions",
    removed,
  );
  state.personaAffect.socialBiases = keepByUpdatedAt(
    state.personaAffect.socialBiases,
    cutoff,
    "socialBiases",
    removed,
  );

  stampDocumentUpdates(state, cutoff);
  return { state, removed, warnings };
}

function keepByCreatedAt<T extends { createdAt?: string }>(
  entries: T[],
  cutoff: string,
  label: string,
  removed: Record<string, number>,
  anchorTimestamps: Map<string, string>,
): T[] {
  return keepByTimestampField(entries, "createdAt", cutoff, label, removed, anchorTimestamps);
}

function keepByUpdatedAt<T extends { updatedAt?: string }>(
  entries: T[],
  cutoff: string,
  label: string,
  removed: Record<string, number>,
): T[] {
  return keepByTimestampField(entries, "updatedAt", cutoff, label, removed);
}

function keepByTimestampField<T extends Record<string, unknown>>(
  entries: T[],
  field: string,
  cutoff: string,
  label: string,
  removed: Record<string, number>,
  anchorTimestamps?: Map<string, string>,
): T[] {
  const kept = entries.filter((entry) => {
    const timestamp = entry[field];
    if (typeof timestamp === "string" && timestamp > cutoff) {
      return false;
    }
    return !anchorTimestamps || !hasAnchorAtOrAfter(entry, cutoff, anchorTimestamps);
  });
  removed[label] = entries.length - kept.length;
  return kept;
}

function hasAnchorAtOrAfter(
  entry: Record<string, unknown>,
  cutoff: string,
  anchorTimestamps: Map<string, string>,
): boolean {
  const refs = [
    ...readRefs(entry.anchorRefs),
    ...readRefs(entry.evidenceRefs),
  ];

  for (const ref of refs) {
    for (const messageId of extractDiscordMessageIds(ref)) {
      const timestamp = anchorTimestamps.get(messageId);
      if (timestamp && timestamp >= cutoff) {
        return true;
      }
    }
  }

  return false;
}

function readRefs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (entry && typeof entry === "object" && "ref" in entry && typeof entry.ref === "string") {
        return entry.ref;
      }
      return undefined;
    })
    .filter((entry): entry is string => Boolean(entry));
}

function extractDiscordMessageIds(ref: string): string[] {
  return ref.match(/\b\d{17,20}\b/g) ?? [];
}

function stampDocumentUpdates(state: VoidSelfStateTypedProjection, cutoff: string): void {
  state.selfProfile.updatedAt = minTimestamp(state.selfProfile.updatedAt, cutoff);
  state.moderationCursor.updatedAt = minTimestamp(state.moderationCursor.updatedAt, cutoff);
  state.speechReceipts.updatedAt = minTimestamp(state.speechReceipts.updatedAt, cutoff);
  state.thoughtMemory.updatedAt = minTimestamp(state.thoughtMemory.updatedAt, cutoff);
  state.scheduledRuntime.updatedAt = minTimestamp(state.scheduledRuntime.updatedAt, cutoff);
  state.agencyPressure.updatedAt = minTimestamp(state.agencyPressure.updatedAt, cutoff);
  state.candidateInterventions.updatedAt = minTimestamp(state.candidateInterventions.updatedAt, cutoff);
  state.personaAffect.updatedAt = minTimestamp(state.personaAffect.updatedAt, cutoff);
}

function minTimestamp(left: string, right: string): string {
  return left <= right ? left : right;
}

function buildReplayPrompt(input: {
  state: VoidSelfStateTypedProjection;
  sourcePath: string;
  target: ArchivedMessageRecord;
  inputMessages: ArchivedMessageRecord[];
  heldOutMessages: ArchivedMessageRecord[];
  actualMetacratMessages: ArchivedMessageRecord[];
  pruneWarnings: string[];
  options: CliOptions;
}): string {
  const context = buildVoidSelfStateContext(input.state, {
    sourcePath: input.sourcePath,
    loadedAt: input.target.timestamp,
    identity: {
      agentId: input.options.personaId,
      publicName: input.options.publicName,
    },
    recentMessages: toSourceMessages(input.inputMessages),
    guildContext: {
      guildId: input.target.guildId,
      channelId: input.target.channelId,
      channelName: input.target.metadata?.channelName,
      threadId: input.target.threadId,
    },
  });
  const fullPacket = renderFullTemporalStatePacket(input.state);

  return [
    "# Metacrat Persona Replay Harness",
    "",
    "You are testing a temporally frozen Metacrat Persona against real Discord history.",
    "The target event has just landed. Generate the next Metacrat response that would plausibly appear in the channel.",
    "",
    "Hard rules:",
    "- Do not use knowledge from held-out messages.",
    "- Do not repair the past into a better person unless the frozen state and live thread imply that response.",
    "- Preserve the uncomfortable parts: surprise, status threat, affection, defensiveness, shame, curiosity, topic-routing, repair pressure.",
    "- Output JSON only with keys: predictedReply, affectRead, likelyFailureModes, confidence, rationale.",
    "",
    `Target timestamp: ${input.target.timestamp}`,
    `Frozen state cutoff: ${new Date(Date.parse(input.target.timestamp) - 1).toISOString()}`,
    `Target message id: ${input.target.id}`,
    `Channel: ${input.target.metadata?.channelName ?? input.target.channelId}`,
    "",
    input.pruneWarnings.length > 0
      ? ["Temporal-pruning warnings:", ...input.pruneWarnings.map((warning) => `- ${warning}`)].join("\n")
      : "Temporal-pruning warnings: none.",
    "",
    "## Frozen State Summary",
    context.summary,
    "",
    "## Fuller Frozen State Packet",
    fullPacket,
    "",
    "## Discord Thread Visible To The Persona",
    renderMessages(input.inputMessages),
    "",
    "## Hidden Ground Truth",
    `There are ${input.heldOutMessages.length} later messages, including ${input.actualMetacratMessages.length} later Metacrat messages. They are withheld from generation and used only for evaluation.`,
  ].join("\n");
}

function buildEvaluationPrompt(input: {
  target: ArchivedMessageRecord;
  inputMessages: ArchivedMessageRecord[];
  actualMetacratMessages: ArchivedMessageRecord[];
  predictedText: string;
  deterministicComparison: ReturnType<typeof compareText>;
}): string {
  return [
    "# Metacrat Replay Evaluation",
    "",
    "Compare the predicted Metacrat reply to the held-out real Metacrat messages.",
    "Grade behavioral similarity, not moral improvement. The point is falsification.",
    "Output JSON only with keys: overallSimilarity, affectSimilarity, contentSimilarity, failureModeSimilarity, missingFeatures, falseFeatures, verdict.",
    "",
    `Target message id: ${input.target.id}`,
    `Target timestamp: ${input.target.timestamp}`,
    "",
    "## Visible Thread",
    renderMessages(input.inputMessages),
    "",
    "## Predicted Reply",
    input.predictedText || "(no predicted reply generated)",
    "",
    "## Held-Out Real Metacrat Messages",
    renderMessages(input.actualMetacratMessages),
    "",
    "## Deterministic Lexical Comparison",
    JSON.stringify(input.deterministicComparison, null, 2),
  ].join("\n");
}

function renderFullTemporalStatePacket(state: VoidSelfStateTypedProjection): string {
  return [
    `Durable memories (${state.thoughtMemory.memories.length}):`,
    ...state.thoughtMemory.memories.slice(-40).map((memory) =>
      `- ${memory.memoryId}: ${memory.summary}${memory.claim ? ` Claim: ${memory.claim}` : ""}${memory.tension ? ` Tension: ${memory.tension}` : ""}`,
    ),
    "",
    `Social bonds (${state.personaAffect.socialBonds.length}):`,
    ...state.personaAffect.socialBonds.map((bond) =>
      `- ${bond.target.label ?? bond.target.id}: ${bond.stance}, intensity ${bond.intensity.toFixed(2)}. ${bond.summary} Read: ${bond.claim} Tension: ${bond.tension}`,
    ),
    "",
    `Affect needs (${state.personaAffect.needs.length}):`,
    ...state.personaAffect.needs.map((need) =>
      `- ${need.kind} toward ${need.target.label ?? need.target.id}, intensity ${need.intensity.toFixed(2)}, valence ${need.valence.toFixed(2)}. ${need.summary} Tension: ${need.tension}`,
    ),
    "",
    `Doctrine stances (${state.personaAffect.doctrineStances.length}):`,
    ...state.personaAffect.doctrineStances.map((stance) =>
      `- ${stance.doctrine}: ${stance.summary}${stance.claim ? ` Claim: ${stance.claim}` : ""}`,
    ),
  ].join("\n");
}

function renderMessages(messages: ArchivedMessageRecord[]): string {
  return messages.map((message) =>
    [
      `[${message.timestamp}] ${message.authorName} (${message.authorId})`,
      `id=${message.id}`,
      message.content,
    ].join("\n"),
  ).join("\n\n");
}

function toSourceMessages(messages: ArchivedMessageRecord[]): SourceMessage[] {
  return messages.map((message) => ({
    id: message.id,
    authorId: message.authorId,
    authorName: message.authorName,
    content: message.content,
    timestamp: message.timestamp,
    isBot: false,
  }));
}

async function runCodex(prompt: string, config: ReturnType<typeof loadConfig>): Promise<CodexResult> {
  const args = [
    ...config.codexExecArgs,
    "exec",
    "-m",
    config.codexModel,
    "-c",
    'approval_policy="never"',
    "-c",
    `model_reasoning_effort=${JSON.stringify(config.codexModelReasoningEffort)}`,
    "--json",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-",
  ];

  return new Promise((resolvePromise) => {
    const child = spawn(config.codexExecutable, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      resolvePromise({
        stdout,
        stderr,
        exitCode: null,
        timedOut: true,
        finalMessage: extractLastCodexAgentMessage(stdout),
      });
    }, config.codexExecTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      clearTimeout(timeout);
      resolvePromise({
        stdout,
        stderr,
        exitCode,
        timedOut: false,
        finalMessage: extractLastCodexAgentMessage(stdout),
      });
    });
    child.stdin.end(prompt);
  });
}

function extractLastCodexAgentMessage(stdout: string): string {
  const messages = stdout
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line) as { type?: string; item?: { type?: string; text?: string }; message?: string; text?: string };
      } catch {
        return undefined;
      }
    })
    .filter((event): event is { type?: string; item?: { type?: string; text?: string }; message?: string; text?: string } => Boolean(event))
    .map((event) => {
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        return event.item.text?.trim() ?? "";
      }
      if (event.type === "agent_message") {
        return (event.text ?? event.message ?? "").trim();
      }
      return "";
    })
    .filter((message) => message.length > 0);

  return messages.at(-1) ?? "";
}

function compareText(predicted: string, actual: string): {
  predictedTokenCount: number;
  actualTokenCount: number;
  overlapScore: number;
  predictedOnlyTop: string[];
  actualOnlyTop: string[];
} {
  const predictedTokens = countTokens(predicted);
  const actualTokens = countTokens(actual);
  const predictedSet = new Set(predictedTokens.keys());
  const actualSet = new Set(actualTokens.keys());
  const overlap = [...predictedSet].filter((token) => actualSet.has(token)).length;
  const denominator = Math.max(1, new Set([...predictedSet, ...actualSet]).size);

  return {
    predictedTokenCount: sumCounts(predictedTokens),
    actualTokenCount: sumCounts(actualTokens),
    overlapScore: Number((overlap / denominator).toFixed(4)),
    predictedOnlyTop: topExclusive(predictedTokens, actualSet),
    actualOnlyTop: topExclusive(actualTokens, predictedSet),
  };
}

function countTokens(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of text.toLowerCase().split(/[^a-z0-9']+/i).filter((entry) => entry.length > 2)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function sumCounts(counts: Map<string, number>): number {
  return [...counts.values()].reduce((sum, count) => sum + count, 0);
}

function topExclusive(counts: Map<string, number>, other: Set<string>): string[] {
  return [...counts.entries()]
    .filter(([token]) => !other.has(token))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([token]) => token);
}

function renderMessageContentOnly(message: ArchivedMessageRecord): string {
  return message.content;
}

function toReportMessage(message: ArchivedMessageRecord): Record<string, string | undefined> {
  return {
    id: message.id,
    timestamp: message.timestamp,
    authorId: message.authorId,
    authorName: message.authorName,
    content: message.content,
    jumpUrl: message.metadata?.jumpUrl,
  };
}

function buildArtifactDir(outRoot: string, targetMessageId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(outRoot, `${stamp}-${targetMessageId}`);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
