import { type PronounEvidence, type PronounSet } from "@voidbot/shared";

const MAX_EXCERPT_LENGTH = 160;

const PREFER_PATTERNS: Array<{ pronounSet: PronounSet; pattern: RegExp }> = [
  {
    pronounSet: "she/her",
    pattern:
      /\bmy pronouns (?:are|re)\s+(?:she\s*\/\s*her|she her|female pronouns?)\b/i,
  },
  {
    pronounSet: "she/her",
    pattern:
      /\bi (?:prefer|use|want|would like)\s+(?:she\s*\/\s*her|she her|female pronouns?)\b/i,
  },
  {
    pronounSet: "she/her",
    pattern:
      /\b(?:use|call|refer to) me(?: as)?\s+(?:she\s*\/\s*her|she her)\b/i,
  },
  {
    pronounSet: "she/her",
    pattern: /\b(?:use|prefer)\s+female pronouns?\s+for me\b/i,
  },
  {
    pronounSet: "he/him",
    pattern:
      /\bmy pronouns (?:are|re)\s+(?:he\s*\/\s*him|he him|male pronouns?)\b/i,
  },
  {
    pronounSet: "he/him",
    pattern:
      /\bi (?:prefer|use|want|would like)\s+(?:he\s*\/\s*him|he him|male pronouns?)\b/i,
  },
  {
    pronounSet: "he/him",
    pattern:
      /\b(?:use|call|refer to) me(?: as)?\s+(?:he\s*\/\s*him|he him)\b/i,
  },
  {
    pronounSet: "he/him",
    pattern: /\b(?:use|prefer)\s+male pronouns?\s+for me\b/i,
  },
  {
    pronounSet: "they/them",
    pattern:
      /\bmy pronouns (?:are|re)\s+(?:they\s*\/\s*them|they them|neutral pronouns?)\b/i,
  },
  {
    pronounSet: "they/them",
    pattern:
      /\bi (?:prefer|use|want|would like)\s+(?:they\s*\/\s*them|they them|neutral pronouns?)\b/i,
  },
  {
    pronounSet: "they/them",
    pattern:
      /\b(?:use|call|refer to) me(?: as)?\s+(?:they\s*\/\s*them|they them)\b/i,
  },
  {
    pronounSet: "they/them",
    pattern: /\b(?:use|prefer)\s+neutral pronouns?\s+for me\b/i,
  },
];

const AVOID_PATTERNS: Array<{ pronounSet: PronounSet; pattern: RegExp }> = [
  {
    pronounSet: "she/her",
    pattern:
      /\b(?:do not|don't) call me(?: as)?\s+(?:she|she\s*\/\s*her|she her)\b/i,
  },
  {
    pronounSet: "she/her",
    pattern:
      /\bi (?:prefer|would prefer|want) not to be called(?: as)?\s+(?:she|she\s*\/\s*her|she her)\b/i,
  },
  {
    pronounSet: "he/him",
    pattern:
      /\b(?:do not|don't) call me(?: as)?\s+(?:he|he\s*\/\s*him|he him)\b/i,
  },
  {
    pronounSet: "he/him",
    pattern:
      /\bi (?:prefer|would prefer|want) not to be called(?: as)?\s+(?:he|he\s*\/\s*him|he him)\b/i,
  },
  {
    pronounSet: "they/them",
    pattern:
      /\b(?:do not|don't) call me(?: as)?\s+(?:they|they\s*\/\s*them|they them)\b/i,
  },
  {
    pronounSet: "they/them",
    pattern:
      /\bi (?:prefer|would prefer|want) not to be called(?: as)?\s+(?:they|they\s*\/\s*them|they them)\b/i,
  },
];

export function extractDirectPromptPronounEvidence(
  prompt: string,
  timestamp = new Date().toISOString(),
): PronounEvidence[] {
  const excerpt = buildExcerpt(prompt);
  const evidence: PronounEvidence[] = [];

  for (const candidate of PREFER_PATTERNS) {
    if (candidate.pattern.test(prompt)) {
      evidence.push({
        pronounSet: candidate.pronounSet,
        source: "explicit_self_statement",
        stance: "prefer",
        confidence: 1,
        excerpt,
        timestamp,
      });
    }
  }

  for (const candidate of AVOID_PATTERNS) {
    if (candidate.pattern.test(prompt)) {
      evidence.push({
        pronounSet: candidate.pronounSet,
        source: "explicit_correction",
        stance: "avoid",
        confidence: 1,
        excerpt,
        timestamp,
      });
    }
  }

  return dedupePronounEvidence(evidence);
}

function dedupePronounEvidence(evidence: PronounEvidence[]): PronounEvidence[] {
  const deduped = new Map<string, PronounEvidence>();

  for (const entry of evidence) {
    const key = `${entry.pronounSet}::${entry.source}::${entry.stance}`;

    if (!deduped.has(key)) {
      deduped.set(key, entry);
    }
  }

  return [...deduped.values()];
}

function buildExcerpt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_EXCERPT_LENGTH
    ? compact
    : `${compact.slice(0, MAX_EXCERPT_LENGTH - 3)}...`;
}
