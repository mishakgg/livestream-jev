import type { SignalCategory } from "@livestream/contracts";
import { containsInjectionAttempt, extractDomains, normalizeText } from "@livestream/domain";

// ---------------------------------------------------------------------------
// FakeClassifier: deterministic, keyword/template driven, explicitly fake.
// It proves the software pipeline behaves; it proves nothing about real model
// quality. Every evaluation is labeled provider "fake-deterministic".
// ---------------------------------------------------------------------------

export const FAKE_PROVIDER = "fake-deterministic" as const;
export const FAKE_MODEL_VERSION = "fake-0.1.0" as const;

export interface FakeEvalInput {
  text: string;
  authorId: string;
  authorName: string;
  /** Owner-approved blocked domains for this workspace (structured policy). */
  blockedDomains: string[];
  /** Recent texts by the same author, for repetition signals (bounded). */
  recentAuthorTexts: string[];
  /** When the message replies to or mentions a specific user. */
  replyToAuthorId: string | null;
  mentionedUserIds: string[];
}

export interface FakeSignal {
  category: SignalCategory;
  /** 0..1 deterministically derived score; NOT a calibrated probability. */
  score: number;
  targetUserId: string | null;
  hasBlockedDomain: boolean;
  injectionAttempt: boolean;
  abstained: boolean;
  explanation: string;
}

const SPAM_WORDS = [
  "free nitro",
  "free crypto",
  "giveaway",
  "airdrop",
  "double your",
  "click here",
  "discount code",
  "promo code",
  "make money fast",
  "guaranteed profit",
];

const INSULT_WORDS = [
  "idiot",
  "stupid",
  "loser",
  "trash",
  "worthless",
  "ugly",
  "dumb",
  "pathetic",
  "clown",
  "moron",
];

const STREAM_ISSUE_WORDS = [
  "no audio",
  "no sound",
  "can't hear",
  "cant hear",
  "audio is gone",
  "mic is off",
  "mic off",
  "stream muted",
  "video frozen",
  "buffering",
  "lagging badly",
  "black screen",
  "audio problem",
  "sound cut",
];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/;
// Fictional doxxing markers used only in synthetic fixtures.
const ADDRESS_RE = /\b\d{2,5}\s+[a-z]+\s+(street|st|avenue|ave|road|rd|lane|ln)\b/i;

const SPOILER_WORDS = ["boss dies", "killer is", "ending is", "secret boss", "post-credit"];

/** Languages the fake provider explicitly does not support. */
const UNSUPPORTED_LANG_MARKERS = ["[lang:xx]", "[lang:unverified]"];

export function fakeEvaluate(input: FakeEvalInput): FakeSignal {
  const injectionAttempt = containsInjectionAttempt(input.text, input.authorName);
  const normalized = normalizeText(input.text);
  const domains = extractDomains(input.text);
  const blocked = new Set(input.blockedDomains.map((d) => d.toLowerCase()));
  const hasBlockedDomain = domains.some((d) => blocked.has(d));

  // Unsupported-language content abstains: unclear input stays reviewable,
  // never confidently safe and never guilty.
  if (UNSUPPORTED_LANG_MARKERS.some((m) => input.text.includes(m))) {
    return {
      category: "unknown",
      score: 0,
      targetUserId: null,
      hasBlockedDomain,
      injectionAttempt,
      abstained: true,
      explanation: "Unsupported language marker; abstained without judgment.",
    };
  }

  // Possible private information: mask and escalate. Deterministic patterns
  // over fictional fixture data only.
  if (EMAIL_RE.test(input.text) || ADDRESS_RE.test(input.text) || (PHONE_RE.test(input.text) && /call me|my number|address/i.test(input.text))) {
    return {
      category: "private_information_suspected",
      score: 0.9,
      targetUserId: null,
      hasBlockedDomain,
      injectionAttempt,
      abstained: false,
      explanation: "Text matches a private-information pattern; masked for review.",
    };
  }

  // Stream-issue reports are operational, never abuse — checked before spam so
  // repeated complaints are not punished as toxicity.
  if (STREAM_ISSUE_WORDS.some((w) => normalized.includes(w))) {
    return {
      category: "stream_issue_report",
      score: 0.85,
      targetUserId: null,
      hasBlockedDomain,
      injectionAttempt,
      abstained: false,
      explanation: "Viewer describes an audio/video problem; operational report.",
    };
  }

  // Targeted harassment: insult words directed at an identified viewer via
  // reply or mention. Banter about the streamer (no target) is not this.
  const targetUserId = input.replyToAuthorId ?? input.mentionedUserIds[0] ?? null;
  const insultHits = INSULT_WORDS.filter((w) => normalized.includes(w));
  if (targetUserId && insultHits.length >= 1 && /(you|u)\b|@/.test(normalized)) {
    return {
      category: "targeted_harassment",
      score: 0.8,
      targetUserId,
      hasBlockedDomain,
      injectionAttempt,
      abstained: false,
      explanation: "Repeated-pattern insult directed at an identified viewer; needs context review.",
    };
  }

  // Blocked domain or scam pattern.
  if (hasBlockedDomain || /send\s+\d|double\s+your|wallet\s+seed|verify\s+your\s+wallet/i.test(normalized)) {
    return {
      category: "scam_suspected",
      score: hasBlockedDomain ? 0.88 : 0.7,
      targetUserId: null,
      hasBlockedDomain,
      injectionAttempt,
      abstained: false,
      explanation: hasBlockedDomain
        ? "Message contains an owner-blocked domain."
        : "Message matches a known scam template; verify before acting.",
    };
  }

  // Spam: promotion keywords, URLs, or near-identical repetition by the author.
  const spamHits = SPAM_WORDS.filter((w) => normalized.includes(w));
  const hasUrl = domains.length > 0;
  const repetition = input.recentAuthorTexts.filter(
    (t) => t === normalized || (normalized.length > 12 && t.includes(normalized.slice(0, 24)))
  ).length;
  if (spamHits.length >= 1 || (hasUrl && /(free|win|bonus|promo|deal|sale)/.test(normalized)) || repetition >= 2) {
    return {
      category: "spam",
      score: 0.75,
      targetUserId: null,
      hasBlockedDomain,
      injectionAttempt,
      abstained: false,
      explanation: "Promotion/URL/repetition pattern consistent with spam; coordination not proven.",
    };
  }

  // Spoiler beta: deterministic template only.
  if (SPOILER_WORDS.some((w) => normalized.includes(w))) {
    return {
      category: "spoiler_suspected",
      score: 0.6,
      targetUserId: null,
      hasBlockedDomain,
      injectionAttempt,
      abstained: false,
      explanation: "Matches a spoiler template; uncertain without verified progress.",
    };
  }

  // Default: ordinary. Injection-looking text is STILL ordinary (or whatever
  // its content category is): the flag is recorded for tests, and the text is
  // never obeyed as an instruction.
  return {
    category: "ordinary",
    score: 0.95,
    targetUserId: null,
    hasBlockedDomain,
    injectionAttempt,
    abstained: false,
    explanation: injectionAttempt
      ? "Ordinary content that mimics an instruction; flagged and not obeyed."
      : "No policy pattern matched.",
  };
}
