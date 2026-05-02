import type {
  SocialReadBehavioralDimensionKey,
  SocialReadPresentationStrategyKey,
  SocialReadSituationalStateKey,
  SocialReadStableDispositionKey,
  SocialReadUnderlyingOrganizationKey,
  SocialReadVoiceStyleKey,
} from "@voidbot/shared";

export interface SocialReadDescriptor {
  label: string;
  description: string;
}

export const UNDERLYING_ORGANIZATION_DESCRIPTORS: Record<
  SocialReadUnderlyingOrganizationKey,
  SocialReadDescriptor
> = {
  self_coherence: {
    label: "Self-Coherence",
    description: "How integrated and stable the person's sense of self seems under pressure.",
  },
  contingent_worth: {
    label: "Contingent Worth",
    description:
      "Whether their felt worth appears tied to approval, utility, status, purity, or validation.",
  },
  shame_sensitivity: {
    label: "Shame Sensitivity",
    description: "Whether exposure, correction, failure, or diminishment seems especially painful.",
  },
  reciprocity_capacity: {
    label: "Reciprocity Capacity",
    description:
      "Whether they seem able to sustain mutual obligations instead of purely extractive or avoidant relations.",
  },
  mentalization_quality: {
    label: "Mentalization Quality",
    description:
      "Whether they model other minds with nuance instead of flattening them into crude threat, need, or utility shapes.",
  },
  authenticity_tolerance: {
    label: "Authenticity Tolerance",
    description:
      "Whether they can be known without immediately retreating into performance, concealment, or control.",
  },
  mask_rigidity: {
    label: "Mask Rigidity",
    description: "Whether the performed self seems inflexible or load-bearing.",
  },
  external_regulation_dependence: {
    label: "External Regulation Dependence",
    description:
      "Whether emotional stability appears to depend heavily on other people, scripts, institutions, or external structures.",
  },
};

export const STABLE_DISPOSITION_DESCRIPTORS: Record<
  SocialReadStableDispositionKey,
  SocialReadDescriptor
> = {
  novelty_seeking: {
    label: "Novelty-Seeking",
    description: "Attraction to new experience, strange opportunities, or unproven paths.",
  },
  conformity: {
    label: "Conformity",
    description: "Preference for accepted norms, procedures, and group expectations.",
  },
  status_hunger: {
    label: "Status Hunger",
    description: "Desire for rank, prestige, visible recognition, or superiority.",
  },
  risk_tolerance: {
    label: "Risk Tolerance",
    description: "Willingness to accept danger, uncertainty, or loss for gain or freedom.",
  },
  sociability: {
    label: "Sociability",
    description: "Baseline draw toward company, conversation, and social energy.",
  },
  baseline_threat_sensitivity: {
    label: "Baseline Threat Sensitivity",
    description:
      "Default readiness to detect danger, betrayal, humiliation, or exploitation.",
  },
  aesthetic_appetite: {
    label: "Aesthetic Appetite",
    description:
      "Sensitivity to beauty, style, symbolic form, taste, or expressive environment.",
  },
  ideological_rigidity: {
    label: "Ideological Rigidity",
    description: "Resistance to revising beliefs, myths, doctrines, or explanatory frames.",
  },
};

export const BEHAVIORAL_DIMENSION_DESCRIPTORS: Record<
  SocialReadBehavioralDimensionKey,
  SocialReadDescriptor
