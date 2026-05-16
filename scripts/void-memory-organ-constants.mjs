export const DEFAULT_VECTOR_DIMENSIONS = 96;
export const MAX_EDGE_COUNT = 8;
export const MAX_CLUSTER_COUNT = 2;
export const MAX_INCUBATING_THOUGHTS = 2;
export const MAX_RECENT_EPISODIC_RECORDS = 10;
export const MAX_RECENT_QUIET_EPISODIC_RECORDS = 2;
export const MAX_POST_NAP_EPISODIC_RECORDS = 4;
export const MAX_POST_NAP_QUIET_EPISODIC_RECORDS = 1;
export const MAX_POST_NAP_ARCHIVE_EXCURSIONS = 2;
export const MAX_POST_NAP_REPO_SWEEPS = 2;
export const MAX_POST_NAP_NOVELTY_CHECKS = 3;
export const MAX_POST_NAP_MUSINGS = 6;
export const MAX_POST_NAP_RECENT_MUSINGS = 2;
export const MAX_POST_NAP_CANDIDATE_INTERVENTIONS = 4;
export const MAX_POST_NAP_SEAM_PROMOTIONS = 3;
export const MAX_POST_NAP_RESONANCE_EDGES = 4;
export const MAX_ARCHIVE_EXCURSION_MEMORIES = 4;
export const MAX_REPO_SWEEP_MEMORIES = 4;
export const MAX_SEMANTIC_MEMORIES = 14;
export const MAX_DREAM_MEMORIES = 5;
export const MAX_RUNTIME_REPO_SWEEPS = 1;
export const MAX_RUNTIME_REPO_ACTIVITY_MEMORIES = 1;
export const MAX_RUNTIME_ARCHIVE_EXCURSIONS = 2;
export const MAX_RUNTIME_RUMINATION_SEEDS = 4;
export const MAX_RECENT_SYNTHESIS_COUNT = 1;
export const MAX_SUPPORTING_REFS = 4;
export const MAX_CLUSTER_MEMORY_IDS = 6;
export const MAX_INCUBATION_SOURCE_IDS = 5;
export const MAX_DREAM_SOURCE_IDS = 4;
export const MAX_DISCOMFORT_COUNT = 6;
export const MAX_ACTIVE_TENSION_COUNT = 6;
export const MAX_ADVOCACY_REQUEST_COUNT = 4;
export const MIN_SUPPORT_FOR_IDENTITY_CRYSTALLIZATION = 64;
export const MIN_DEEP_DIVES_FOR_IDENTITY_CRYSTALLIZATION = 96;
export const MAX_RECENT_ANALYTIC_THREADS = 6;
export const MAX_RECENT_QUIET_ANALYTIC_THREADS = 1;
export const EDGE_SIMILARITY_THRESHOLD = 0.56;
export const CLUSTER_SIMILARITY_THRESHOLD = 0.64;
export const TOPIC_MATCH_THRESHOLD = 0.42;
export const REFRACTORY_MATCH_THRESHOLD = 0.48;
export const MAX_TOPIC_SATURATION_COUNT = 6;
export const MAX_REFRACTORY_TOPIC_COUNT = 6;
export const stopwords = new Set([
  "a",
  "about",
  "after",
  "against",
  "all",
  "also",
  "an",
  "and",
  "another",
  "are",
  "around",
  "as",
  "at",
  "because",
  "been",
  "before",
  "being",
  "between",
  "but",
  "by",
  "can",
  "current",
  "did",
  "discord",
  "do",
  "does",
  "doing",
  "for",
  "from",
  "fresh",
  "get",
  "got",
  "had",
  "has",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "keep",
  "keeps",
  "kind",
  "last",
  "like",
  "live",
  "made",
  "make",
  "means",
  "message",
  "messages",
  "more",
  "most",
  "new",
  "no",
  "not",
  "now",
  "of",
  "on",
  "one",
  "owner",
  "or",
  "other",
  "our",
  "out",
  "over",
  "own",
  "post",
  "posted",
  "quiet",
  "recent",
  "run",
  "same",
  "saved",
  "seam",
  "should",
  "small",
  "so",
  "still",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "thing",
  "this",
  "thought",
  "traffic",
  "through",
  "to",
  "too",
  "toward",
  "under",
  "up",
  "use",
  "using",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "worth",
  "would",
  "yet",
  "you",
  "smoke",
]);
export const labelNoiseTokens = new Set([
  "active",
  "archive",
  "bridge",
  "build",
  "built",
  "candidate",
  "cluster",
  "cooling",
  "deepened",
  "dream",
  "draft",
  "episodic",
  "distill",
  "excursion",
  "excursions",
  "distilled",
  "holding",
  "identity",
  "incubating",
  "instead",
  "intervention",
  "interventions",
  "latent",
  "lane",
  "memory",
  "memories",
  "messagepack",
  "moderation",
  "musing",
  "musings",
  "novelty",
  "organ",
  "organs",
  "pass",
  "private",
  "question",
  "questions",
  "receipts",
  "actually",
  "behaving",
  "branch",
  "compressed",
  "recurring",
  "repo",
  "repos",
  "resonance",
  "semantic",
  "single",
  "state",
  "status",
  "summary",
  "surface",
  "surfaces",
  "sweep",
  "sweeps",
  "talking",
  "than",
  "thread",
  "threads",
  "topic",
  "topics",
  "trying",
  "wants",
  "present",
  "part",
  "rather",
  "itself",
  "across",
]);
