import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { type ArchivedSourceDocument } from "./source-document-archive";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".github",
  ".next",
  ".npm-cache",
  ".obsidian",
  ".rag",
  ".turbo",
  ".venv",
  ".vscode",
  ".voidbot",
  "artifacts",
  "bin",
  "build",
  "coverage",
  "dist",
  "Library",
  "node_modules",
  "obj",
  "Temp",
]);

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avi",
  ".bmp",
  ".class",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lock",
  ".map",
  ".mp3",
  ".mp4",
  ".mov",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".rar",
  ".so",
  ".svg",
  ".tar",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

export interface RepoCrawlerOptions {
  maxFileBytes?: number;
  includePathPrefixes?: string[];
}

export interface RepoDocumentScanResult {
  repoName: string;
  repoPath: string;
  documents: ArchivedSourceDocument[];
  skippedFiles: string[];
}

export async function crawlRepositoryDocuments(
  repoPath: string,
  repoName: string,
  options: RepoCrawlerOptions = {},
): Promise<RepoDocumentScanResult> {
  const documents: ArchivedSourceDocument[] = [];
  const skippedFiles: string[] = [];
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const includePathPrefixes = normalizePathPrefixes(options.includePathPrefixes);

  await walkDirectory(repoPath, async (absolutePath) => {
    const fileStat = await stat(absolutePath);

    if (!fileStat.isFile()) {
      return;
    }

    if (fileStat.size > maxFileBytes) {
      skippedFiles.push(relative(repoPath, absolutePath));
      return;
    }

    const relativePath = relative(repoPath, absolutePath).replace(/\\/g, "/");

    if (!shouldIndexFile(relativePath, includePathPrefixes)) {
      return;
    }

    const content = await readTextFile(absolutePath);

    if (!content) {
      return;
    }

    documents.push({
      id: `${repoName}:${relativePath}`,
      repoName,
      path: relativePath,
      language: inferLanguage(relativePath),
      title: relativePath,
      content,
      lastModifiedAt: fileStat.mtime.toISOString(),
      metadata: {
        repoName,
        path: relativePath,
      },
    });
  });

  documents.sort((left, right) => left.path.localeCompare(right.path));

  return {
    repoName,
    repoPath,
    documents,
    skippedFiles,
  };
}

async function walkDirectory(
  directoryPath: string,
  onFile: (absolutePath: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      await walkDirectory(join(directoryPath, entry.name), onFile);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    await onFile(join(directoryPath, entry.name));
  }
}

const SOURCE_AND_DOC_EXTENSIONS = new Set([
  ".adoc",
  ".astro",
  ".bat",
  ".c",
  ".cc",
  ".cmd",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".example",
  ".fs",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".lua",
  ".md",
  ".mdx",
  ".mjs",
  ".php",
  ".props",
  ".ps1",
  ".py",
  ".rb",
  ".resx",
  ".rs",
  ".rst",
  ".sass",
  ".scss",
  ".shader",
  ".sh",
  ".sln",
  ".sql",
  ".svelte",
  ".swift",
  ".targets",
  ".tex",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".unity",
  ".uxml",
  ".uss",
  ".vue",
  ".xml",
  ".xsd",
  ".yaml",
  ".yml",
]);

const KNOWN_TEXT_FILENAMES = new Set([
  ".editorconfig",
  ".gitignore",
  "cmakelists.txt",
  "dockerfile",
  "justfile",
  "makefile",
  "procfile",
  "readme",
  "readme.md",
]);

const NOISY_FILENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
]);

function shouldIndexFile(relativePath: string, includePathPrefixes: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, "/");

  if (normalized.length === 0) {
    return false;
  }

  if (
    includePathPrefixes.length > 0 &&
    !includePathPrefixes.some((prefix) => normalized.startsWith(prefix))
  ) {
    return false;
  }

  if (normalized.startsWith("quartz-site/public/")) {
    return false;
  }

  const lower = normalized.toLowerCase();
  const fileName = lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";

  if (BINARY_EXTENSIONS.has(extension)) {
    return false;
  }

  if (NOISY_FILENAMES.has(fileName)) {
    return false;
  }

  if (KNOWN_TEXT_FILENAMES.has(fileName)) {
    return true;
  }

  return SOURCE_AND_DOC_EXTENSIONS.has(extension);
}

async function readTextFile(absolutePath: string): Promise<string | undefined> {
  const buffer = await readFile(absolutePath);

  if (buffer.includes(0)) {
    return undefined;
  }

  const content = buffer.toString("utf8");
  return content.trim().length > 0 ? content : undefined;
}

function inferLanguage(relativePath: string): string | undefined {
  const lower = relativePath.toLowerCase();

  if (lower.endsWith(".cs")) {
    return "csharp";
  }

  if (lower.endsWith(".json")) {
    return "json";
  }

  if (lower.endsWith(".jsonc")) {
    return "jsonc";
  }

  if (lower.endsWith(".md")) {
    return "markdown";
  }

  if (lower.endsWith(".tsx")) {
    return "tsx";
  }

  if (lower.endsWith(".ts")) {
    return "typescript";
  }

  if (lower.endsWith(".jsx")) {
    return "jsx";
  }

  if (lower.endsWith(".js")) {
    return "javascript";
  }

  if (lower.endsWith(".mjs")) {
    return "javascript";
  }

  if (lower.endsWith(".py")) {
    return "python";
  }

  if (lower.endsWith(".toml")) {
    return "toml";
  }

  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) {
    return "yaml";
  }

  if (lower.endsWith(".html")) {
    return "html";
  }

  if (lower.endsWith(".css")) {
    return "css";
  }

  if (lower.endsWith(".txt")) {
    return "text";
  }

  if (lower.endsWith(".sh")) {
    return "shell";
  }

  if (lower.endsWith(".ps1")) {
    return "powershell";
  }

  if (lower.endsWith(".sql")) {
    return "sql";
  }

  if (lower.endsWith(".rs")) {
    return "rust";
  }

  if (lower.endsWith(".go")) {
    return "go";
  }

  if (lower.endsWith(".java")) {
    return "java";
  }

  if (lower.endsWith(".kt") || lower.endsWith(".kts")) {
    return "kotlin";
  }

  if (lower.endsWith(".cpp") || lower.endsWith(".cc") || lower.endsWith(".hpp") || lower.endsWith(".h")) {
    return "cpp";
  }

  if (lower.endsWith(".unity")) {
    return "unity-yaml";
  }

  if (lower.endsWith(".shader")) {
    return "shaderlab";
  }

  return undefined;
}

function normalizePathPrefixes(prefixes?: string[]): string[] {
  return (prefixes ?? [])
    .map((prefix) => prefix.trim().replace(/\\/g, "/").replace(/^\.\/+/, ""))
    .filter((prefix) => prefix.length > 0)
    .map((prefix) => (prefix.endsWith("/") ? prefix : `${prefix}/`));
}