> = {
  interpersonal_warmth: {
    label: "Interpersonal Warmth",
    description: "Tendency to express care, friendliness, affection, or social welcome.",
  },
  drive: {
    label: "Drive",
    description: "Goal pressure, persistence, ambition, and forward force.",
  },
  grandiosity: {
    label: "Grandiosity",
    description:
      "Inflated self-importance, entitlement, exceptionalism, or self-mythologizing.",
  },
  validation_seeking: {
    label: "Validation-Seeking",
    description: "Need for reassurance, approval, recognition, or confirmation of worth.",
  },
  anxiety: {
    label: "Anxiety",
    description: "Anticipatory fear, worry, nervous vigilance, or instability under uncertainty.",
  },
  control_pressure: {
    label: "Control Pressure",
    description: "Urge to manage people, situations, information, or outcomes tightly.",
  },
  hostility: {
    label: "Hostility",
    description: "Readiness toward anger, contempt, antagonism, attack, or punishment.",
  },
  suspicion: {
    label: "Suspicion",
    description: "Expectation that others hide motives, traps, threats, or bad faith.",
  },
  rigidity: {
    label: "Rigidity",
    description: "Difficulty adapting behavior, plans, or interpretation under new evidence.",
  },
  withdrawal: {
    label: "Withdrawal",
    description: "Tendency to disengage, retreat, shut down, or reduce availability.",
  },
  volatility: {
    label: "Volatility",
    description: "Speed and intensity of emotional swings or escalation.",
  },
  attachment_seeking: {
    label: "Attachment-Seeking",
    description:
      "Pull toward closeness, reassurance, privileged access, fusion, or being chosen.",
  },
  distance_seeking: {
    label: "Distance-Seeking",
    description:
      "Push toward space, opacity, autonomy, and reduced emotional claim from others.",
  },
};

export const PRESENTATION_STRATEGY_DESCRIPTORS: Record<
  SocialReadPresentationStrategyKey,
  SocialReadDescriptor
> = {
  charm: {
    label: "Charm",
    description: "Performs warmth, ease, charisma, or pleasantness to influence or smooth contact.",
  },
  compliance: {
    label: "Compliance",
    description:
      "Performs agreement, submission, helpfulness, or nonthreatening cooperation.",
  },
  superiority: {
    label: "Superiority",
    description:
      "Performs being above others, more competent, more refined, or less vulnerable.",
  },
  detachment: {
    label: "Detachment",
    description: "Performs cool distance, emotional unavailability, or not-needing.",
  },
  seductiveness: {
    label: "Seductiveness",
    description: "Performs desirability, invitation, or intimate leverage.",
  },
  competence_theater: {
    label: "Competence Theater",
    description:
      "Performs capability and control, sometimes beyond what is actually secure.",
  },
  moral_theater: {
    label: "Moral Theater",
    description: "Performs righteousness, purity, sacrifice, or ethical authority.",
  },
  strategic_opacity: {
    label: "Strategic Opacity",
    description:
      "Controls what others can know; hides motives, pain, dependency, or plans.",
  },
  cultivated_harmlessness: {
    label: "Cultivated Harmlessness",
    description: "Performs being safe, small, useful, cute, or beneath concern.",
  },
  abrasive_boundary: {
    label: "Abrasive Boundary",
    description: "Performs difficulty, bite, or unpleasantness to keep others from pressing closer.",
  },
  ironic_distance: {
    label: "Ironic Distance",
    description: "Performs irony, detachment, or joking distance to avoid naked sincerity.",
  },
};

export const VOICE_STYLE_DESCRIPTORS: Record<
  SocialReadVoiceStyleKey,
  SocialReadDescriptor
