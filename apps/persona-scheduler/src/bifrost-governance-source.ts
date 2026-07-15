import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export interface BifrostGovernanceDigest {
  generatedAt: string;
  topics: BifrostGovernanceTopic[];
}

export interface BifrostGovernanceTopic {
  id: string;
  title: string;
  jurisdictionRepoName: string;
  jurisdictionAgentIdentity?: string;
  status: string;
  summaryMarkdown: string;
  priority: number;
  updatedAt: string;
  approvedByAgent?: string;
  dispatchRequestId?: string;
  comments?: BifrostGovernanceComment[];
}

export interface BifrostGovernanceComment {
  id: string;
  authorKind: string;
  authorId: string;
  stance: string;
  bodyMarkdown: string;
  createdAt: string;
}

interface DigestProcessResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

export async function readBifrostGovernanceDigest(input: {
  bifrostRoot: string;
  repoName: string;
  agentIdentity: string;
  now?: Date;
  runDigest?: (scriptPath: string, args: string[], cwd: string) => DigestProcessResult;
}): Promise<BifrostGovernanceDigest> {
  const now = input.now ?? new Date();
  const scriptPath = resolve(input.bifrostRoot, "tools", "governance-threads.mjs");
  const args = ["digest", "--repo", input.repoName, "--agent", input.agentIdentity, "--limit", "6"];
  const result = input.runDigest
    ? input.runDigest(scriptPath, args, input.bifrostRoot)
    : runDigestProcess(scriptPath, args, input.bifrostRoot);

  if (result.status !== 0) {
    return errorDigest({
      id: "bifrost-digest-error",
      title: "Bifrost governance digest unavailable",
      summaryPrefix: "Could not read Bifrost governance digest",
      detail: result.stderr || result.error?.message || result.stdout || "unknown failure",
      input,
      now,
    });
  }
  try {
    return JSON.parse(result.stdout ?? "") as BifrostGovernanceDigest;
  } catch (error) {
    return errorDigest({
      id: "bifrost-digest-parse-error",
      title: "Bifrost governance digest parse failure",
      summaryPrefix: "Could not parse Bifrost governance digest",
      detail: error instanceof Error ? error.message : String(error),
      input,
      now,
    });
  }
}

function runDigestProcess(scriptPath: string, args: string[], cwd: string): DigestProcessResult {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

function errorDigest(input: {
  id: string;
  title: string;
  summaryPrefix: string;
  detail: string;
  input: { repoName: string; agentIdentity: string };
  now: Date;
}): BifrostGovernanceDigest {
  const observedAt = input.now.toISOString();
  return {
    generatedAt: observedAt,
    topics: [{
      id: input.id,
      title: input.title,
      jurisdictionRepoName: input.input.repoName,
      jurisdictionAgentIdentity: input.input.agentIdentity,
      status: "error",
      summaryMarkdown: `${input.summaryPrefix}: ${input.detail}`,
      priority: 0,
      updatedAt: observedAt,
      comments: [],
    }],
  };
}
