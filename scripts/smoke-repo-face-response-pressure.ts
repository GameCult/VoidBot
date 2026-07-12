import assert from "node:assert/strict";

import { projectRepoFaceResponsePressure } from "@voidbot/core";
import {
  embedAffinityCards,
  scoreAffinityMessages,
  type TextEmbedder,
} from "@voidbot/rag";

const now = new Date("2026-07-12T12:00:00.000Z");
const embedder: TextEmbedder = {
  id: "fixture:3",
  dimensions: 3,
  async embedDocuments(texts) {
    return texts.map(vectorFor);
  },
  async embedQuery(text) {
    return vectorFor(text);
  },
};

async function main(): Promise<void> {
const cards = await embedAffinityCards(embedder, [
  { id: "aqua", text: "music synthesizer sound patch" },
  { id: "heimdall", text: "oauth custody authentication grants" },
  { id: "nibu", text: "aetheria lore narrative factions" },
]);
const scores = await scoreAffinityMessages(embedder, cards, [
  { id: "music", text: "the synthesizer patch has a strange sound", observedAt: now.toISOString() },
  { id: "auth", text: "oauth grants need revocation", observedAt: now.toISOString() },
]);

assert.equal(cards.length, 3);
const score = (cardId: string, messageId: string): number =>
  scores.find((item) => item.cardId === cardId && item.messageId === messageId)?.similarity ?? -1;
assert.ok(score("aqua", "music") > score("heimdall", "music"));
assert.ok(score("heimdall", "auth") > score("aqua", "auth"));

const projected = projectRepoFaceResponsePressure({
  participants: cards.map((card) => ({ identityId: card.id, interruptThreshold: 0.5 })),
  evidence: scores.map((item) => ({
    identityId: item.cardId,
    messageId: item.messageId,
    observedAt: item.observedAt,
    similarity: item.similarity,
  })),
  now,
  maxAwakened: 2,
});
assert.ok((projected.find((item) => item.identityId === "aqua")?.pressure ?? 0) > 0.5);
assert.ok((projected.find((item) => item.identityId === "heimdall")?.pressure ?? 0) > 0.5);
assert.equal(projected.find((item) => item.identityId === "nibu")?.pressure, 0, "dogpile cap must cool irrelevant cards");

const expired = projectRepoFaceResponsePressure({
  participants: [{ identityId: "aqua", interruptThreshold: 0.5 }],
  evidence: [{
    identityId: "aqua",
    messageId: "old",
    observedAt: "2026-07-12T06:00:00.000Z",
    similarity: 1,
  }],
  now,
  ttlMinutes: 60,
});
assert.equal(expired[0]?.pressure, 0, "expired evidence must not alter initiative");

const duplicate = projectRepoFaceResponsePressure({
  participants: [{ identityId: "aqua", interruptThreshold: 0.5 }],
  evidence: [
    { identityId: "aqua", messageId: "same", observedAt: now.toISOString(), similarity: 0.8 },
    { identityId: "aqua", messageId: "same", observedAt: now.toISOString(), similarity: 0.8 },
  ],
  now,
});
assert.equal(duplicate[0]?.evidence.length, 1, "replayed windows must be idempotent by message id");

await assert.rejects(
  scoreAffinityMessages({ ...embedder, id: "other" }, cards, []),
  /uses fixture:3, not other/,
);

process.stdout.write(`${JSON.stringify({ ok: true, cards: cards.length, scoreCount: scores.length, projected })}\n`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function vectorFor(text: string): number[] {
  const lower = text.toLowerCase();
  const vector = [
    /music|synth|sound|patch/.test(lower) ? 1 : 0,
    /oauth|auth|grant|custody|revocation/.test(lower) ? 1 : 0,
    /aetheria|lore|narrative|faction/.test(lower) ? 1 : 0,
  ];
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}
