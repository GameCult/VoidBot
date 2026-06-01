#!/usr/bin/env node
import "dotenv/config";

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const promptsRoot = resolve(repoRoot, "prompts");
const defaultScenarioPath = resolve(repoRoot, "scenarios", "cotsc-praxis-socratic-sermon.json");
const retrievalToolAllowlist = [
  "search_history",
  "get_message_context",
  "list_indexed_repos",
  "search_sources",
  "get_source_context",
  "search_web",
  "read_webpage",
].join(",");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarioPath = resolve(repoRoot, options.scenario ?? defaultScenarioPath);
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
  const maxPhases = numberOption(options["max-phases"], scenario.phases.length);
  const maxDepth = numberOption(options["max-depth"], scenario.ctb?.maxFaceTurnsPerPhase ?? scenario.ctb?.branchingLimit ?? 12);
  const generatedTurnBudget = numberOption(
    options["generated-turn-budget"],
    scenario.ctb?.generatedTurnBudgetPerPhase ?? scenario.ctb?.branchingLimit ?? maxDepth * (scenario.ctb?.choiceCount ?? 3),
  );
  const choiceCount = numberOption(options["choice-count"], scenario.ctb?.choiceCount ?? 3);
  const faceModel = options["face-model"] ?? process.env.REPO_FACE_TURN_CODEX_MODEL ?? "gpt-5.4";
  const mindModel = options["mind-model"] ?? process.env.REPO_FACE_MIND_CODEX_MODEL ?? "gpt-5.4";
  const voidModel = options["void-model"] ?? options.model ?? process.env.REPO_FACE_MIND_CODEX_MODEL ?? "gpt-5.4";
  const faceReasoningEffort = options["face-reasoning-effort"] ?? process.env.REPO_FACE_TURN_CODEX_REASONING_EFFORT ?? "low";
  const mindReasoningEffort = options["mind-reasoning-effort"] ?? process.env.REPO_FACE_MIND_CODEX_REASONING_EFFORT ?? "none";
  const voidReasoningEffort = options["void-reasoning-effort"] ?? "low";
  const foldMode = options["void-fold-mode"] ?? "generated";
  const turnInterpreterMode = options["turn-interpreter-mode"] ?? "model";
  const faceTurnMode = options["face-turn-mode"] ?? "model";
  const outPath = resolve(repoRoot, options.out ?? scenario.outputInkPath);
  const receiptPath = resolve(repoRoot, options.receipts ?? scenario.receiptPath);
  const progressPath = resolve(repoRoot, options.progress ?? ".voidbot/artifacts/socratic-ink/progress.json");
  const globalAgentDoctrine = await loadGlobalAgentDoctrine();
  const basePromptCache = new Map();
  const voiceCardCache = new Map();
  const receipts = {
    schemaVersion: "voidbot.socratic_ink_receipts.v0",
    scenarioPath,
    generatedAt: new Date().toISOString(),
    options: {
      maxPhases,
      maxDepth,
      generatedTurnBudget,
      choiceCount,
      faceModel,
      mindModel,
      voidModel,
      faceReasoningEffort,
      mindReasoningEffort,
      voidReasoningEffort,
      foldMode,
      turnInterpreterMode,
      faceTurnMode,
    },
    faceTurns: [],
    voidFolds: [],
    dramaturgy: [],
  };

  const actors = scenario.actors.map((actor, index) => ({
    ...actor,
    displayName: actor.displayName ?? actor.identityId,
    speed: Number.isFinite(actor.speed) ? actor.speed : 1,
    order: index,
    nextReady: index / Math.max(1, scenario.actors.length),
  }));
  const actorById = new Map(actors.map((actor) => [actor.identityId, actor]));

  const ink = [];
  ink.push(`// ghostlight.scenario: ${scenario.scenarioId}`);
  ink.push(`// ghostlight.generated_at: ${receipts.generatedAt}`);
  ink.push(`// ghostlight.receipts: ${toInkCommentPath(receiptPath)}`);
  ink.push(`VAR face_turns = 0`);
  ink.push(`VAR void_folds = 0`);
  ink.push("");
  ink.push(`// if.render: speaker-panel`);
  if (scenario.scene?.id) {
    ink.push(`// if.scene_id: ${scenario.scene.id}`);
  }
  if (scenario.scene?.background) {
    ink.push(`// if.background: ${scenario.scene.background}`);
  }
  ink.push("");
  ink.push(`# ${scenario.title}`);
  if (scenario.subtitle) {
    ink.push(`# ${scenario.subtitle}`);
  }
  ink.push("");
  const introduction = Array.isArray(scenario.introduction) ? scenario.introduction : [];
  ink.push(`-> ${introduction.length ? "intro_1" : "phase_1"}`);
  ink.push("");
  for (let index = 0; index < introduction.length; index += 1) {
    const knot = `intro_${index + 1}`;
    const next = index + 1 < introduction.length ? `intro_${index + 2}` : "phase_1";
    writeSpeakerKnot(ink, knot, scenario.voidRole?.displayName ?? "Void", scenario.voidRole?.avatarPath, introduction[index]);
    ink.push(`-> ${next}`);
    ink.push("");
  }

  const phaseCount = Math.min(maxPhases, scenario.phases.length);
  for (let phaseIndex = 0; phaseIndex < phaseCount; phaseIndex += 1) {
    const phase = scenario.phases[phaseIndex];
    const nextPhaseKnot = phaseIndex + 1 < phaseCount ? `phase_${phaseIndex + 2}` : "closing";
    const phaseCtb = cloneCtb(actors, phaseIndex * choiceCount);
    const phaseOpening = normalizeUtterances(phase.voidOpening);
    const phaseUsesDramaturgy = hasDramaturgicPhase(phase);
    writeSpeakerSequence(
      ink,
      `phase_${phaseIndex + 1}`,
      scenario.voidRole?.displayName ?? "Void",
      scenario.voidRole?.avatarPath,
      phaseOpening,
      phaseUsesDramaturgy ? dramaturgyRootName(phaseIndex) : nodeName(phaseIndex, []),
      [
        `ghostlight.phase_id: ${phase.phaseId}`,
        `ghostlight.topic: ${phase.topic}`,
      ],
    );

    const sharedPhaseInput = {
      scenario,
      phase,
      phaseIndex,
      nextPhaseKnot,
      maxDepth,
      generatedTurnBudget,
      choiceCount,
      ctb: phaseCtb,
      actorById,
      phaseState: {
        generatedFaceTurns: 0,
      },
      transcript: [
        ...introduction.map((text) => ({ speaker: "Void", text })),
        ...phaseOpening.map((text) => ({ speaker: "Void", text })),
      ],
      voidLine: phaseOpening.at(-1) ?? "",
      basePromptCache,
      voiceCardCache,
      globalAgentDoctrine,
      faceModel,
      mindModel,
      voidModel,
      faceReasoningEffort,
      mindReasoningEffort,
      voidReasoningEffort,
      foldMode,
      turnInterpreterMode,
      faceTurnMode,
      progressPath,
      ink,
      receipts,
    };
    if (phaseUsesDramaturgy) {
      await buildDramaturgicPhase({
        ...sharedPhaseInput,
        phaseRootKnot: dramaturgyRootName(phaseIndex),
      });
    } else {
      await buildBranchNode({
        ...sharedPhaseInput,
        depth: 0,
      });
    }
  }

  writeSpeakerSequence(ink, "closing", scenario.voidRole?.displayName ?? "Void", scenario.voidRole?.avatarPath, normalizeUtterances(scenario.closing), "END");

  await mkdir(dirname(outPath), { recursive: true });
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(outPath, `${ink.join("\n")}\n`, "utf8");
  await writeFile(receiptPath, `${JSON.stringify(receipts, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    scenarioId: scenario.scenarioId,
    outPath,
    receiptPath,
    faceTurns: receipts.faceTurns.length,
    voidFolds: receipts.voidFolds.length,
  }, null, 2)}\n`);
}

