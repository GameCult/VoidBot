import { createHash } from "node:crypto";

export interface TextEmbedder {
  readonly id: string;
  readonly dimensions?: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export class HashingTextEmbedder implements TextEmbedder {
  public constructor(public readonly dimensions = 256) {}

  public get id(): string {
    return `hash:${this.dimensions}`;
  }

  public async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedSync(text));
  }

  public async embedQuery(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  private embedSync(text: string): number[] {
    const terms = tokenize(text);

    if (terms.length === 0) {
      return new Array(this.dimensions).fill(0);
    }

    const vector = new Array(this.dimensions).fill(0);
    const termFrequencies = new Map<string, number>();

    for (const term of terms) {
      termFrequencies.set(term, (termFrequencies.get(term) ?? 0) + 1);
    }

    for (const [term, frequency] of termFrequencies.entries()) {
      const hash = createHash("sha1").update(term).digest();
      const index = hash.readUInt32BE(0) % this.dimensions;
      const sign = hash[4] % 2 === 0 ? 1 : -1;
      vector[index] += sign * frequency;
    }

    return normalizeVector(vector);
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }

  let dotProduct = 0;

  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index];
  }

  return dotProduct;
}

export function lexicalOverlap(query: string, text: string): number {
  const leftTerms = new Set(tokenize(query));
  const rightTerms = new Set(tokenize(text));

  if (leftTerms.size === 0 || rightTerms.size === 0) {
    return 0;
  }

  let matches = 0;

  for (const term of leftTerms) {
    if (rightTerms.has(term)) {
      matches += 1;
    }
  }

  return matches / leftTerms.size;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));

  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}
