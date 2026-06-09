#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutPath = resolve(repoRoot, "docs", "architecture", "voidbot-provider-advertisements.fixture.json");

const providerAdvertisementDocumentType = "gamecult.eve.provider_advertisement";
const providerAdvertisementSchemaId = "gamecult.eve.provider_advertisement.v1";
const interfaceBindingDocumentType = "gamecult.eve.interface_binding";
const interfaceBindingSchemaId = "gamecult.eve.interface_binding.v1";
const surfaceStateDocumentType = "gamecult.eve.surface_state";
const surfaceStateSchemaId = "gamecult.eve.surface_state.v1";
const fixtureDocumentType = "voidbot.provider_advertisement_catalog";
const fixtureSchemaId = "voidbot.provider_advertisement_catalog.v0";
const verseId = "voidbot.local";

const args = parseArgs(process.argv.slice(2));
const outPath = resolve(repoRoot, args.out ?? defaultOutPath);
const catalog = buildCatalog();
validateCatalog(catalog);

const serialized = `${JSON.stringify(catalog, null, 2)}\n`;

if (args.check) {
  const existing = await readFile(outPath, "utf8");
  if (existing !== serialized) {
    throw new Error(`Provider advertisement fixture is stale: ${outPath}`);
  }
  console.log(`Provider advertisement fixture is current: ${outPath}`);
} else {
  await writeFile(outPath, serialized, "utf8");
  console.log(`Provider advertisement fixture written: ${outPath}`);
}

