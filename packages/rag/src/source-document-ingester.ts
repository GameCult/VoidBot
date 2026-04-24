import { type EmbeddingChunk, type VectorStore } from "@voidbot/shared";

import { normalizeText } from "./history-ingester";
import { type ArchivedSourceDocument } from "./source-document-archive";

const DEFAULT_MAX_CHARS = 1400;
const DEFAULT_MAX_LINES = 48;

interface SourceChunkWindow {
  text: string;
  lineStart: number;
  lineEnd: number;
}

export interface SourceDocumentChunkContext {
  chunkId: string;
  chunkIndex: number;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export class SourceDocumentIngester {
  public constructor(
    private readonly maxChars = DEFAULT_MAX_CHARS,
    private readonly maxLines = DEFAULT_MAX_LINES,
  ) {}

  public chunkDocuments(documents: ArchivedSourceDocument[]): EmbeddingChunk[] {
    return documents.flatMap((document) => this.chunkDocument(document));
  }

  public async ingestDocuments(
    documents: ArchivedSourceDocument[],
    vectorStore: VectorStore,
  ): Promise<EmbeddingChunk[]> {
    const chunks = this.chunkDocuments(documents);
    await vectorStore.upsert(chunks);
    return chunks;
  }

  public chunkDocument(document: ArchivedSourceDocument): EmbeddingChunk[] {
    const windows = splitSourceDocument(document.content, this.maxChars, this.maxLines);

    return windows.map((window, index) => ({
      id: `${document.id}:${index}`,
      sourceId: document.id,
      sourceKind: "source_document",
      text: window.text,
      normalizedText: normalizeText(window.text),
      metadata: {
        corpusKind: "repository_source",
        sourceId: document.id,
        repoName: document.repoName,
        path: document.path,
        language: document.language ?? "",
        title: document.title ?? document.path,
        chunkIndex: String(index),
        chunkCount: String(windows.length),
        lineStart: String(window.lineStart),
        lineEnd: String(window.lineEnd),
        lastModifiedAt: document.lastModifiedAt ?? "",
        ...document.metadata,
      },
    }));
  }

  public buildContextWindow(
    document: ArchivedSourceDocument,
    anchorChunkIndex: number,
    before = 1,
    after = 1,
  ): SourceDocumentChunkContext[] {
    const chunks = this.chunkDocument(document);
    const safeAnchor = clamp(anchorChunkIndex, 0, Math.max(0, chunks.length - 1));
    const start = Math.max(0, safeAnchor - before);
    const end = Math.min(chunks.length, safeAnchor + after + 1);

    return chunks.slice(start, end).map((chunk) => ({
      chunkId: chunk.id,
      chunkIndex: Number(chunk.metadata.chunkIndex ?? 0),
      lineStart: Number(chunk.metadata.lineStart ?? 1),
      lineEnd: Number(chunk.metadata.lineEnd ?? 1),
      text: chunk.text,
    }));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function splitSourceDocument(
  input: string,
  maxChars: number,
  maxLines: number,
): SourceChunkWindow[] {
  const normalized = input.replace(/\r\n/g, "\n");

  if (normalized.trim().length === 0) {
    return [
      {
        text: "(empty file)",
        lineStart: 1,
        lineEnd: 1,
      },
    ];
  }

  const lines = normalized.split("\n");
  const windows: SourceChunkWindow[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    let end = cursor;
    let size = 0;

    while (end < lines.length) {
      const candidateLine = lines[end] ?? "";
      const nextSize = size + candidateLine.length + (end === cursor ? 0 : 1);
      const nextLineCount = end - cursor + 1;

      if (end > cursor && (nextSize > maxChars || nextLineCount > maxLines)) {
        break;
      }

      size = nextSize;
      end += 1;

      if (candidateLine.length > maxChars && end === cursor + 1) {
        break;
      }
    }

    const slice = lines.slice(cursor, end);
    const chunkText = slice.join("\n").trimEnd();

    windows.push({
      text: chunkText.length > 0 ? chunkText : "(blank lines)",
      lineStart: cursor + 1,
      lineEnd: end,
    });

    cursor = end;
  }

  return windows;
}
