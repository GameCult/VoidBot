import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type PromptTemplateValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | PromptTemplateRecord
  | PromptTemplateValue[];

export interface PromptTemplateRecord {
  [key: string]: PromptTemplateValue;
}

export interface RenderPromptTemplateOptions {
  promptsRoot?: string;
}

export function loadPromptTemplate(
  templateName: string,
  variables: PromptTemplateRecord = {},
  options: RenderPromptTemplateOptions = {},
): string {
  const promptsRoot = options.promptsRoot ?? resolve(process.cwd(), "prompts");
  const templatePath = resolve(promptsRoot, templateName);
  const template = readFileSync(templatePath, "utf8");
  return renderPromptTemplate(template, variables);
}

export function renderPromptTemplate(
  template: string,
  variables: PromptTemplateRecord = {},
): string {
  let rendered = template;
  rendered = renderEachBlocks(rendered, variables);
  rendered = renderConditionalBlocks(rendered, variables, "if");
  rendered = renderConditionalBlocks(rendered, variables, "unless");
  rendered = rendered.replace(/\{\{\s*([.#A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g, (_match, key: string) =>
    stringifyPromptValue(resolvePromptValue(variables, key)),
  );
  return trimTrailingSpaces(rendered).trim();
}

function renderEachBlocks(template: string, variables: PromptTemplateRecord): string {
  return template.replace(
    /\{\{#each\s+([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_match, key: string, body: string) => {
      const value = resolvePromptValue(variables, key);
      if (!Array.isArray(value) || value.length === 0) {
        return "";
      }
      return value.map((entry) => {
        const scoped = typeof entry === "object" && entry !== null && !Array.isArray(entry)
          ? { ...variables, ...(entry as PromptTemplateRecord), ".": entry }
          : { ...variables, ".": entry };
        return renderPromptTemplate(body, scoped).trimEnd();
      }).join("\n");
    },
  );
}

function renderConditionalBlocks(
  template: string,
  variables: PromptTemplateRecord,
  kind: "if" | "unless",
): string {
  const expression = new RegExp(
    `\\{\\{#${kind}\\s+([A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*)\\s*\\}\\}([\\s\\S]*?)\\{\\{/${kind}\\}\\}`,
    "g",
  );
  return template.replace(expression, (_match, key: string, body: string) => {
    const value = resolvePromptValue(variables, key);
    const include = kind === "if" ? isTruthyPromptValue(value) : !isTruthyPromptValue(value);
    return include ? renderPromptTemplate(body, variables) : "";
  });
}

function resolvePromptValue(variables: PromptTemplateRecord, path: string): PromptTemplateValue {
  if (path === ".") {
    return variables["."];
  }
  return path.split(".").reduce<PromptTemplateValue>((current, part) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      return (current as PromptTemplateRecord)[part];
    }
    return undefined;
  }, variables);
}

function stringifyPromptValue(value: PromptTemplateValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stringifyPromptValue(entry)).join("\n");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function isTruthyPromptValue(value: PromptTemplateValue): boolean {
  if (value === null || value === undefined || value === false) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

function trimTrailingSpaces(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
}
