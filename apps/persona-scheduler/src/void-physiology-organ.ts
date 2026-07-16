import { applyVoidSelfStateOperation, loadVoidSelfStateTypedDocuments } from "@voidbot/core";
import { projectVoidPhysiology, type VoidPhysiologyProjection } from "./void-physiology-domain.js";

export interface VoidPhysiologyOrganResult extends VoidPhysiologyProjection {
  ok: true;
  observedAt: string;
  statePath: string;
}

export async function runVoidPhysiologyOrgan(input: {
  statePath: string;
  observedAt?: Date;
  moderationActive?: boolean;
}, dependencies: {
  loadState?: typeof loadVoidSelfStateTypedDocuments;
  applyOperation?: typeof applyVoidSelfStateOperation;
} = {}): Promise<VoidPhysiologyOrganResult> {
  const observedAt = input.observedAt ?? new Date();
  const state = await (dependencies.loadState ?? loadVoidSelfStateTypedDocuments)({ canonicalPath: input.statePath });
  const projection = projectVoidPhysiology({ state, observedAt, moderationActive: input.moderationActive ?? false });
  for (const operation of projection.operations) await (dependencies.applyOperation ?? applyVoidSelfStateOperation)({ canonicalPath: input.statePath }, operation);
  return { ok: true, observedAt: observedAt.toISOString(), statePath: input.statePath, ...projection };
}