async function buildBranchNode(input) {
  const knot = nodeName(input.phaseIndex, input.transcriptPath ?? []);
  const path = input.transcriptPath ?? [];
  input.ink.push(`=== ${knot} ===`);
  input.ink.push(`// ghostlight.branch_depth: ${input.depth}`);
  input.ink.push(`// ghostlight.ctb_next: ${nextActors(input.ctb, input.choiceCount).map((actor) => actor.identityId).join(",")}`);
  input.ink.push(`// ghostlight.generated_face_turns: ${input.phaseState.generatedFaceTurns}/${input.generatedTurnBudget}`);
  input.ink.push(`// ghostlight.selected_turn_budget: ${input.depth}/${input.maxDepth}`);
  input.ink.push("");

  if (input.depth >= input.maxDepth) {
    await writeForcedFold(input, path);
    return;
  }

  const reusableOptions = (input.reusableOptions ?? [])
    .filter((option) => option.identityId !== input.lastSpeakerId)
    .slice(0, input.choiceCount);
  const candidates = [...reusableOptions];
  const reservedIds = new Set(candidates.map((option) => option.identityId));
  const perspectiveSlots = assignPerspectiveSlots(input, candidates.length, input.choiceCount);
  for (const actor of nextActors(input.ctb, input.choiceCount * 3)) {
    if (
      candidates.length >= input.choiceCount ||
      input.phaseState.generatedFaceTurns >= input.generatedTurnBudget
    ) {
      break;
    }
    if (reservedIds.has(actor.identityId)) {
      continue;
    }
    const readerPerspective = perspectiveSlots[candidates.length] ?? defaultReaderPerspective(input.phase, input.depth, candidates.length);
    const turn = await generateFaceTurn({ ...input, actor, readerPerspective });
    input.phaseState.generatedFaceTurns += 1;
    const option = {
      ...turn,
      identityId: actor.identityId,
      actor,
      generatedAtDepth: input.depth,
      readerPerspective,
    };
    candidates.push(option);
    reservedIds.add(actor.identityId);
  }

  if (candidates.length === 0) {
    await writeForcedFold(input, path);
    return;
  }

  const branches = [];
  for (const option of candidates) {
    const actor = option.actor;
    const turn = option;
    const choiceKnot = afterChoiceName(input.phaseIndex, path, actor.identityId);
    input.ink.push(`+ [${formatChoiceLabel(turn.displayName, turn.choiceLabel)}]`);
    input.ink.push(`  -> ${choiceKnot}`);
    input.ink.push("");

    const branchCtb = spendActor(input.ctb, actor, input.scenario.ctb?.recoveryBase ?? 1);
    const branchTranscript = [
      ...input.transcript,
      { speaker: turn.displayName, text: turn.speech },
    ];
    const branchPath = [...path, actor.identityId];
    const nextReusableOptions = candidates
      .filter((candidate) => candidate.identityId !== actor.identityId)
      .map((candidate) => ({ ...candidate }));
    branches.push({
      actor,
      turn,
      choiceKnot,
      branchCtb,
      branchTranscript,
      branchPath,
      nextReusableOptions,
    });
  }

  for (const branch of branches) {
    const {
      actor,
      turn,
      choiceKnot,
      branchCtb,
      branchTranscript,
      branchPath,
      nextReusableOptions,
    } = branch;
    writeSpeakerKnot(
      input.ink,
      choiceKnot,
      turn.displayName,
      actor.avatarPath,
      turn.speech,
      [
        `ghostlight.selected_face: ${actor.identityId}`,
        `ghostlight.reader_perspective: ${turn.readerPerspective?.label ?? ""}`,
        `ghostlight.unspent_faces: ${nextReusableOptions.map((candidate) => candidate.identityId).join(",")}`,
      ],
    );
    input.ink.push(`~ face_turns += 1`);
    if (input.depth + 1 < input.maxDepth) {
      const continueKnot = nodeName(input.phaseIndex, branchPath);
      input.ink.push(`-> ${continueKnot}`);
      input.ink.push("");
      await buildBranchNode({
        ...input,
        depth: input.depth + 1,
        ctb: branchCtb,
        transcript: branchTranscript,
        voidLine: turn.speech,
        transcriptPath: branchPath,
        reusableOptions: nextReusableOptions,
        lastSpeakerId: actor.identityId,
      });
    } else {
      const fold = await generateVoidFold({
        ...input,
        transcript: branchTranscript,
        actor,
      });
      input.ink.push(`-> ${foldName(input.phaseIndex, branchPath)}`);
      input.ink.push("");
      writeSpeakerSequence(
        input.ink,
        foldName(input.phaseIndex, branchPath),
        input.scenario.voidRole?.displayName ?? "Void",
        input.scenario.voidRole?.avatarPath,
        fold.panels ?? [fold.text],
        input.nextPhaseKnot,
        [],
        [`~ void_folds += 1`],
      );
    }
  }
}

