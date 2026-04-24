import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { type StylePack } from "@voidbot/shared";

export async function loadStylePack(
  stylePackPath: string,
  enabled = true,
): Promise<StylePack | undefined> {
  try {
    const instructions = await readFile(stylePackPath, "utf8");

    return {
      name: basename(stylePackPath, extname(stylePackPath)),
      instructions: instructions.trim(),
      enabled,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

