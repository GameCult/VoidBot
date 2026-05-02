import { readFile } from "node:fs/promises";

export type SystemMessageVariables = Record<
  string,
  string | number | boolean | null | undefined
>;

type SystemMessageCatalogSource = Record<string, string | string[]>;

interface ShuffleBagState {
  bag: string[];
  last?: string;
}

export class SystemMessageCatalog {
  private readonly shuffleState = new Map<string, ShuffleBagState>();

  public constructor(private readonly messages: SystemMessageCatalogSource) {}

  public render(
    key: string,
    variables: SystemMessageVariables = {},
  ): string {
    const variants = normalizeVariants(this.messages[key]);

    if (variants.length === 0) {
      return `[missing system message: ${key}]`;
    }

    const state = this.shuffleState.get(key) ?? { bag: [] };

    if (state.bag.length === 0) {
      state.bag = shuffleVariants(variants, state.last);
    }

    const template = state.bag.shift();

    if (!template) {
      return `[missing system message: ${key}]`;
    }

    state.last = template;
    this.shuffleState.set(key, state);

    return interpolateTemplate(template, variables);
  }
}

export async function loadSystemMessageCatalog(
  catalogPath: string,
  fallbackCatalogPath?: string,
): Promise<SystemMessageCatalog> {
  const fallbackMessages =
    fallbackCatalogPath && fallbackCatalogPath !== catalogPath
      ? await readSystemMessageCatalogSource(fallbackCatalogPath)
      : {};
  const primaryMessages = await readSystemMessageCatalogSource(catalogPath);
  const mergedMessages = {
    ...fallbackMessages,
    ...primaryMessages,
  };

  const invalidKeys = Object.entries(mergedMessages)
    .filter(([, value]) => normalizeVariants(value).length === 0)
    .map(([key]) => key);

  if (invalidKeys.length > 0) {
    throw new Error(
      `System message catalog at ${catalogPath} has empty entries for: ${invalidKeys.join(", ")}`,
    );
  }

  return new SystemMessageCatalog(mergedMessages);
}

function isSystemMessageCatalogSource(
  value: unknown,
): value is SystemMessageCatalogSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(
    (entry) =>
      typeof entry === "string" ||
      (Array.isArray(entry) && entry.every((item) => typeof item === "string")),
  );
}

function normalizeVariants(value: string | string[] | undefined): string[] {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value.trim()] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function readSystemMessageCatalogSource(
  catalogPath: string,
): Promise<SystemMessageCatalogSource> {
  const source = await readFile(catalogPath, "utf8");
  const parsed = JSON.parse(source) as unknown;

  if (!isSystemMessageCatalogSource(parsed)) {
    throw new Error(
      `System message catalog at ${catalogPath} must be a JSON object whose values are strings or arrays of strings.`,
    );
  }

  return parsed;
}

function shuffleVariants(variants: string[], lastUsed?: string): string[] {
  const shuffled = [...variants];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  if (shuffled.length > 1 && lastUsed && shuffled[0] === lastUsed) {
    const alternateIndex = shuffled.findIndex((variant) => variant !== lastUsed);

    if (alternateIndex > 0) {
      [shuffled[0], shuffled[alternateIndex]] = [shuffled[alternateIndex], shuffled[0]];
    }
  }

  return shuffled;
}

function interpolateTemplate(
  template: string,
  variables: SystemMessageVariables,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = variables[name];

    if (value === undefined || value === null) {
      return `{${name}}`;
    }

    return String(value);
  });
}
