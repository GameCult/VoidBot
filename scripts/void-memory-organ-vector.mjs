import { resolve } from "node:path";

import { DEFAULT_VECTOR_DIMENSIONS } from "./void-memory-organ-constants.mjs";
import { normalizeBaseUrl, normalizeText, parseDotEnvSafe, readInt } from "./void-memory-organ-utils.mjs";

export function createEmbedder({ repoRootPath }) {
  const env = parseDotEnvSafe(resolve(repoRootPath, ".env"));
  const backend = env.RAG_EMBEDDING_BACKEND === "hash" ? "hash" : "ollama";
  const dimensions = readInt(env.VOID_MEMORY_VECTOR_DIMENSIONS, DEFAULT_VECTOR_DIMENSIONS);

  if (backend === "ollama") {
    return {
      backend: "ollama",
      model: env.RAG_OLLAMA_MODEL?.trim() || "qwen3-embedding:0.6b",
      dimensions,
      baseUrl: normalizeBaseUrl(env.RAG_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434"),
      async embed(text) {
        try {
          const response = await fetch(`${this.baseUrl}/api/embed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: this.model,
              input: [text],
            }),
          });

          if (!response.ok) {
            throw new Error(`Ollama responded ${response.status}`);
          }

          const payload = await response.json();
          const raw = Array.isArray(payload?.embeddings) ? payload.embeddings[0] : undefined;
          if (!Array.isArray(raw) || raw.length === 0) {
            throw new Error("No embedding returned.");
          }

          return compactVector(raw.map(Number), dimensions);
        } catch {
          this.backend = "hash";
          this.model = `hash:${dimensions}`;
          return hashVector(text, dimensions);
        }
      },
    };
  }

  return {
    backend: "hash",
    model: `hash:${dimensions}`,
    dimensions,
    async embed(text) {
      return hashVector(text, dimensions);
    },
  };
}

export function compactVector(values, targetDimensions) {
  if (values.length === targetDimensions) {
    return normalizeVector(values);
  }

  const compacted = new Array(targetDimensions).fill(0);

  for (let index = 0; index < targetDimensions; index += 1) {
    const start = Math.floor((index * values.length) / targetDimensions);
    const end = Math.floor(((index + 1) * values.length) / targetDimensions);
    const slice = values.slice(start, Math.max(start + 1, end));
    compacted[index] =
      slice.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0) /
      Math.max(1, slice.length);
  }

  return normalizeVector(compacted);
}

export function hashVector(text, dimensions) {
  const terms = tokenize(text);

  if (terms.length === 0) {
    return new Array(dimensions).fill(0);
  }

  const vector = new Array(dimensions).fill(0);

  for (const term of terms) {
    const hash = createHash("sha1").update(term).digest();
    const index = hash.readUInt32BE(0) % dimensions;
    const sign = hash[4] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  return normalizeVector(vector);
}

export function averagePairwiseSimilarity(items) {
  if (items.length < 2) {
    return 0;
  }

  let total = 0;
  let count = 0;

  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      total += cosineSimilarity(items[leftIndex].entry.semanticVector.values, items[rightIndex].entry.semanticVector.values);
      count += 1;
    }
  }

  return count === 0 ? 0 : total / count;
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}
