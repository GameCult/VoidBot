import { HashingTextEmbedder, type TextEmbedder } from "./hash-embedder";
import { OllamaTextEmbedder } from "./ollama-embedder";

export interface TextEmbedderFactoryOptions {
  backend: "hash" | "ollama";
  hashDimensions: number;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaTimeoutMs?: number;
  queryInstruction?: string;
}

export function createTextEmbedder(options: TextEmbedderFactoryOptions): TextEmbedder {
  if (options.backend === "ollama") {
    return new OllamaTextEmbedder({
      baseUrl: options.ollamaBaseUrl,
      model: options.ollamaModel,
      requestTimeoutMs: options.ollamaTimeoutMs,
      queryInstruction: options.queryInstruction,
    });
  }

  return new HashingTextEmbedder(options.hashDimensions);
}