async function buildDramaturgicPhase(input) {
  const plan = getDramaturgicPlan(input.phase);
  const rootBeatIds = plan.rootBeatIds.length
    ? plan.rootBeatIds
    : plan.beats.filter((beat) => !beat.respondsTo && !beat.parentId).map((beat) => beat.id);
  input.receipts.dramaturgy.push({
    phaseId: input.phase.phaseId,
    mode: "beat_graph",
    teachingGoal: plan.teachingGoal,
    foldInvariant: plan.foldInvariant,
    rootBeatIds,
    beatCount: plan.beats.length,
  });
  input.ink.push(`=== ${input.phaseRootKnot} ===`);
  input.ink.push(`// ghostlight.branch_mode: dramaturgic_beat_graph`);
  input.ink.push(`// ghostlight.phase_id: ${input.phase.phaseId}`);
  input.ink.push(`// ghostlight.teaching_goal: ${cleanSpeech(plan.teachingGoal)}`);
  input.ink.push(`// ghostlight.fold_invariant: ${cleanSpeech(plan.foldInvariant)}`);
  input.ink.push("");
  await writeDramaturgicChoices({
    ...input,
    plan,
    choiceKnot: input.phaseRootKnot,
    beatIds: rootBeatIds,
    transcript: input.transcript,
    ctb: input.ctb,
    path: [],
  });
}

async function writeDramaturgicChoices(input) {
  const beats = input.beatIds
    .map((beatId) => input.plan.beatById.get(beatId))
    .filter(Boolean);
  if (!beats.length) {
    await writeForcedFold(input, input.path);
    return;
  }
  const branches = [];
  for (const beat of beats) {
    const actor = selectBeatActor(input, beat);
    const displayName = actor?.displayName ?? beat.displayName ?? input.scenario.voidRole?.displayName ?? "Void";
    const beatPath = [...input.path, beat.id];
    const beatKnot = dramaturgyBeatName(input.phaseIndex, beatPath);
    const choiceLabel = beat.choiceLabel ?? beat.label ?? beat.stance ?? beat.brief ?? "Answer";
    input.ink.push(`+ [${formatChoiceLabel(displayName, choiceLabel)}]`);
    input.ink.push(`  -> ${beatKnot}`);
    input.ink.push("");
    branches.push({ beat, actor, beatKnot, beatPath });
  }
  for (const branch of branches) {
    await writeDramaturgicBeat({
      ...input,
      beat: branch.beat,
      actor: branch.actor,
      beatKnot: branch.beatKnot,
      path: branch.beatPath,
    });
  }
}

async function writeDramaturgicBeat(input) {
  const turn = await resolveDramaturgicBeatTurn(input);
  const speaker = input.actor?.displayName ?? input.beat.displayName ?? input.scenario.voidRole?.displayName ?? "Void";
  const avatarPath = input.actor?.avatarPath ?? input.scenario.voidRole?.avatarPath;
  const isVoid = !input.actor || input.beat.actorId === "void" || speaker === (input.scenario.voidRole?.displayName ?? "Void");
  const comments = [
    `ghostlight.branch_mode: dramaturgic_beat_graph`,
    `ghostlight.beat_id: ${input.beat.id}`,
    `ghostlight.beat_type: ${input.beat.beatType ?? input.beat.type ?? ""}`,
    `ghostlight.reader_pressure: ${cleanSpeech(input.beat.readerPressure ?? input.beat.readerPerspective?.label ?? "")}`,
    `ghostlight.tension: ${cleanSpeech(input.beat.tension ?? input.beat.dissonance ?? "")}`,
  ];
  writeSpeakerKnot(input.ink, input.beatKnot, speaker, avatarPath, turn.speech, comments);
  if (!isVoid) {
    input.ink.push(`~ face_turns += 1`);
  }
  for (const line of normalizeInkCommands(input.beat.setFlags ?? input.beat.commands)) {
    input.ink.push(line);
  }

  const transcript = [
    ...input.transcript,
    { speaker, text: turn.speech },
  ];
  const branchCtb = input.actor
    ? spendActor(input.ctb, input.actor, input.scenario.ctb?.recoveryBase ?? 1)
    : input.ctb;
  const childIds = normalizeBeatChildren(input.beat);
  if (childIds.length === 1 && isForcedChild(input.plan.beatById.get(childIds[0]))) {
    input.ink.push(`-> ${dramaturgyBeatName(input.phaseIndex, [...input.path, childIds[0]])}`);
    input.ink.push("");
    await writeDramaturgicBeat({
      ...input,
      beat: input.plan.beatById.get(childIds[0]),
      actor: selectBeatActor({ ...input, ctb: branchCtb }, input.plan.beatById.get(childIds[0])),
      beatKnot: dramaturgyBeatName(input.phaseIndex, [...input.path, childIds[0]]),
      path: [...input.path, childIds[0]],
      transcript,
      ctb: branchCtb,
    });
    return;
  }
  if (childIds.length > 0) {
    const choiceKnot = dramaturgyChoiceName(input.phaseIndex, input.path);
    input.ink.push(`-> ${choiceKnot}`);
    input.ink.push("");
    input.ink.push(`=== ${choiceKnot} ===`);
    input.ink.push(`// ghostlight.branch_mode: dramaturgic_beat_graph`);
    input.ink.push(`// ghostlight.after_beat: ${input.beat.id}`);
    input.ink.push("");
    await writeDramaturgicChoices({
      ...input,
      choiceKnot,
      beatIds: childIds,
      transcript,
      ctb: branchCtb,
      path: input.path,
    });
    return;
  }
  if (input.beat.foldAfter === false || input.beat.noFold === true) {
    input.ink.push(`-> ${input.nextPhaseKnot}`);
    input.ink.push("");
    return;
  }
  const fold = await generateVoidFold({
    ...input,
    transcript,
    ctb: branchCtb,
    depth: input.path.length,
    actor: input.actor,
  });
  const foldStart = dramaturgyFoldName(input.phaseIndex, input.path);
  input.ink.push(`-> ${foldStart}`);
  input.ink.push("");
  writeSpeakerSequence(
    input.ink,
    foldStart,
    input.scenario.voidRole?.displayName ?? "Void",
    input.scenario.voidRole?.avatarPath,
    fold.panels ?? [fold.text],
    input.nextPhaseKnot,
    [],
    [`~ void_folds += 1`],
  );
}