function buildCatalog() {
  const providers = [
    provider({
      id: "voidbot.discord",
      title: "VoidBot Discord",
      description: "Discord ingress, room obligations, direct mentions, speech receipts, moderation pressure, and delivery targets.",
      status: "planned-witness",
      surfaces: [
        surface("voidbot.discord.room_obligations", "Room obligations", "Open direct asks, moderation cases, recent speech receipts, and channel delivery targets."),
        surface("voidbot.discord.mention_queue", "Mention queue", "Role/name/bot mentions that become CTB obligations instead of direct provider jobs."),
      ],
      witnesses: [
        witness("voidbot.private_self_state", ".voidbot/private/void-self-state.cc", "VoidBot typed operations", ["void.moderation_cursor", "void.speech_receipts", "void.candidate_interventions"]),
        witness("voidbot.discord_archive", ".voidbot/rag/messages.json", "VoidBot raw archive", ["archived Discord messages", "forensic bot-directed prompts"]),
        witness("voidbot.moderation_status", ".voidbot/status/moderation-rumination.json", "VoidBot rumination runner", ["debug status only"]),
        witness("voidbot.pending_mentions", ".voidbot/status/void-moderation-pending-mentions.json", "VoidBot CTB scheduler", ["debug status only"]),
      ],
      commands: [
        command("discord.inspect_room_obligations", "read-only", "Load current open room obligations and speech receipts through the provider surface."),
        command("discord.inspect_delivery_targets", "read-only", "Load configured parent-owned delivery targets without sending speech."),
      ],
      owners: {
        state: "VoidBot typed self-state service",
        inspection: "VoidBot for Discord-specific obligations; Huginn for Persona/.cc generic inspection",
        presentation: "Eve/CultUI lowerings",
      },
    }),
    provider({
      id: "voidbot.reddit",
      title: "VoidBot Reddit",
      description: "r/GameCultOrg thread/post obligations, Persona-authored thread creation, moderation pressure, proposed replies, and Bifrost transport receipts.",
      status: "planned-witness",
      surfaces: [
        surface("voidbot.reddit.thread_obligations", "Thread obligations", "Open r/GameCultOrg post/comment obligations, moderation cases, Persona-authored thread ideas, and proposed reply targets."),
        surface("voidbot.reddit.transport_receipts", "Bifrost receipts", "Reddit viewing, posting, moderation-action, and receipt state owned by Bifrost."),
      ],
      witnesses: [
        witness("voidbot.private_self_state", ".voidbot/private/void-self-state.cc", "VoidBot typed operations", ["void.moderation_cursor", "void.speech_receipts", "void.candidate_interventions"]),
        witness("bifrost.reddit_threads", "BIFROST_ROOT CultCache/CultNet Reddit surfaces", "Bifrost", ["r/GameCultOrg thread context", "Persona-authored Reddit thread creation", "Reddit post/comment transport receipts"]),
      ],
      commands: [
        command("reddit.inspect_thread_obligations", "read-only", "Load r/GameCultOrg thread/post obligations projected through Bifrost."),
        command("reddit.inspect_transport_receipts", "read-only", "Inspect Bifrost Reddit transport receipts without posting."),
      ],
      owners: {
        state: "VoidBot typed self-state service for moderation judgment; Bifrost for Reddit transport state",
        inspection: "Bifrost for Reddit thread/receipt access; VoidBot for moderation obligations",
        presentation: "Eve/CultUI lowerings",
      },
    }),
    provider({
      id: "voidbot.archive",
      title: "VoidBot Archive",
      description: "Archived Discord corpus status, import/backfill health, bot-directed-prompt exclusion, and history retrieval caveats.",
      status: "planned-witness",
      surfaces: [
        surface("voidbot.archive.import_health", "Archive import health", "Discord archive freshness, backfill status, and ingestion warnings."),
        surface("voidbot.archive.retrieval_health", "History retrieval health", "Vector freshness and archive caveats for agent retrieval."),
      ],
      witnesses: [
        witness("voidbot.discord_archive", ".voidbot/rag/messages.json", "VoidBot raw archive", ["raw archive", "forensics"]),
        witness("voidbot.history_vectors", "qdrant://voidbot/history", "Qdrant", ["semantic history vectors"]),
        witness("voidbot.operations_health", ".voidbot/status/operations-health.json", "VoidBot watchdog", ["debug status only"]),
      ],
      commands: [
        command("archive.search_history", "read-only", "Search archived Discord history through VoidBot MCP/retrieval surfaces."),
        command("archive.get_message_context", "read-only", "Fetch a bounded context window around an archived Discord message."),
      ],
      owners: {
        state: "VoidBot archive and retrieval stack",
        inspection: "VoidBot MCP/retrieval tools",
        presentation: "Eve/CultUI lowerings",
      },
    }),
    provider({
      id: "voidbot.source",
      title: "VoidBot Source",
      description: "Indexed repo/lore coverage, repo shard status, vector collection health, and source reindex jobs.",
      status: "planned-witness",
      surfaces: [
        surface("voidbot.source.coverage", "Source coverage", "Indexed repository and lore coverage with shard freshness."),
        surface("voidbot.source.reindex_jobs", "Source reindex jobs", "Detached indexing job status and hook reconciliation pressure."),
      ],
      witnesses: [
        witness("voidbot.source_archive_manifest", ".voidbot/rag/source-documents.json", "VoidBot source archive", ["manifest"]),
        witness("voidbot.source_archive_shards", ".voidbot/rag/source-documents.repos/", "VoidBot source archive", ["per-repo source shards"]),
        witness("voidbot.source_vectors", "qdrant://voidbot/source", "Qdrant", ["semantic source vectors"]),
        witness("voidbot.source_hooks_status", ".voidbot/status/source-hooks/", "VoidBot source hook scripts", ["debug status only"]),
      ],
      commands: [
        command("source.search_sources", "read-only", "Search indexed source and lore repositories."),
        command("source.get_source_context", "read-only", "Fetch a bounded source chunk window from an indexed document."),
        command("source.list_indexed_repos", "read-only", "List indexed source/lore repositories visible to VoidBot."),
      ],
      owners: {
        state: "VoidBot RAG/source archive stack",
        inspection: "VoidBot MCP/retrieval tools",
        presentation: "Eve/CultUI lowerings",
      },
    }),
    provider({
      id: "voidbot.repo_face",
      title: "VoidBot Repo Face Compatibility",
      description: "Registered Face address book, repo-local state witnesses, channel grants, prompt assembly status, Bifrost digest availability, and Huginn inspection readiness.",
      status: "planned-handoff",
      surfaces: [
        surface("voidbot.repo_face.address_book", "Repo Face address book", "Role-backed Discord identity registry and webhook persona compatibility data."),
        surface("voidbot.repo_face.state_witnesses", "Repo Face state witnesses", "Repo-local .cc state paths and Huginn handoff readiness."),
        surface("voidbot.repo_face.prompt_assembly", "Prompt assembly", "Read-only status for state projection, channel grants, Bifrost digest reads, and current-room transcript attachment."),
      ],
      witnesses: [
        witness("voidbot.repo_discord_identities", "REPO_DISCORD_IDENTITIES_PATH", "VoidBot compatibility registry", ["Discord role ids", "webhook persona address book", "channel grants"]),
        witness("voidbot.repo_face_state", ".voidbot/private/repo-faces/<identity>.cc or repo-local Face state path", "VoidBot compatibility carrier", ["legacy Face .cc state witness"]),
        witness("gamecult.persona_state.v0", "E:/Projects/EpiphanyAgent/schemas/cultnet/gamecult.persona_state.v0.schema.json", "Epiphany Persona schema", ["portable Persona state schema"]),
      ],
      commands: [
        command("repo_face.list_identities", "read-only", "List registered repo Face Discord identities and compatibility metadata."),
        command("repo_face.inspect_prompt_packet", "read-only", "Render an exact Face prompt packet for diagnostics without queueing a turn."),
        command("repo_face.handoff_to_huginn", "handoff", "Ask Huginn to inspect, validate, migrate, or publish Persona/.cc state; VoidBot does not become the Persona steward."),
      ],
      owners: {
        state: "VoidBot compatibility registry for Discord addressing; repo-local owners for Face state",
        inspection: "Huginn for Persona/.cc stewardship",
        presentation: "Eve/CultUI lowerings",
      },
      demotions: [
        "VoidBot repo Face MCP state reads are diagnostics, not canonical Persona inspection.",
        "VoidBot registry data is a Discord compatibility projection, not portable Persona authority.",
        "Persona publication and .cc inspection readiness belong to Huginn once the handoff path exists.",
      ],
    }),
    provider({
      id: "voidbot.swarm",
      title: "VoidBot Swarm",
      description: "CTB initiative order, active turns, pause/heat/cadence controls, orchestrator organ health, and selected Face state witness.",
      status: "live",
      surfaces: [
        surface("voidbot.swarm.ctb_order", "CTB order", "Initiative order, active turns, recovery timing, pending mentions, and selected Face witness."),
        surface("voidbot.swarm.controls", "Swarm controls", "Pause, cadence, and manual turn request controls through the Eve binding."),
      ],
      witnesses: [
        witness("voidbot.swarm_state_snapshot", ".voidbot/status/cultmesh/voidbot-swarm-state.cc", "scripts/render-voidbot-swarm-dashboard.mjs", ["voidbot.swarm_state_snapshot", "gamecult.eve.provider_advertisement", "gamecult.eve.surface_state", "gamecult.eve.interface_binding"]),
        witness("voidbot.repo_face_heartbeat_state", ".voidbot/status/repo-face-heartbeats.json", "VoidBot CTB scheduler", ["debug/status source"]),
        witness("voidbot.orchestrator_state", ".voidbot/status/gamecult-orchestrator.json", "GameCult Local Orchestrator", ["debug/status source"]),
      ],
      commands: [
        command("swarm.inspect", "read-only", "Load the current CTB and selected Face state surface."),
        command("swarm.set_pause", "side-effecting", "Set the repo-controlled swarm pause flag through the provider-owned command boundary."),
        command("swarm.set_cadence_multiplier", "side-effecting", "Update scheduler cadence through the provider-owned command boundary."),
        command("swarm.force_turn", "side-effecting", "Queue a manual turn request through the provider-owned command boundary."),
      ],
      owners: {
        state: "VoidBot CTB heartbeat state and typed operation ports",
        inspection: "VoidBot swarm renderer for swarm-only state; Huginn for Persona/.cc detail",
        presentation: "Eve/CultUI lowerings",
      },
    }),
  ];

  return {
    documentType: fixtureDocumentType,
    schemaId: fixtureSchemaId,
    fixtureKind: "read-only-contract-export",
    note: "This tracked fixture advertises VoidBot Verse provider boundaries. It is not live service state, not a dashboard, and not a Persona inspection authority.",
    verseId,
    providerAdvertisement: {
      documentType: providerAdvertisementDocumentType,
      schemaId: providerAdvertisementSchemaId,
    },
    eveDocuments: {
      surfaceState: {
        documentType: surfaceStateDocumentType,
        schemaId: surfaceStateSchemaId,
      },
      interfaceBinding: {
        documentType: interfaceBindingDocumentType,
        schemaId: interfaceBindingSchemaId,
      },
    },
    cultMeshKeys: {
      providerCatalog: key("voidbot.providers"),
      providerAdvertisements: providers.map((item) => key(item.providerId)),
      surfaceStates: providers.map((item) => key(item.providerId)),
      interfaceBindings: providers.map((item) => key(item.providerId)),
      liveSwarmStore: ".voidbot/status/cultmesh/voidbot-swarm-state.cc",
    },
    huginnInspectionHandoff: {
      owner: "Huginn",
      scope: [
        "Persona-state schema availability",
        ".cc inspection and projection health",
        "Persona migration pressure",
        "CultMesh publication of Persona/.cc inspection surfaces",
        "Eve DSL emission for typed-state inspection",
      ],
      voidbotRole: [
        "Carries Discord compatibility registry data.",
        "Names repo Face .cc witness paths.",
        "Feeds context to Huginn when requested.",
        "Does not become the Persona runtime steward.",
      ],
      personaSchema: "E:/Projects/EpiphanyAgent/schemas/cultnet/gamecult.persona_state.v0.schema.json",
    },
    personaStateBoundaries: {
      portableAuthority: "gamecult.persona_state.v0",
      voidbotCompatibilityOnly: [
        "repo Discord identity registry",
        "webhook persona addressing",
        "repo Face .cc witness paths",
        "legacy MCP state diagnostics",
      ],
      forbiddenAuthority: [
        "VoidBot static HTML as Persona truth",
        "VoidBot private registry as portable Persona state",
        "Odin mutation of provider state",
        "Huginn inspection tools mutating VoidBot state outside advertised typed command ports",
      ],
    },
    providers,
  };
}

