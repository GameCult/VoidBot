import { isAbsolute, resolve } from "node:path";

export interface RepoIdentityArticleIntent {
  identity?: string;
  site?: "aetheria" | "gamecult";
  title: string;
  description: string;
  author?: string;
  date?: string;
  tags: string[];
  path?: string;
  body: string;
  shareContent?: string;
  channelId?: string;
  replyToMessageId?: string;
}

export function normalizeArticleSite(value: string | undefined): RepoIdentityArticleIntent["site"] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "aetheria" || normalized === "aetherialore") {
    return "aetheria";
  }
  if (normalized === "gamecult" || normalized === "gamecult-site" || normalized === "blog") {
    return "gamecult";
  }
  return undefined;
}

export function isValidArticleDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

export function resolveArticleRepoRoot(
  intent: RepoIdentityArticleIntent,
  identity: { repoName: string; repoPath?: string },
  options: { sourceRepoRoot?: string; storageRoot: string },
): string {
  if (inferArticleSite(intent, identity) === "gamecult") {
    if (options.sourceRepoRoot) {
      return resolve(options.sourceRepoRoot, "gamecult-site");
    }
    return resolve(options.storageRoot, "repo-article-drafts", "gamecult-site");
  }
  if (identity.repoPath && identity.repoPath.trim().length > 0) {
    return resolve(identity.repoPath);
  }
  if (options.sourceRepoRoot) {
    return resolve(options.sourceRepoRoot, identity.repoName);
  }
  return resolve(options.storageRoot, "repo-article-drafts", identity.repoName);
}

export function normalizeArticlePath(
  intent: RepoIdentityArticleIntent,
  identity: { displayName: string; repoName: string },
): string {
  const site = inferArticleSite(intent, identity);
  const path = intent.path?.trim();
  if (path && !isAbsolute(path) && !path.split(/[\\/]+/).includes("..")) {
    const normalizedPath = path.replace(/\\/g, "/");
    const requiredPrefix = site === "aetheria" ? "Aetheria/Articles/" : "GameCult/Blog/";
    if (!normalizedPath.startsWith(requiredPrefix)) {
      throw new Error(`Article path for ${site} must stay under ${requiredPrefix}: ${normalizedPath}`);
    }
    if (!normalizedPath.toLowerCase().endsWith(".md")) {
      throw new Error(`Article path must end in .md: ${normalizedPath}`);
    }
    return normalizedPath;
  }

  const date = normalizeArticleDate(intent);
  const slug = slugify(intent.title);
  if (site === "aetheria") {
    return `Aetheria/Articles/${sanitizePathSegment(identity.displayName)}/${date}-${slug}.md`;
  }
  return `GameCult/Blog/${date}-${slug}.md`;
}

export function renderRepoIdentityArticleMarkdown(
  intent: RepoIdentityArticleIntent,
  identity: { displayName: string; repoName: string },
): string {
  const body = stripMarkdownFrontmatter(intent.body).trim();
  if (!body) {
    throw new Error(`Article body for ${identity.displayName} is empty after frontmatter stripping.`);
  }
  const frontmatter = renderArticleFrontmatter({
    title: intent.title,
    description: intent.description,
    author: intent.author ?? identity.displayName,
    date: normalizeArticleDate(intent),
    tags: intent.tags,
  });
  return `${frontmatter}\n\n${body}\n`;
}

export function validateRenderedArticleMarkdown(markdown: string, intent: RepoIdentityArticleIntent): void {
  const match = /^---\n([\s\S]*?)\n---\n\n/.exec(markdown);
  if (!match) {
    throw new Error(`Rendered article "${intent.title}" is missing YAML frontmatter.`);
  }
  const frontmatter = match[1];
  for (const key of ["title", "description", "author", "date"]) {
    if (!new RegExp(`^${key}:\\s+\\S`, "m").test(frontmatter)) {
      throw new Error(`Rendered article "${intent.title}" is missing frontmatter key ${key}.`);
    }
  }
  const date = frontmatter.match(/^date:\s+(.+)$/m)?.[1]?.trim() ?? "";
  if (!isValidArticleDate(date)) {
    throw new Error(`Rendered article "${intent.title}" has invalid date frontmatter: ${date}`);
  }
}

function inferArticleSite(
  intent: RepoIdentityArticleIntent,
  identity: { repoName: string },
): "aetheria" | "gamecult" {
  if (intent.site) {
    return intent.site;
  }
  return identity.repoName.toLowerCase() === "aetherialore" ? "aetheria" : "gamecult";
}

function normalizeArticleDate(intent: RepoIdentityArticleIntent): string {
  const date = intent.date?.trim();
  if (date) {
    if (!isValidArticleDate(date)) {
      throw new Error(`Article date must use YYYY-MM-DD: ${date}`);
    }
    return date;
  }
  return new Date().toISOString().slice(0, 10);
}

function renderArticleFrontmatter(input: {
  title: string;
  description: string;
  author: string;
  date: string;
  tags: string[];
}): string {
  const tags = Array.from(new Set(input.tags.map((tag) => tag.trim()).filter(Boolean)));
  const lines = [
    "---",
    `title: ${yamlScalar(input.title)}`,
    `description: ${yamlScalar(input.description)}`,
    `author: ${yamlScalar(input.author)}`,
    `date: ${input.date}`,
  ];
  if (tags.length > 0) {
    lines.push("tags:");
    for (const tag of tags) {
      lines.push(`  - ${yamlScalar(tag)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function yamlScalar(value: string): string {
  const normalized = value.replace(/\r?\n/g, " ").trim();
  if (!normalized) {
    throw new Error("Article frontmatter values must not be empty.");
  }
  return `"${normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function stripMarkdownFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
}

function slugify(value: string): string {
  return sanitizePathSegment(value)
    .replace(/\.+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80) || "article";
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
