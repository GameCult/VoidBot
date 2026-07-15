import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export interface AgentSwarmPause {
  paused: boolean;
  path: string;
  reason?: string;
}

export async function readAgentSwarmPause(input: { path?: string } = {}): Promise<AgentSwarmPause> {
  const path = resolve(input.path ?? resolve(process.cwd(), "state", "agent-swarm-paused.json"));
  try {
    const parsed = JSON.parse(stripLeadingBom(await readFile(path, "utf8"))) as Record<string, unknown>;
    return {
      paused: parsed.paused !== false,
      path,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { paused: false, path };
    }
    return { paused: true, path, reason: "Pause file exists but could not be parsed; failing closed." };
  }
}

export async function readSwarmControlState(input: {
  controlStorePath?: string;
  cwd?: string;
  loadControl?: (controlStorePath: string) => Promise<unknown> | unknown;
} = {}): Promise<{ globalHeat: number } | null> {
  const cwd = input.cwd ?? process.cwd();
  const controlStorePath = resolve(input.controlStorePath
    ?? process.env.VOIDBOT_SWARM_CONTROL_STORE
    ?? resolve(cwd, ".voidbot", "private", "swarm-controls.cc"));
  try {
    const value = input.loadControl
      ? await input.loadControl(controlStorePath)
      : await loadCultMeshControl(controlStorePath, cwd);
    const globalHeat = Number((value as { globalHeat?: unknown } | undefined)?.globalHeat);
    return Number.isFinite(globalHeat) && globalHeat >= 0.05 && globalHeat <= 2 ? { globalHeat } : null;
  } catch {
    return null;
  }
}

async function loadCultMeshControl(controlStorePath: string, cwd: string): Promise<unknown> {
  const cultMeshPackage = resolve(cwd, "..", "CultLib", "packages", "cultmesh-ts", "package.json");
  const { CultMesh } = createRequire(cultMeshPackage)("./dist/index.js");
  const cultCachePackage = resolve(cwd, "..", "CultLib", "packages", "cultcache-ts", "package.json");
  const { defineDocumentType } = createRequire(cultCachePackage)("./dist/index.js");
  const definition = defineDocumentType({
    type: "voidbot.swarm_control_state",
    schemaName: "voidbot.swarm_control_state",
    schemaId: "voidbot.swarm_control_state.v1",
    schemaVersion: "voidbot.swarm_control_state.v1",
    global: false,
    name: () => "voidbot-swarm",
    schema: {
      parse(value: unknown) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("VoidBot swarm control state must be an object.");
        }
        return value;
      },
    },
  });
  const node = await CultMesh.createNode(controlStorePath, { documents: [definition] });
  return node.get(definition, "voidbot-swarm");
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}
