export function projectRelativeChronology<T>(value: T, observedAt: Date): T {
  return projectValue(value, observedAt) as T;
}

function projectValue(value: unknown, observedAt: Date, key = ""): unknown {
  if (Array.isArray(value)) return value.map((entry) => projectValue(entry, observedAt));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, projectValue(entry, observedAt, entryKey)]));
  if (typeof value === "string" && /(?:at|timestamp)$/i.test(key) && Number.isFinite(Date.parse(value))) return relativeTime(value, observedAt);
  return value;
}

function relativeTime(value: string, observedAt: Date): string {
  const difference = observedAt.getTime() - Date.parse(value);
  const future = difference < 0;
  const minutes = Math.max(0, Math.round(Math.abs(difference) / 60_000));
  const phrase = (amount: number, unit: string) => future ? `in ${amount} ${unit}${amount === 1 ? "" : "s"}` : `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
  if (minutes < 60) return phrase(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return phrase(hours, "hour");
  return phrase(Math.round(hours / 24), "day");
}
