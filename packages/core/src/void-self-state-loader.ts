import {
  type GuildContext,
  type SourceMessage,
  type VoidSelfStateContext,
} from "@voidbot/shared";

import { buildVoidSelfStateContext } from "./void-self-state-projection";
import { loadVoidSelfStateTypedDocuments } from "./void-self-state-service";

export interface LoadVoidSelfStateOptions {
  recentMessages?: SourceMessage[];
  guildContext?: GuildContext;
}

export async function loadVoidSelfState(
  statePath: string,
  options: LoadVoidSelfStateOptions = {},
): Promise<VoidSelfStateContext | undefined> {
  try {
    const typedProjection = await loadVoidSelfStateTypedDocuments({ canonicalPath: statePath });
    return buildVoidSelfStateContext(typedProjection, {
      sourcePath: statePath,
      ...options,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}
