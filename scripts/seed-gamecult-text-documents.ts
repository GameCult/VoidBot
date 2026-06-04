import {
  GAMECULT_TEXT_DOCUMENT_STORE_PATH,
  ODIN_VERSE_POEM_DOCUMENT_ID,
  ensureGameCultTextDocumentSet,
  loadGameCultTextDocumentSet,
  renderGameCultStructuredTextDocument,
  renderNightwingMarqueeLine,
} from "@voidbot/core";

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const storePath = readArgValue("--store") ?? GAMECULT_TEXT_DOCUMENT_STORE_PATH;
  const checkOnly = process.argv.includes("--check");
  const preview = process.argv.includes("--preview");
  const marqueePreview = process.argv.includes("--marquee-preview");

  const documentSet = checkOnly
    ? await loadGameCultTextDocumentSet(storePath)
    : await ensureGameCultTextDocumentSet(storePath);
  const poem = documentSet.documents.find((document) => document.id === ODIN_VERSE_POEM_DOCUMENT_ID);

  if (!poem) {
    throw new Error(`Missing canonical document ${ODIN_VERSE_POEM_DOCUMENT_ID} in ${storePath}.`);
  }

  console.log(JSON.stringify({
    ok: true,
    mode: checkOnly ? "check" : "seed",
    storePath,
    owner: documentSet.owner,
    documentCount: documentSet.documents.length,
    firstDocument: {
      id: poem.id,
      title: poem.title,
      author: poem.author,
      lineCount: poem.lines.filter((line) => !(line.length === 1 && line[0] === "[stanza]")).length,
      stanzaBreaks: poem.lines.filter((line) => line.length === 1 && line[0] === "[stanza]").length,
    },
  }, null, 2));

  if (preview) {
    console.log("\n--- poem preview ---");
    console.log(renderGameCultStructuredTextDocument(poem));
  }

  if (marqueePreview) {
    console.log("\n--- Nightwing marquee preview ---");
    for (const line of poem.lines) {
      console.log(line.length === 1 && line[0] === "[stanza]"
        ? ""
        : renderNightwingMarqueeLine(line));
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
