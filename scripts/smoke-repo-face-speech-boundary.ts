import {
  isNonPublicRepoIdentitySpeech,
  normalizePublicRepoIdentitySpeech,
  parseRepoIdentityPostIntents,
} from "../apps/worker/src/repo-face-speech.js";

type Case = {
  name: string;
  run: () => boolean;
  detail: string;
};

const cases: Case[] = [
  {
    name: "raw Would say fallback stays private",
    run: () => parseRepoIdentityPostIntents([
      "Private thought: I should stay quiet.",
      "Would say: `nothing right now.`",
      "What should stick: silence is correct.",
    ].join("\n")).length === 0,
    detail: "A child Face draft must not create public speech unless the parent Interpreter emits SAY.",
  },
  {
    name: "structured silence SAY rejected",
    run: () => isNonPublicRepoIdentitySpeech("nothing right now."),
    detail: "Even a malformed Interpreter SAY cannot send silence markers as public content.",
  },
  {
    name: "qualified silence SAY rejected",
    run: () => isNonPublicRepoIdentitySpeech("nothing public yet. I want one real specimen first."),
    detail: "Silence explanations that add private rationale are still not public speech.",
  },
  {
    name: "bare no-public line rejected",
    run: () => isNonPublicRepoIdentitySpeech("No public line. Silence is cleaner here."),
    detail: "The worker must not post parent routing language as a Face message.",
  },
  {
    name: "single-line markdown fence rejected",
    run: () => isNonPublicRepoIdentitySpeech("`the whole message is a code span`"),
    detail: "A whole Face message wrapped as code is transport-shaped, not public speech.",
  },
  {
    name: "block markdown fence rejected",
    run: () => isNonPublicRepoIdentitySpeech("```text\nnothing right now\n```"),
    detail: "A whole Face message wrapped in a code block is not public speech.",
  },
  {
    name: "legitimate SAY normalizes inline code",
    run: () => {
      const posts = parseRepoIdentityPostIntents([
        "SAY",
        "identity: current_face_id",
        "channel: current_room",
        "content:",
        "  `Wavecrafter` needs owners, costs, and a leash before it earns the noun.",
        "END",
      ].join("\n"));
      return posts.length === 1 &&
        posts[0]?.content === "`Wavecrafter` needs owners, costs, and a leash before it earns the noun." &&
        !isNonPublicRepoIdentitySpeech(posts[0].content) &&
        normalizePublicRepoIdentitySpeech(posts[0].content) ===
          "\"Wavecrafter\" needs owners, costs, and a leash before it earns the noun.";
    },
    detail: "Inline code inside a real sentence remains valid, but the public mouth strips Markdown code styling.",
  },
  {
    name: "inline telemetry labels normalize",
    run: () => normalizePublicRepoIdentitySpeech(
      "show `rear pair drifting 38 ms`, `geometry confidence low`, `world model provisional`."
    ) ===
      "show \"rear pair drifting 38 ms\", \"geometry confidence low\", \"world model provisional\".",
    detail: "Repo Faces can mention technical labels without speaking in code spans.",
  },
  {
    name: "leading self-label is stripped with kana-folding",
    run: () => normalizePublicRepoIdentitySpeech(
      "メタめ: We need one real owner for the public name.",
      {
        identityId: "metame",
        displayName: "メタメ",
        repoName: "メタメ",
      },
    ) === "We need one real owner for the public name.",
    detail: "The public speech boundary owns the speaker label, so mixed-script self-renames in SAY content must be stripped before posting.",
  },
];

const failures = cases.filter((entry) => !entry.run());
if (failures.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    failures: failures.map(({ name, detail }) => ({ name, detail })),
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  checked: cases.map(({ name }) => name),
}, null, 2));
