import { resolve } from "node:path";
import { applyVoidSelfStateOperation, loadVoidSelfStateTypedDocuments } from "@voidbot/core";
import { readVoidModerationActivity } from "./void-moderation-activity-source.js";
import { projectVoidPhysiology, type VoidPhysiologyProjection } from "./void-physiology-domain.js";

export interface VoidPhysiologyOrganResult extends VoidPhysiologyProjection {
  ok: true;
  observedAt: string;
  statePath: string;
  moderationLockPath: string;
}

export async function runVoidPhysiologyOrgan(input: {
  statePath: string;
  statusDirectory: string;
  observedAt?: Date;
}, dependencies: {
  loadState?: typeof loadVoidSelfStateTypedDocuments;
  applyOperation?: typeof applyVoidSelfStateOperation;
  readModerationActivity?: typeof readVoidModerationActivity;
} = {}): Promise<VoidPhysiologyOrganResult> {
  const observedAt = input.observedAt ?? new Date();
  const moderationLockPath = resolve(input.statusDirectory, "moderation-rumination.lock");
  const [state, moderation] = await Promise.all([
    (dependencies.loadState ?? loadVoidSelfStateTypedDocuments)({ canonicalPath: input.statePath }),
    (dependencies.readModerationActivity ?? readVoidModerationActivity)({ lockPath: moderationLockPath, observedAt }),
  ]);
  const projection = projectVoidPhysiology({ state, observedAt, moderationActive: moderation.active });
  for (const operation of projection.operations) await (dependencies.applyOperation ?? applyVoidSelfStateOperation)({ canonicalPath: input.statePath }, operation);
  return { ok: true, observedAt: observedAt.toISOString(), statePath: input.statePath, moderationLockPath, ...projection };
}