function provider(input) {
  return {
    schemaVersion: providerAdvertisementSchemaId,
    providerId: input.id,
    verseId,
    title: input.title,
    description: input.description,
    status: input.status,
    endpoint: `cultmesh://${verseId}/eve/providers/${input.id}`,
    documents: [
      document(providerAdvertisementDocumentType, providerAdvertisementSchemaId, input.id),
      document(surfaceStateDocumentType, surfaceStateSchemaId, input.id),
      document(interfaceBindingDocumentType, interfaceBindingSchemaId, input.id),
    ],
    surfaces: input.surfaces,
    commands: input.commands,
    witnesses: input.witnesses,
    owners: input.owners,
    demotions: input.demotions ?? [],
  };
}

function surface(id, title, purpose) {
  return { id, title, purpose, presentationOwner: "Eve/CultUI" };
}

function witness(id, path, owner, contains) {
  return { id, path, owner, contains };
}

function command(id, mode, purpose) {
  return { id, mode, purpose, advertisedOnly: true };
}

function document(type, schemaId, keyValue) {
  return { type, schemaId, key: keyValue };
}

function key(value) {
  return {
    verseId,
    key: value,
    endpoint: `cultmesh://${verseId}/eve/providers/${value}`,
  };
}

function validateCatalog(value) {
  const requiredProviders = ["voidbot.discord", "voidbot.reddit", "voidbot.archive", "voidbot.source", "voidbot.repo_face", "voidbot.swarm"];
  const providerIds = new Set(value.providers.map((providerItem) => providerItem.providerId));
  for (const providerId of requiredProviders) {
    if (!providerIds.has(providerId)) {
      throw new Error(`Missing provider advertisement for ${providerId}.`);
    }
  }
  for (const providerItem of value.providers) {
    for (const field of ["surfaces", "commands", "witnesses"]) {
      if (!Array.isArray(providerItem[field]) || providerItem[field].length === 0) {
        throw new Error(`${providerItem.providerId} must advertise ${field}.`);
      }
    }
  }
  if (!value.huginnInspectionHandoff?.owner || value.huginnInspectionHandoff.owner !== "Huginn") {
    throw new Error("Huginn inspection handoff must be explicit.");
  }
  if (!value.personaStateBoundaries?.portableAuthority) {
    throw new Error("Persona state boundary must name portable authority.");
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      parsed.check = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}