async function resolveDramaturgicBeatTurn(input) {
  const actor = input.actor;
  const displayName = actor?.displayName ?? input.beat.displayName ?? input.scenario.voidRole?.displayName ?? "Void";
  if (input.beat.speech) {
    const speech = cleanSpeakerPrefix(input.beat.speech, displayName);
    const choiceLabel = input.beat.choiceLabel ?? summarizeChoice(speech);
    input.receipts.faceTurns.push({
      phaseId: input.phase.phaseId,
      depth: input.path.length,
      identityId: actor?.identityId ?? "void",
      displayName,
      mode: "scripted_beat",
      beat: receiptBeat(input.beat),
      selectedSpeech: speech,
      choiceLabel,
    });
    await writeProgress(input);
    return { displayName, speech, choiceLabel };
  }
  if (!actor) {
    const speech = cleanSpeakerPrefix(input.beat.brief ?? input.beat.stance ?? "Hold that thought.", displayName);
    return { displayName, speech, choiceLabel: input.beat.choiceLabel ?? summarizeChoice(speech) };
  }
  if (input.faceTurnMode === "scripted") {
    const speech = cleanSpeakerPrefix(input.beat.brief ?? input.beat.stance ?? "I am not sure I buy that yet.", displayName);
    return { displayName, speech, choiceLabel: input.beat.choiceLabel ?? summarizeChoice(speech) };
  }
  return generateDramaturgicFaceTurn(input);
}

async function generateDramaturgicFaceTurn(input) {
  const actorVoiceCard = await getActorVoiceCard(input.actor, input.basePromptCache, input.voiceCardCache, input);
  const transcript = renderTranscript(input.transcript);
  const beat = input.beat;
  const prompt = renderTemplate("socratic-ink-face-beat.prompt.md", {
    actorVoiceCard,
    title: input.scenario.title,
    phaseTopic: input.phase.topic,
    phaseSetup: input.phase.laySetup ?? "Void has introduced only the immediate question. Keep the response accessible.",
    phaseLesson: input.phase.lesson ?? "",
    foldInvariant: input.plan.foldInvariant ?? "",
    beatType: beat.beatType ?? beat.type ?? "objection",
    beatBrief: beat.brief ?? beat.stance ?? "",
    beatTension: beat.tension ?? beat.dissonance ?? "",
    readerPressure: renderReaderPerspective(beat.readerPerspective ?? {
      label: beat.readerPressure ?? beat.label ?? "Reader pressure",
      stance: beat.stance ?? beat.brief ?? "Make the likely reader reaction concrete.",
      emotionalRegister: beat.emotionalRegister ?? beat.tone ?? "plain-spoken",
    }),
    respondsTo: beat.respondsTo ?? beat.parentId ?? "",
    voidLine: input.transcript.at(-1)?.text ?? "",
    transcript,
    actorRole: input.actor.role ?? "",
    displayName: input.actor.displayName ?? input.actor.identityId,
    depth: input.path.length,
  });
  const faceRun = await runCodex(prompt, {
    model: input.faceModel,
    reasoningEffort: input.faceReasoningEffort,
    mcpMode: "real-readonly",
    timeoutMs: 240_000,
  });
  const faceText = extractFinalText(parseJsonEvents(faceRun.stdout), faceRun.stdout);
  const parsedFace = parseFaceResponse(faceText, input.actor);
  const mindPrompt = renderTemplate("socratic-ink-turn-interpreter.prompt.md", {
    displayName: input.actor.displayName ?? input.actor.identityId,
    actorRole: input.actor.role ?? "",
    phaseSetup: input.phase.laySetup ?? "",
    voidLine: input.transcript.at(-1)?.text ?? "",
    transcript,
    draftResponse: faceText,
  });
  let mindRun;
  let mindText;
  let parsedMind;
  if (input.turnInterpreterMode === "local") {
    parsedMind = localArticleInterpretation(parsedFace, faceText, input.actor);
    mindRun = { code: 0, durationMs: 0, stderr: "" };
    mindText = JSON.stringify(parsedMind);
  } else {
    mindRun = await runCodex(mindPrompt, {
      model: input.mindModel,
      reasoningEffort: input.mindReasoningEffort,
      mcpMode: "none",
      timeoutMs: 240_000,
    });
    mindText = extractFinalText(parseJsonEvents(mindRun.stdout), mindRun.stdout);
    parsedMind = parseArticleInterpreterOutput(mindText);
  }
  const speech = cleanSpeakerPrefix(parsedMind.speech || parsedFace.speech || faceText, input.actor.displayName ?? input.actor.identityId);
  const choiceLabel = parsedMind.choiceLabel || parsedFace.choiceLabel || `${input.actor.displayName ?? input.actor.identityId}: ${speech}`;
  input.receipts.faceTurns.push({
    phaseId: input.phase.phaseId,
    depth: input.path.length,
    identityId: input.actor.identityId,
    displayName: input.actor.displayName ?? input.actor.identityId,
    mode: "dramaturgic_beat",
    beat: receiptBeat(input.beat),
    prompt,
    face: {
      exitCode: faceRun.code,
      durationMs: faceRun.durationMs,
      text: faceText,
      parsed: parsedFace,
      stderrTail: faceRun.stderr.slice(-2000),
    },
    mind: {
      mode: input.turnInterpreterMode,
      prompt: input.turnInterpreterMode === "local" ? undefined : mindPrompt,
      exitCode: mindRun.code,
      durationMs: mindRun.durationMs,
      text: mindText,
      parsed: parsedMind,
      stderrTail: mindRun.stderr.slice(-2000),
    },
    selectedSpeech: speech,
    choiceLabel,
  });
  await writeProgress(input);
  return { displayName: input.actor.displayName ?? input.actor.identityId, speech, choiceLabel };
}

