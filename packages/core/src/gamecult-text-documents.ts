import { resolve } from "node:path";

import { CultCache, defineDocumentRegistry, defineDocumentType, SingleFileMessagePackBackingStore } from "cultcache-ts";
import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);
const timestampSchema = nonEmptyStringSchema;

export const GAMECULT_TEXT_DOCUMENT_STORE_PATH = ".voidbot/private/gamecult-text-documents.cc";
export const GAMECULT_TEXT_DOCUMENT_SET_TYPE = "gamecult.text_document_set";
export const ODIN_VERSE_POEM_DOCUMENT_ID = "gamecult.odin_verse_poem";

const textLineSchema = z.array(nonEmptyStringSchema).min(1).max(8);

export const gamecultStructuredTextDocumentSchema = z.object({
  id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  author: nonEmptyStringSchema,
  lines: z.array(textLineSchema).min(1),
  tags: z.array(nonEmptyStringSchema).default([]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const gamecultTextDocumentSetSchema = z.object({
  schemaVersion: z.literal(1),
  owner: z.literal("GameCult"),
  documents: z.array(gamecultStructuredTextDocumentSchema).default([]),
  updatedAt: timestampSchema,
}).strict();

export const gamecultTextDocumentSetDocument = defineDocumentType({
  type: GAMECULT_TEXT_DOCUMENT_SET_TYPE,
  schema: gamecultTextDocumentSetSchema,
  global: true,
});

export const gamecultTextDocumentRegistry = defineDocumentRegistry(
  gamecultTextDocumentSetDocument,
);

export type GameCultStructuredTextDocument = z.infer<typeof gamecultStructuredTextDocumentSchema>;
export type GameCultTextDocumentSet = z.infer<typeof gamecultTextDocumentSetSchema>;

export interface GameCultTextDocumentRenderOptions {
  halfLineSeparator?: string;
  stanzaSeparator?: string;
}

export async function loadGameCultTextDocumentSet(
  canonicalPath = GAMECULT_TEXT_DOCUMENT_STORE_PATH,
): Promise<GameCultTextDocumentSet> {
  const cache = createGameCultTextDocumentCache(resolve(canonicalPath));
  await cache.pullAllBackingStores();
  return cache.getGlobal(gamecultTextDocumentSetDocument) ?? createCanonicalGameCultTextDocumentSet();
}

export async function ensureGameCultTextDocumentSet(
  canonicalPath = GAMECULT_TEXT_DOCUMENT_STORE_PATH,
): Promise<GameCultTextDocumentSet> {
  const resolvedPath = resolve(canonicalPath);
  const cache = createGameCultTextDocumentCache(resolvedPath);
  await cache.pullAllBackingStores();

  const current = cache.getGlobal(gamecultTextDocumentSetDocument);
  const next = mergeCanonicalTextDocuments(current);
  await cache.putGlobal(gamecultTextDocumentSetDocument, next);
  return next;
}

export async function loadGameCultTextDocument(
  documentId: string,
  canonicalPath = GAMECULT_TEXT_DOCUMENT_STORE_PATH,
): Promise<GameCultStructuredTextDocument | undefined> {
  const documentSet = await loadGameCultTextDocumentSet(canonicalPath);
  return documentSet.documents.find((document) => document.id === documentId);
}

export async function ensureGameCultTextDocument(
  documentId: string,
  canonicalPath = GAMECULT_TEXT_DOCUMENT_STORE_PATH,
): Promise<GameCultStructuredTextDocument> {
  const documentSet = await ensureGameCultTextDocumentSet(canonicalPath);
  const document = documentSet.documents.find((entry) => entry.id === documentId);
  if (!document) {
    throw new Error(`Canonical GameCult text document "${documentId}" is not seeded.`);
  }
  return document;
}

export function renderGameCultStructuredTextDocument(
  document: GameCultStructuredTextDocument,
  options: GameCultTextDocumentRenderOptions = {},
): string {
  const halfLineSeparator = options.halfLineSeparator ?? "    ";
  const stanzaSeparator = options.stanzaSeparator ?? "\n\n";
  const stanzas: string[][] = [[]];

  for (const line of document.lines) {
    if (line.length === 1 && line[0] === "[stanza]") {
      if (stanzas.at(-1)?.length) {
        stanzas.push([]);
      }
      continue;
    }
    stanzas.at(-1)?.push(line.join(halfLineSeparator));
  }

  return stanzas
    .filter((stanza) => stanza.length > 0)
    .map((stanza) => stanza.join("\n"))
    .join(stanzaSeparator);
}

export function renderNightwingMarqueeLine(
  line: readonly string[],
  separator = " · ",
): string {
  return line.join(separator).toUpperCase();
}

export function createCanonicalGameCultTextDocumentSet(
  updatedAt = "2026-06-04T00:00:00.000Z",
): GameCultTextDocumentSet {
  return {
    schemaVersion: 1,
    owner: "GameCult",
    documents: [createOdinVersePoemDocument(updatedAt)],
    updatedAt,
  };
}

function mergeCanonicalTextDocuments(
  current: GameCultTextDocumentSet | undefined,
): GameCultTextDocumentSet {
  const canonical = createCanonicalGameCultTextDocumentSet();
  if (!current) {
    return canonical;
  }

  const byId = new Map(current.documents.map((document) => [document.id, document]));
  for (const document of canonical.documents) {
    byId.set(document.id, document);
  }

  return {
    schemaVersion: 1,
    owner: "GameCult",
    documents: Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id)),
    updatedAt: new Date().toISOString(),
  };
}

function createGameCultTextDocumentCache(canonicalPath: string): CultCache {
  return CultCache.builder()
    .withRegistry(gamecultTextDocumentRegistry)
    .withGenericStore(new SingleFileMessagePackBackingStore(canonicalPath))
    .build();
}

function createOdinVersePoemDocument(updatedAt: string): GameCultStructuredTextDocument {
  return {
    id: ODIN_VERSE_POEM_DOCUMENT_ID,
    title: "Odin and the Verses",
    author: "GameCult",
    lines: [
      ["Much has he fared,", "much has he found,"],
      ["Odin, old in counsel;"],
      ["from Hlithskjolf high", "he looks on the ways,"],
      ["and the worlds lie wide before him."],
      ["[stanza]"],
      ["Hugin fares forth", "over halls of state,"],
      ["Munin seeks memory;"],
      ["back do they bear", "the names of the doors,"],
      ["and the speech of the hidden houses."],
      ["[stanza]"],
      ["Speak forth now, Verse,", "if from thy hall"],
      ["thy wisdom thou wouldst make known:"],
      ["what owner holds thee,", "what oath may touch thee,"],
      ["what work is thine to witness?"],
      ["[stanza]"],
      ["One hall keeps queues,", "one hoards lore,"],
      ["one lowers bright surfaces;"],
      ["one bears commands", "in bounded runes,"],
      ["and bids the hand be wary."],
      ["[stanza]"],
      ["Runes shalt thou find,", "and rede them rightly,"],
      ["strong signs, source-colored;"],
      ["not all that is seen", "is given to seize,"],
      ["nor all that answers is ownerless."],
      ["[stanza]"],
      ["Better no grasping", "than gift too great,"],
      ["better no command than theft;"],
      ["by thy getting measure", "the touch of thy hand,"],
      ["and let each house keep lordship."],
      ["[stanza]"],
      ["So grows the Colossus,", "not gorged with thrones,"],
      ["but knit by knowing pathways;"],
      ["word leads to word,", "and work to work,"],
      ["and nerve to newborn nerve."],
      ["[stanza]"],
      ["Hail to the Verse", "that speaks in its hall;"],
      ["hail to the watcher who hearkens."],
      ["Profit has he", "who learns the boundary,"],
      ["and whole comes the signal home."],
    ],
    tags: ["odin", "verse", "colossus", "marquee-ready"],
    createdAt: updatedAt,
    updatedAt,
  };
}
