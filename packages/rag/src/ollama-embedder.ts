import { type TextEmbedder } from "./hash-embedder";

const DEFAULT_OLLAMA_TIMEOUT_MS = 30000;

interface OllamaEmbedResponse {
  embeddings?: unknown;
}

export interface OllamaTextEmbedderOptions {
  baseUrl?: string;
  model: string;
  queryInstruction?: string;
  requestTimeoutMs?: number;
}

export class OllamaTextEmbedder implements TextEmbedder {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly queryInstruction?: string;
  private readonly requestTimeoutMs: number;

  public constructor(options: OllamaTextEmbedderOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "http://127.0.0.1:11434");
    this.model = options.model;
    this.queryInstruction = normalizeOptionalText(options.queryInstruction);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
  }

  public get id(): string {
    return `ollama:${this.baseUrl}:${this.model}`;
  }

  public async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embedInputs(texts);
  }

  public async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embedInputs([this.formatQuery(text)]);
    return embedding;
  }

  private formatQuery(text: string): string {
    if (!this.queryInstruction) {
      return text;
    }

    return `Instruct: ${this.queryInstruction}\nQuery: ${text}`;
  }

  private async embedInputs(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Ollama embedding request failed with ${response.status}: ${await response.text()}`,
        );
      }

      const payload = (await response.json()) as OllamaEmbedResponse;

      if (!Array.isArray(payload.embeddings)) {
        throw new Error(
          `Ollama embedding response for model "${this.model}" did not include an embeddings array.`,
        );
      }

      const embeddings = payload.embeddings.map((value, index) => parseEmbedding(value, index));
      const vectorLength = embeddings[0]?.length ?? 0;

      if (vectorLength === 0) {
        throw new Error(`Ollama returned an empty embedding vector for model "${this.model}".`);
      }

      for (const [index, embedding] of embeddings.entries()) {
        if (embedding.length !== vectorLength) {
          throw new Error(
            `Ollama returned inconsistent embedding lengths for model "${this.model}" at item ${index}.`,
          );
        }
      }

      return embeddings;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(
          `Timed out waiting for Ollama embeddings from ${this.baseUrl} using model "${this.model}".`,
        );
      }

      const message = error instanceof Error ? error.message : "Unknown Ollama embedding error.";
      throw new Error(
        `${message} Make sure Ollama is running at ${this.baseUrl} and that the model "${this.model}" has been pulled.`,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

function parseEmbedding(value: unknown, index: number): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Ollama returned a non-array embedding for item ${index}.`);
  }

  const embedding = value.map((component, componentIndex) => {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new Error(
        `Ollama returned a non-numeric embedding component at item ${index}, position ${componentIndex}.`,
      );
    }

    return component;
  });

  return embedding;
}

function normalizeBaseUrl(input: string): string {
  return input.replace(/\/+$/, "");
}

function normalizeOptionalText(input?: string): string | undefined {
  const trimmed = input?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