async function writeForcedFold(input, path) {
  const fold = await generateVoidFold(input);
  const foldStart = foldName(input.phaseIndex, path);
  input.ink.push(`+ [Void: Bring the thread back to the lesson]`);
  input.ink.push(`  -> ${foldStart}`);
  input.ink.push("");
  writeSpeakerSequence(
    input.ink,
    foldStart,
    input.scenario.voidRole?.displayName ?? "Void",
    input.scenario.voidRole?.avatarPath,
    fold.panels ?? [fold.text],
    input.nextPhaseKnot,
    [],
    [`~ void_folds += 1`],
  );
}

async function generateFaceTurn(input) {
  const actorVoiceCard = await getActorVoiceCard(input.actor, input.basePromptCache, input.voiceCardCache, input);
  const transcript = renderTranscript(input.transcript);
  const prompt = renderTemplate("socratic-ink-face-turn.prompt.md", {
    actorVoiceCard,
    title: input.scenario.title,
    phaseTopic: input.phase.topic,
    phaseSetup: input.phase.laySetup ?? "Void has introduced only the immediate question. Keep the response accessible.",
    commonCounterarguments: renderList(input.phase.commonCounterarguments ?? input.scenario.commonCounterarguments ?? []),
    readerPerspective: renderReaderPerspective(input.readerPerspective),
    voidLine: input.voidLine,
    transcript,
    actorRole: input.actor.role ?? "",
    displayName: input.actor.displayName ?? input.actor.identityId,
    depth: input.depth,
  });
  const faceRun = await runCodex(prompt, {
    model: input.faceModel,
    reasoningEffort: input.faceReasoningEffort,
    mcpMode: "real-readonly",
    timeoutMs: 240_000,
  });
  const faceText = extractFinalText(parseJsonEvents(faceRun.stdout), faceRun.stdout);
  const parsedFace = parseFaceResponse(faceText, input.actor);
  const mindPrompt = renderTemplate("socratic-ink-turn-interpreter.prompt.md", {
    displayName: input.actor.displayName ?? input.actor.identityId,
    actorRole: input.actor.role ?? "",
    phaseSetup: input.phase.laySetup ?? "",
    voidLine: input.voidLine,
    transcript,
    draftResponse: faceText,
  });
  let mindRun;
  let mindText;
  let parsedMind;
  if (input.turnInterpreterMode === "local") {
    parsedMind = localArticleInterpretation(parsedFace, faceText, input.actor);
    mindRun = { code: 0, durationMs: 0, stderr: "" };
    mindText = JSON.stringify(parsedMind);
  } else {
    mindRun = await runCodex(mindPrompt, {
      model: input.mindModel,
      reasoningEffort: input.mindReasoningEffort,
      mcpMode: "none",
      timeoutMs: 240_000,
    });
    mindText = extractFinalText(parseJsonEvents(mindRun.stdout), mindRun.stdout);
    parsedMind = parseArticleInterpreterOutput(mindText);
  }
  const speech = cleanSpeakerPrefix(parsedMind.speech || parsedFace.speech || faceText, input.actor.displayName ?? input.actor.identityId);
  const choiceLabel = parsedMind.choiceLabel || parsedFace.choiceLabel || `${input.actor.displayName ?? input.actor.identityId}: ${speech}`;
  const receipt = {
    phaseId: input.phase.phaseId,
    depth: input.depth,
    identityId: input.actor.identityId,
    displayName: input.actor.displayName ?? input.actor.identityId,
    readerPerspective: input.readerPerspective,
    prompt,
    face: {
      exitCode: faceRun.code,
      durationMs: faceRun.durationMs,
      text: faceText,
      parsed: parsedFace,
      stderrTail: faceRun.stderr.slice(-2000),
    },
    mind: {
      mode: input.turnInterpreterMode,
      prompt: input.turnInterpreterMode === "local" ? undefined : mindPrompt,
      exitCode: mindRun.code,
      durationMs: mindRun.durationMs,
      text: mindText,
      parsed: parsedMind,
      stderrTail: mindRun.stderr.slice(-2000),
    },
    selectedSpeech: speech,
    choiceLabel,
  };
  input.receipts.faceTurns.push(receipt);
  await writeProgress(input);
  return {
    displayName: input.actor.displayName ?? input.actor.identityId,
    speech,
    choiceLabel,
  };
}

async function generateVoidFold(input) {
  if (input.foldMode === "template") {
    const configuredPanels = input.beat?.foldPanels ?? input.phase.foldPanels;
    const configuredTarget = input.beat?.foldTarget ?? input.phase.foldTarget;
    const panels = configuredPanels?.length
      ? normalizeUtterances(configuredPanels)
      : [`Hold that answer.`, `The next question is simpler and sharper: ${configuredTarget}`];
    const text = panels.join(" ");
  input.receipts.voidFolds.push({ phaseId: input.phase.phaseId, depth: input.depth, mode: "template", text, panels });
    await writeProgress(input);
    return { text, panels };
  }
  const prompt = renderTemplate("socratic-ink-void-fold.prompt.md", {
    globalAgentDoctrine: input.globalAgentDoctrine,
    title: input.scenario.title,
    phaseTopic: input.phase.topic,
    phaseLesson: input.phase.lesson,
    foldTarget: input.phase.foldTarget,
    transcript: renderTranscript(input.transcript),
  });
  const run = await runCodex(prompt, {
    model: input.voidModel,
    reasoningEffort: input.voidReasoningEffort,
    mcpMode: "none",
    timeoutMs: 180_000,
  });
  const text = cleanSpeakerPrefix(extractFinalText(parseJsonEvents(run.stdout), run.stdout), "Void");
  const panels = splitVoidPanels(text);
  input.receipts.voidFolds.push({
    phaseId: input.phase.phaseId,
    depth: input.depth,
    mode: "generated",
    prompt,
    exitCode: run.code,
    durationMs: run.durationMs,
    text,
    panels,
    stderrTail: run.stderr.slice(-2000),
  });
  await writeProgress(input);
  return { text, panels };
}

