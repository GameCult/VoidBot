const STOP_WORDS = new Set([
  "about", "actually", "after", "again", "agent", "agents", "already", "another", "around", "because", "before", "being", "between", "channel", "could", "does", "doing", "don", "even", "every", "exactly", "face", "faces", "first", "from", "give", "going", "good", "have", "here", "into", "just", "kind", "know", "latest", "like", "line", "little", "made", "make", "maybe", "more", "need", "needs", "only", "other", "point", "post", "really", "recent", "right", "rights", "room", "same", "should", "something", "still", "take", "talk", "than", "that", "their", "them", "there", "these", "they", "thing", "things", "think", "this", "those", "through", "turn", "want", "what", "when", "where", "which", "while", "with", "work", "would", "write", "you", "your",
]);

export function significantPersonaTopicTerms(content: string): string[] {
  const normalized = collapsePersonaText(content)
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/<:[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "url")
    .replace(/[^\p{L}\p{N}\s.'-]/gu, " ")
    .replace(/\b\d{5,}\b/g, " ")
    .replace(/\b[a-z]*\d+[a-z0-9]*\b/g, " ");
  return [...new Set(normalized.split(/\s+/).map((term) => term.replace(/^['.-]+|['.-]+$/g, "")).filter((term) => term.length >= 4 && !STOP_WORDS.has(term)))];
}

export function collapsePersonaText(value: string, maxLength?: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return maxLength && normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}
