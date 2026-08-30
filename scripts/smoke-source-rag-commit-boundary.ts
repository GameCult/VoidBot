import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileSourceDocumentArchiveRepository,
  InMemoryVectorStore,
  SourceDocumentIngester,
  SourceRagPipeline,
  discoverSourceReposFromCatalog,
  type ArchivedSourceDocument,
} from "@voidbot/rag";

class FailingVectorStore extends InMemoryVectorStore {
  public override async upsert(): Promise<void> {
    throw new Error("fixture vector failure");
  }
}

const sourceId = "Fixture:README.md";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "voidbot-source-commit-"));
  const archivePath = join(root, "source-documents.json");

  try {
    const archive = new FileSourceDocumentArchiveRepository(archivePath);
    const original = document("original body");
    const updated = document("updated body");
    await archive.syncRepoDocuments("Fixture", [original]);

    const failingPipeline = new SourceRagPipeline(
      archive,
      new SourceDocumentIngester(),
      new FailingVectorStore(),
    );

    await failingPipeline.syncRepoDocuments("Fixture", [updated]).then(
      () => { throw new Error("Expected vector failure did not occur."); },
      () => undefined,
    );

    assertEqual((await archive.get(sourceId))?.content, original.content, "archive advanced after vector failure");

    const workingPipeline = new SourceRagPipeline(
      archive,
      new SourceDocumentIngester(),
      new InMemoryVectorStore(),
    );
    await workingPipeline.syncRepoDocuments("Fixture", [updated]);
    assertEqual((await archive.get(sourceId))?.content, updated.content, "successful retry did not commit archive");

    const manifest = JSON.parse(await readFile(archivePath, "utf8")) as { repos?: unknown[] };
    assertEqual(manifest.repos?.length, 1, "manifest summary was not committed");

    const repoRoot = join(root, "repos");
    await mkdir(join(repoRoot, "Fixture", ".git"), { recursive: true });
    const catalogPath = join(root, "catalog.tsv");
    await writeFile(catalogPath, "Fixture\thttps://github.com/GameCult/Fixture.git\tmain\n", "utf8");
    const catalogRepos = await discoverSourceReposFromCatalog(repoRoot, catalogPath);
    assertEqual(catalogRepos[0]?.repoName, "Fixture", "catalog discovery lost canonical repo identity");
    console.log("Source RAG commit-boundary smoke passed.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function document(content: string): ArchivedSourceDocument {
  return {
    id: sourceId,
    repoName: "Fixture",
    path: "README.md",
    content,
  };
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}