async function getBaseFacePrompt(identityId, cache) {
  if (cache.has(identityId)) {
    return cache.get(identityId);
  }
  const outPath = resolve(repoRoot, ".voidbot", "artifacts", "socratic-ink", "base-prompts", `${identityId}.md`);
  await mkdir(dirname(outPath), { recursive: true });
  await runProcess(process.execPath, [
    resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    resolve(repoRoot, "scripts", "run-repo-face-heartbeats.ts"),
    "--assemble-prompt",
    identityId,
    "--out",
    outPath,
  ], { cwd: repoRoot, timeoutMs: 180_000 });
  const prompt = await readFile(outPath, "utf8");
  cache.set(identityId, prompt);
  return prompt;
}

async function getActorVoiceCard(actor, basePromptCache, voiceCardCache, input) {
  if (voiceCardCache.has(actor.identityId)) {
    return voiceCardCache.get(actor.identityId);
  }
  const baseFacePrompt = await getBaseFacePrompt(actor.identityId, basePromptCache);
  const prompt = renderTemplate("socratic-ink-face-projector.prompt.md", {
    baseFacePrompt,
    actorRole: actor.role ?? "",
  });
  const run = await runCodex(prompt, {
    model: input.mindModel,
    reasoningEffort: input.mindReasoningEffort,
    mcpMode: "none",
    timeoutMs: 180_000,
  });
  const text = extractFinalText(parseJsonEvents(run.stdout), run.stdout);
  const voiceCard = section(text, "VOICE CARD") || text.trim();
  voiceCardCache.set(actor.identityId, voiceCard);
  input.receipts.voiceCards ??= [];
  input.receipts.voiceCards.push({
    identityId: actor.identityId,
    displayName: actor.displayName ?? actor.identityId,
    prompt,
    exitCode: run.code,
    durationMs: run.durationMs,
    text,
    voiceCard,
    stderrTail: run.stderr.slice(-2000),
  });
  await writeProgress(input);
  return voiceCard;
}

async function writeProgress(input) {
  if (!input.progressPath) {
    return;
  }
  await mkdir(dirname(input.progressPath), { recursive: true });
  await writeFile(input.progressPath, `${JSON.stringify({
    scenarioId: input.scenario.scenarioId,
    generatedAt: new Date().toISOString(),
    phaseId: input.phase?.phaseId,
    generatedFaceTurns: input.phaseState?.generatedFaceTurns,
    selectedTurnBudget: input.maxDepth,
    faceTurns: input.receipts.faceTurns.length,
    voidFolds: input.receipts.voidFolds.length,
    voiceCards: input.receipts.voiceCards?.length ?? 0,
  }, null, 2)}\n`, "utf8");
}

function assignPerspectiveSlots(input, alreadyFilled, choiceCount) {
  const slots = [];
  for (let index = alreadyFilled; index < choiceCount; index += 1) {
    slots[index] = defaultReaderPerspective(input.phase, input.depth, index);
  }
  return slots;
}

function hasDramaturgicPhase(phase) {
  return getDramaturgicPlan(phase).beats.length > 0;
}

function getDramaturgicPlan(phase) {
  const source = phase.argumentMap ?? phase.dramaturgy ?? {};
  const rawBeats = source.beats ?? phase.argumentBeats ?? [];
  const beats = [];
  const visit = (beat, parentId) => {
    if (!beat || typeof beat !== "object") {
      return;
    }
    const id = safeId(beat.id ?? `${parentId ?? "beat"}_${beats.length + 1}`);
    const children = [];
    for (const child of beat.children ?? []) {
      if (typeof child === "string") {
        children.push(child);
      } else if (child && typeof child === "object") {
        const childId = safeId(child.id ?? `${id}_${children.length + 1}`);
        children.push(childId);
        visit({ ...child, id: childId }, id);
      }
    }
    beats.push({
      ...beat,
      id,
      parentId: beat.parentId ?? parentId,
      children,
    });
  };
  for (const beat of rawBeats) {
    visit(beat, beat.parentId);
  }
  const beatById = new Map(beats.map((beat) => [beat.id, beat]));
  const rootBeatIds = (source.rootBeatIds ?? source.roots ?? phase.rootBeatIds ?? [])
    .map((id) => safeId(id))
    .filter((id) => beatById.has(id));
  return {
    mode: source.mode ?? "beat_graph",
    teachingGoal: source.teachingGoal ?? phase.lesson ?? "",
    foldInvariant: source.foldInvariant ?? phase.foldTarget ?? "",
    beats,
    beatById,
    rootBeatIds,
  };
}

function normalizeBeatChildren(beat) {
  return (beat?.children ?? [])
    .map((child) => typeof child === "string" ? safeId(child) : safeId(child?.id))
    .filter(Boolean);
}

function isForcedChild(beat) {
  return Boolean(beat) && beat.choice !== true && beat.forced !== false;
}

function selectBeatActor(input, beat) {
  if (!beat) {
    return undefined;
  }
  const actorId = beat.actorId ?? beat.identityId ?? beat.actor;
  if (actorId && String(actorId).toLowerCase() !== "void") {
    return input.actorById.get(String(actorId));
  }
  if (String(actorId).toLowerCase() === "void" || String(beat.speaker ?? "").toLowerCase() === "void") {
    return undefined;
  }
  const preferred = nextActors(input.ctb, 1)[0];
  return preferred;
}

function normalizeInkCommands(value) {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .map((line) => cleanSpeech(line))
    .filter(Boolean)
    .map((line) => line.startsWith("~") ? line : `~ ${line}`);
}

function receiptBeat(beat) {
  return {
    id: beat.id,
    actorId: beat.actorId ?? beat.identityId ?? beat.actor,
    beatType: beat.beatType ?? beat.type,
    readerPressure: beat.readerPressure ?? beat.readerPerspective?.label,
    tension: beat.tension ?? beat.dissonance,
    respondsTo: beat.respondsTo ?? beat.parentId,
    children: normalizeBeatChildren(beat),
  };
}