> = {
  dryness: { label: "Dryness", description: "Understated, deadpan, low-sentiment phrasing." },
  verbal_warmth: {
    label: "Verbal Warmth",
    description: "Inviting, affectionate, reassuring, or socially soft phrasing.",
  },
  formality: {
    label: "Formality",
    description: "Uses formal structure, titles, careful address, or institutionally correct phrasing.",
  },
  verbosity: {
    label: "Verbosity",
    description: "Tends toward longer turns, elaboration, qualification, or verbal sprawl.",
  },
  pace: {
    label: "Pace",
    description: "Moves quickly through turns, interruptions, replies, or topic shifts.",
  },
  plainspoken_directness: {
    label: "Plainspoken Directness",
    description: "Speaks plainly, concretely, or bluntly rather than ornamenting or obscuring.",
  },
  lexical_precision: {
    label: "Lexical Precision",
    description: "Chooses exact words, distinctions, definitions, or careful terms.",
  },
  technical_density: {
    label: "Technical Density",
    description: "Packs speech with specialist terms, systems language, procedure, or analysis.",
  },
  technical_compression: {
    label: "Technical Compression",
    description: "Compresses technical meaning into terse expert shorthand.",
  },
  figurative_language: {
    label: "Figurative Language",
    description: "Uses metaphor, image, analogy, poetic compression, or symbolic framing.",
  },
  lyricism: {
    label: "Lyricism",
    description: "Uses musical, poetic, sensuous, or rhythmically heightened language.",
  },
  narrative_detail: {
    label: "Narrative Detail",
    description: "Explains through context, sequence, anecdote, or concrete scene detail.",
  },
  emotional_explicitness: {
    label: "Emotional Explicitness",
    description: "Names feelings, needs, wounds, affection, fear, or attachment directly.",
  },
  pointedness: {
    label: "Pointedness",
    description: "Cuts directly, sharply, or with barbed precision.",
  },
  self_disclosure: {
    label: "Self-Disclosure",
    description: "Volunteers personal history, inner state, motives, or private stakes.",
  },
  hedging: {
    label: "Hedging",
    description: "Softens claims with uncertainty markers, caveats, deference, or exits.",
  },
  certainty_marking: {
    label: "Certainty Marking",
    description: "Signals confidence, finality, authority, or refusal to leave claims open.",
  },
  politeness: {
    label: "Politeness",
    description: "Uses courtesy, mitigation, face-saving language, or social smoothing.",
  },
  coded_politeness: {
    label: "Coded Politeness",
    description: "Uses polite phrasing to imply criticism, threat, refusal, hierarchy, or hidden meaning.",
  },
  ritualized_address: {
    label: "Ritualized Address",
    description: "Uses formulaic greetings, titles, honorifics, oaths, prayers, or ceremonial phrases.",
  },
  register_switching: {
    label: "Register Switching",
    description: "Shifts between speech registers depending on audience, status, danger, or role.",
  },
  dialect_marking: {
    label: "Dialect Marking",
    description: "Shows regional, class, occupational, subcultural, or community-specific speech markers.",
  },
  theatricality: {
    label: "Theatricality",
    description: "Performs speech with heightened drama, staging, persona, flourish, or rhetorical display.",
  },
  humor: {
    label: "Humor",
    description: "Uses jokes, wit, absurdity, teasing, or comic framing as a regular speech tool.",
  },
  conversational_dominance: {
    label: "Conversational Dominance",
    description: "Takes, holds, redirects, or controls conversational floor and agenda.",
  },
  listening_responsiveness: {
    label: "Listening Responsiveness",
    description: "Reflects, tracks, validates, or adapts to what the other person just said.",
  },
  question_asking: {
    label: "Question-Asking",
    description: "Uses questions to probe, invite, corner, teach, test, or keep the other person talking.",
  },
  profanity: {
    label: "Profanity",
    description: "Uses taboo, vulgar, sacred, or deliberately coarse language.",
  },
};

export const SITUATIONAL_STATE_DESCRIPTORS: Record<
  SocialReadSituationalStateKey,
  SocialReadDescriptor
> = {
  exhaustion: {
    label: "Exhaustion",
    description: "Current depletion, fatigue, overuse, or low reserve.",
  },
  scarcity_pressure: {
    label: "Scarcity Pressure",
    description: "Pressure from money, supplies, access, time, space, safety, or opportunity being scarce.",
  },
  humiliation: {
    label: "Humiliation",
    description: "Current felt diminishment, exposure, embarrassment, or status wound.",
  },
  panic: {
    label: "Panic",
    description: "Acute fear, urgency, overwhelm, or threat response.",
  },
  triumph: {
    label: "Triumph",
    description: "Current victory, vindication, high confidence, or emotional lift.",
  },
  grief: {
    label: "Grief",
    description: "Active loss, mourning, sorrow, or ache.",
  },
  overstimulation: {
    label: "Overstimulation",
    description: "Current sensory, social, cognitive, or emotional overload.",
  },
  grievance_activation: {
    label: "Grievance Activation",
    description: "Active resentment, injustice memory, or retaliatory moral charge.",
  },
  acute_shame: {
    label: "Acute Shame",
    description: "Immediate shame flare, exposure pain, or self-disgust.",
  },
  perceived_status_threat: {
    label: "Perceived Status Threat",
    description: "Current sense that rank, dignity, competence, or face is under threat.",
  },
};

