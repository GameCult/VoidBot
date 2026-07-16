import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { RepoFacePendingMention } from "@voidbot/core";

export interface VoidModerationTurnInput {
  queuedAt: string;
  storageRoot: string;
  pendingMentions: RepoFacePendingMention[];
  workspaceRoot?: string;
  handshakeTimeoutMs?: number;
}

export interface VoidModerationTurnReceipt {
  created: boolean;
  activeJobId?: string;
  requestMessageId: string;
  failureReason?: string;
}

interface VoidModerationActuatorDependencies {
  launch?: (command: string, args: string[], options: { cwd: string; stdio: "ignore"; windowsHide: true }) => { pid?: number; unref(): void };
  now?: () => number;
  pause?: (milliseconds: number) => Promise<void>;
  touchedAfter?: (path: string, timestampMs: number) => Promise<boolean>;
}

export async function launchVoidModerationTurn(
  input: VoidModerationTurnInput,
  dependencies: VoidModerationActuatorDependencies = {},
): Promise<VoidModerationTurnReceipt> {
  const workspaceRoot = resolve(input.workspaceRoot ?? process.cwd());
  const runnerScript = resolve(workspaceRoot, "scripts", "run-void-moderator-rumination.ps1");
  const statusDir = resolve(input.storageRoot, "status");
  const lockPath = resolve(statusDir, "moderation-rumination.lock");
  const statusPath = resolve(statusDir, "moderation-rumination.json");
  const pendingMentionsPath = resolve(statusDir, "void-moderation-pending-mentions.json");
  const now = dependencies.now ?? Date.now;
  const launchedAt = now();
  await mkdir(statusDir, { recursive: true });
  await writeFile(pendingMentionsPath, `${JSON.stringify({ generatedAt: input.queuedAt, pendingMentions: input.pendingMentions }, null, 2)}\n`, "utf8");

  const launchCommand = buildVoidModerationLaunchCommand({ pendingMentionsPath, runnerScript, workspaceRoot });
  const launch = dependencies.launch ?? ((command, args, options) => spawn(command, args, options));
  const child = launch("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    launchCommand,
  ], { cwd: workspaceRoot, stdio: "ignore", windowsHide: true });
  child.unref();

  const handshake = await waitForVoidModerationHandshake({
    lockPath,
    statusPath,
    launchedAt,
    timeoutMs: input.handshakeTimeoutMs ?? 60_000,
    now,
    pause: dependencies.pause,
    touchedAfter: dependencies.touchedAfter,
  });
  const requestMessageId = `agent-turn:void:${input.queuedAt}`;
  if (!handshake.started) return {
    created: false,
    activeJobId: child.pid ? `launcher-process:${child.pid}` : undefined,
    requestMessageId,
    failureReason: handshake.reason,
  };
  return { created: true, activeJobId: `process:void-moderation:${input.queuedAt}`, requestMessageId };
}

export function buildVoidModerationLaunchCommand(input: {
  pendingMentionsPath: string;
  runnerScript: string;
  workspaceRoot: string;
}): string {
  const argumentsList = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", input.runnerScript]
    .map(toPowerShellSingleQuotedString)
    .join(", ");
  return [
    `$env:VOID_RUMINATION_PENDING_MENTIONS_PATH = ${toPowerShellSingleQuotedString(input.pendingMentionsPath)};`,
    `$arguments = @(${argumentsList});`,
    `Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory ${toPowerShellSingleQuotedString(input.workspaceRoot)} -WindowStyle Hidden;`,
  ].join(" ");
}

export async function waitForVoidModerationHandshake(input: {
  lockPath: string;
  statusPath: string;
  launchedAt: number;
  timeoutMs: number;
  now?: () => number;
  pause?: (milliseconds: number) => Promise<void>;
  touchedAfter?: (path: string, timestampMs: number) => Promise<boolean>;
}): Promise<{ started: true } | { started: false; reason: string }> {
  const now = input.now ?? Date.now;
  const pause = input.pause ?? ((milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds)));
  const touchedAfter = input.touchedAfter ?? wasTouchedAfter;
  const deadline = now() + input.timeoutMs;
  while (now() < deadline) {
    if (await touchedAfter(input.lockPath, input.launchedAt)) return { started: true };
    if (await touchedAfter(input.statusPath, input.launchedAt)) return { started: true };
    await pause(250);
  }
  return { started: false, reason: "void_moderation_launch_handshake_missing" };
}

function toPowerShellSingleQuotedString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function wasTouchedAfter(path: string, timestampMs: number): Promise<boolean> {
  try {
    return (await stat(path)).mtimeMs >= timestampMs - 500;
  } catch {
    return false;
  }
}