function defaultReaderPerspective(phase, depth, optionIndex) {
  const phasePerspectives = Array.isArray(phase.readerPerspectives) ? phase.readerPerspectives : [];
  const commonCounterarguments = Array.isArray(phase.commonCounterarguments) ? phase.commonCounterarguments : [];
  const source = phasePerspectives.length ? phasePerspectives : commonCounterarguments.map((entry, index) => ({
    label: `Reader concern ${index + 1}`,
    stance: entry,
    emotionalRegister: "curious but unconvinced",
  }));
  const selected = source[(depth * 3 + optionIndex) % Math.max(1, source.length)] ?? {};
  return {
    label: selected.label ?? `Reader concern ${optionIndex + 1}`,
    stance: selected.stance ?? String(selected),
    emotionalRegister: selected.emotionalRegister ?? selected.tone ?? "plain-spoken uncertainty",
  };
}

function renderReaderPerspective(value) {
  if (!value) {
    return "- Label: ordinary reader reaction\n- Stance: Answer Void from a concrete layperson worry.\n- Emotional register: plain-spoken uncertainty.";
  }
  return [
    `- Label: ${cleanSpeech(value.label)}`,
    `- Stance: ${cleanSpeech(value.stance)}`,
    `- Emotional register: ${cleanSpeech(value.emotionalRegister)}`,
  ].join("\n");
}

function nextActors(ctb, count) {
  return [...ctb]
    .sort((left, right) =>
      left.nextReady - right.nextReady ||
      right.speed - left.speed ||
      left.order - right.order
    )
    .slice(0, count);
}

function spendActor(ctb, selected, recoveryBase) {
  const clock = selected.nextReady;
  return ctb.map((actor) => {
    if (actor.identityId !== selected.identityId) {
      return { ...actor };
    }
    return {
      ...actor,
      nextReady: clock + (recoveryBase / Math.max(0.1, actor.speed)),
    };
  });
}

function cloneCtb(actors, phaseOffset = 0) {
  const count = Math.max(1, actors.length);
  return actors.map((actor) => ({
    ...actor,
    nextReady: ((actor.order - phaseOffset) % count + count) % count / count,
  }));
}

function nodeName(phaseIndex, path) {
  return `p${phaseIndex + 1}_${path.length === 0 ? "root" : path.map(safeId).join("_")}`;
}

function dramaturgyRootName(phaseIndex) {
  return `p${phaseIndex + 1}_argument_root`;
}

function dramaturgyBeatName(phaseIndex, path) {
  return `p${phaseIndex + 1}_beat_${path.map(safeId).join("_")}`;
}

function dramaturgyChoiceName(phaseIndex, path) {
  return `p${phaseIndex + 1}_choice_${path.map(safeId).join("_")}`;
}

function dramaturgyFoldName(phaseIndex, path) {
  return `p${phaseIndex + 1}_fold_${path.map(safeId).join("_")}`;
}

function afterChoiceName(phaseIndex, path, identityId) {
  return `${nodeName(phaseIndex, path)}__after_${safeId(identityId)}`;
}

function foldName(phaseIndex, path) {
  return `${nodeName(phaseIndex, path)}__void_fold`;
}

function safeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

function writeSpeakerKnot(ink, knot, speaker, avatarPath, speech, comments = []) {
  ink.push(`=== ${knot} ===`);
  for (const comment of comments) {
    ink.push(`// ${comment}`);
  }
  ink.push(`# speaker: ${speaker}`);
  if (avatarPath) {
    ink.push(`# avatar: ${avatarPath}`);
  }
  ink.push(cleanSpeakerPrefix(speech, speaker));
}

function writeSpeakerSequence(ink, baseKnot, speaker, avatarPath, utterances, finalTarget, comments = [], beforeFinalDivert = []) {
  const panels = normalizeUtterances(utterances);
  for (let index = 0; index < panels.length; index += 1) {
    const knot = index === 0 ? baseKnot : `${baseKnot}_${index + 1}`;
    const next = index + 1 < panels.length ? `${baseKnot}_${index + 2}` : finalTarget;
    writeSpeakerKnot(ink, knot, speaker, avatarPath, panels[index], index === 0 ? comments : []);
    if (index + 1 === panels.length) {
      for (const line of beforeFinalDivert) {
        ink.push(line);
      }
    }
    ink.push(next === "END" ? "-> END" : `-> ${next}`);
    ink.push("");
  }
}

function normalizeUtterances(value) {
  const raw = Array.isArray(value) ? value : [value];
  const cleaned = raw.map((entry) => cleanSpeech(entry)).filter(Boolean);
  return cleaned.length ? cleaned : [""];
}

