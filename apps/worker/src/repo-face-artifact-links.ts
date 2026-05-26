import type { ArchivedSourceDocumentRecord } from "@voidbot/rag";

const KNOWLEDGEBASE_URL_RESOLVERS = new Map<string, { baseUrl: string; stripPrefix?: string }>([
  ["aetherialore", { baseUrl: "https://aetheria.gamecult.org", stripPrefix: "Aetheria/" }],
]);

export function resolveRepoIdentityPostArtifactLinks(input: {
  repoName: string;
  content: string;
  documents?: ArchivedSourceDocumentRecord[];
}): string {
  const explicit = resolveExplicitKnowledgebaseReferences(input.content, input.repoName);
  if (explicit !== input.content || /\bhttps?:\/\//i.test(explicit)) {
    return explicit;
  }

  if (!knowledgebaseResolverForRepo(input.repoName)) {
    return explicit;
  }

  const referenced = findMentionedKnowledgebaseDocument(explicit, input.documents ?? []);
  if (!referenced) {
    return explicit;
  }

  const url = resolveKnowledgebaseUrl(referenced.repoName, referenced.path);
  if (!url || explicit.includes(url)) {
    return explicit;
  }

  return `${explicit}\n\nReference: ${url}`;
}

export function resolveKnowledgebaseUrl(repoName: string, sourcePath: string): string | undefined {
  const resolver = knowledgebaseResolverForRepo(repoName);
  if (!resolver) {
    return undefined;
  }

  let normalizedPath = sourcePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (resolver.stripPrefix && normalizedPath.toLowerCase().startsWith(resolver.stripPrefix.toLowerCase())) {
    normalizedPath = normalizedPath.slice(resolver.stripPrefix.length);
  }
  normalizedPath = normalizedPath.replace(/\.md$/i, "");
  const publishedPath = normalizedPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment.trim().replace(/\s+/g, "-")))
    .join("/");

  return publishedPath ? `${resolver.baseUrl}/${publishedPath}` : resolver.baseUrl;
}

function resolveExplicitKnowledgebaseReferences(content: string, defaultRepoName: string): string {
  return content.replace(/`([^`\n]+?\.md)`/g, (match, rawReference: string) => {
    const resolved = resolveKnowledgebaseReference(rawReference, defaultRepoName);
    return resolved ? `${match} (${resolved})` : match;
  });
}

function resolveKnowledgebaseReference(reference: string, defaultRepoName: string): string | undefined {
  const trimmed = reference.trim();
  const separatorIndex = trimmed.indexOf(":");
  const repoName = separatorIndex > 0 ? trimmed.slice(0, separatorIndex).trim() : defaultRepoName;
  const path = separatorIndex > 0 ? trimmed.slice(separatorIndex + 1).trim() : trimmed;
  return resolveKnowledgebaseUrl(repoName, path);
}

function findMentionedKnowledgebaseDocument(
  content: string,
  documents: ArchivedSourceDocumentRecord[],
): ArchivedSourceDocumentRecord | undefined {
  const normalizedContent = normalizeReferenceText(content);
  const markdownDocuments = documents
    .filter((document) => document.path.toLowerCase().endsWith(".md"))
    .flatMap((document) =>
      [...new Set([
        document.title?.trim(),
        basenameWithoutExtension(document.path),
      ].filter((label): label is string => Boolean(label && label.length >= 10)))]
        .map((label) => ({ document, label }))
    )
    .sort((left, right) => right.label.length - left.label.length);

  return markdownDocuments.find((entry) =>
    normalizedContent.includes(normalizeReferenceText(entry.label))
  )?.document;
}

function knowledgebaseResolverForRepo(repoName: string): { baseUrl: string; stripPrefix?: string } | undefined {
  return KNOWLEDGEBASE_URL_RESOLVERS.get(repoName.trim().toLowerCase());
}

function normalizeReferenceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_~()[\]{}<>]/g, " ")
    .replace(/[-_/\\.:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function basenameWithoutExtension(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const segment = normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  return segment.replace(/\.[^.]+$/, "");
}