function splitVoidPanels(value) {
  const text = cleanSpeakerPrefix(value, "Void");
  const sentences = text.match(/[^.!?]+[.!?]+(?:["']|\)|\])?/g) ?? [text];
  const panels = [];
  let current = "";
  for (const sentence of sentences.map((entry) => entry.trim()).filter(Boolean)) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > 320 && current) {
      panels.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) {
    panels.push(current);
  }
  return panels.length ? panels : [text];
}

function renderList(items) {
  const list = Array.isArray(items) ? items : [items];
  const cleaned = list.map((item) => cleanSpeech(item)).filter(Boolean);
  return cleaned.length ? cleaned.map((item) => `- ${item}`).join("\n") : "- No specific counterargument assigned; choose the most natural reader objection for this moment.";
}

function formatChoiceLabel(displayName, value) {
  const label = sanitizeChoiceLabel(value);
  const withoutName = label.replace(new RegExp(`^${escapeRegExp(displayName)}\\s*:\\s*`, "i"), "");
  return sanitizeChoiceLabel(`${displayName}: ${withoutName}`);
}

function summarizeChoice(value) {
  const sentences = cleanSpeech(value)
    .replace(/^["']|["']$/g, "")
    .split(/[.?!]/)[0]
    .trim();
  if (/^(good|right|yes|exactly|hold that answer)\b/i.test(sentences)) {
    return "Bring this back to the lesson";
  }
  return sentences.slice(0, 96) || "Bring this back to the lesson";
}

function sanitizeChoiceLabel(value) {
  return cleanSpeech(value)
    .replace(/[\[\]\{\}\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140) || "Someone answers Void";
}

function quoteInk(value) {
  const cleaned = cleanSpeech(value).replace(/"/g, '\\"');
  return `"${cleaned}"`;
}

function cleanSpeech(value) {
  return normalizeAscii(String(value ?? ""))
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSpeakerPrefix(value, speaker) {
  const cleaned = cleanSpeech(value)
    .replace(/^["']|["']$/g, "")
    .trim();
  return cleaned.replace(new RegExp(`^(?:${escapeRegExp(speaker)}|Void)\\s*(?:says\\s*)?:\\s*`, "i"), "").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeAscii(value) {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, "--")
    .replace(/\u2013/g, "-")
    .replace(/\u2026/g, "...");
}

function renderTranscript(entries) {
  if (!entries.length) {
    return "- No prior branch dialogue.";
  }
  return entries.map((entry) => `- ${entry.speaker}: ${entry.text}`).join("\n");
}

function parseFaceResponse(text, actor) {
  const choiceLabel = section(text, "CHOICE LABEL") || "";
  const speech = section(text, "SPOKEN RESPONSE") || "";
  const privateNote = section(text, "PRIVATE NOTE") || "";
  return {
    choiceLabel: cleanSpeech(choiceLabel),
    speech: cleanSpeech(speech),
    privateNote: cleanSpeech(privateNote),
  };
}

function parseArticleInterpreterOutput(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(cleaned);
    return {
      choiceLabel: cleanSpeech(parsed.choice_label ?? parsed.choiceLabel ?? ""),
      speech: cleanSpeech(parsed.speech ?? ""),
      privateNote: cleanSpeech(parsed.private_note ?? parsed.privateNote ?? ""),
    };
  } catch {
    return {
      choiceLabel: section(text, "choice_label") || section(text, "CHOICE LABEL") || "",
      speech: section(text, "speech") || section(text, "SPOKEN RESPONSE") || cleanSpeech(text),
      privateNote: section(text, "private_note") || section(text, "PRIVATE NOTE") || "",
    };
  }
}

function localArticleInterpretation(parsedFace, faceText, actor) {
  const displayName = actor.displayName ?? actor.identityId;
  const speech = cleanSpeakerPrefix(parsedFace.speech || faceText, displayName);
  const choiceLabel = formatChoiceLabel(displayName, parsedFace.choiceLabel || speech);
  return {
    choiceLabel,
    speech,
    privateNote: parsedFace.privateNote || "Local article interpreter preserved the strict Face response shape.",
  };
}

function section(text, label) {
  const pattern = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z ]+:|$)`, "i");
  return text.match(pattern)?.[1]?.trim();
}

function parseInterpreterOutput(text) {
  const decision = text.match(/decision:\s*(route|retry|drop)/i)?.[1]?.toLowerCase();
  return {
    decision,
    blocks: parseDslBlocks(text),
  };
}

function parseDslBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const kind = ["STATE NOTE", "SAY", "ARTICLE", "BIFROST TOPIC"].includes(lines[index].trim().toUpperCase())
      ? lines[index].trim().toUpperCase()
      : undefined;
    if (!kind) {
      continue;
    }
    const body = [];
    index += 1;
    while (index < lines.length && lines[index].trim() !== "END") {
      body.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind, fields: parseDslFields(body) });
  }
  return blocks;
}

function parseDslFields(lines) {
  const fields = {};
  let key;
  let value = [];
  const flush = () => {
    if (key) {
      fields[key] = value.join("\n").trim();
    }
  };
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (match) {
      flush();
      key = match[1];
      const inlineValue = match[2].trim();
      value = inlineValue && inlineValue !== "|" && inlineValue !== ">" ? [match[2]] : [];
      continue;
    }
    if (key) {
      value.push(line.replace(/^\s{2}/, ""));
    }
  }
  flush();
  return fields;
}

function runCodex(prompt, input) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const args = [
      ...splitArgs(process.env.CODEX_EXEC_ARGS ?? ""),
      "exec",
      "-m",
      input.model,
      "-c",
      'approval_policy="never"',
      "-c",
      `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
      "--json",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "-",
    ];
    if (input.mcpMode === "real-readonly") {
      args.splice(
        args.indexOf("--json"),
        0,
        "-c",
        `mcp_servers.voidbot.env.VOIDBOT_MCP_TOOL_ALLOWLIST=${JSON.stringify(retrievalToolAllowlist)}`,
      );
    }
    const child = spawn(process.env.CODEX_EXECUTABLE ?? "codex", args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(prompt);
    const timer = setTimeout(() => child.kill(), input.timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, durationMs: Date.now() - started, stdout, stderr });
    });
  });
}

function runProcess(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveRun({ code, signal, stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${code ?? signal}\n${stderr}\n${stdout}`));
      }
    });
  });
}

function parseJsonEvents(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

function extractFinalText(events, stdout) {
  const messages = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => String(event.item.text ?? "").trim())
    .filter(Boolean);
  return messages.at(-1) ?? stdout.trim();
}

function renderTemplate(name, variables) {
  let template = readFileSync(resolve(promptsRoot, name), "utf8");
  for (const [key, value] of Object.entries(variables)) {
    template = template.replaceAll(`{{${key}}}`, String(value ?? ""));
  }
  return template;
}

async function loadGlobalAgentDoctrine() {
  const candidates = [
    process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME, "AGENTS.md") : undefined,
    process.env.USERPROFILE ? resolve(process.env.USERPROFILE, ".codex", "AGENTS.md") : undefined,
    resolve(homedir(), ".codex", "AGENTS.md"),
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try {
      const content = await readFile(candidate, "utf8");
      if (content.trim()) {
        return content.trim();
      }
    } catch {
      // Try the next known global doctrine path.
    }
  }
  return "# Global Agent Instructions Unavailable\n\nNo readable global AGENTS.md file was found.";
}

function splitArgs(value) {
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((entry) => entry.replace(/^"|"$/g, "")) ?? [];
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toInkCommentPath(path) {
  return path.replace(/\\/g, "/");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
