// ---------------------------------------------------------------------------
// display_seal.ts — THE DISPLAY SEAL
//
// SERVARI's UI shows only the PROFESSIONAL, OUTWARD face. Any internal-only
// vocabulary — code-names, project labels, working jargon — stays backend-only.
// This module maps any label derived from API data (agent names, role labels,
// stage names, status text, headers) onto neutral product words, and HIDES the
// terms that must never render at all.
//
// SCOPE: this seals CHROME — labels, headers, structural display text. The live
// chat CONTENT is EXEMPT — it is the real conversation, gated separately. Only
// the structural labels pass here.
//
// Configure the two arrays below for your deployment:
//   - DENYLIST   — terms that must never render (hidden entirely).
//   - DISPLAY_MAP — internal term -> the professional product word it shows as.
//
// Usage:
//   sealLabel("internal-codename")      -> ""   (denylisted — hidden)
//   sealLabel("wip · the registry")     -> "in progress · the registry"
//   sealLabel("p0 task")                -> "high priority task"
// ---------------------------------------------------------------------------

// DENYLIST — terms that must NEVER render on the display.
// If a label is ONLY a denylist term (or reduces to one), sealLabel hides it.
// These are matched case-insensitively as whole words.
//
// Replace these demo entries with the labels your deployment must hide.
export const DENYLIST: string[] = [
  "internal-codename",
  "internal codename",
  "secret-project",
  "secret project",
];

// DISPLAY_MAP — internal term -> professional product word. Applied as
// whole-word, case-insensitive replacement INSIDE a longer label (so a label
// like "wip in the registry" becomes "in progress in the registry" rather than
// being hidden wholesale). Order matters: longer/multi-word keys first so they
// win over their shorter substrings.
//
// Replace these demo entries with your deployment's term mapping.
export const DISPLAY_MAP: Record<string, string> = {
  // --- multi-word / compound (run first) ---
  "in flight": "in progress",

  // --- single-word internal jargon -> neutral product words ---
  wip: "in progress",
  p0: "high priority",
  p1: "medium priority",
  todo: "to do",
  blocked: "blocked",
};

// Build a single regex per key for whole-word, case-insensitive matching.
// Keys may contain hyphens/spaces; we escape regex metachars and bound with
// \b where the key edge is a word char (so "secret-project" still matches cleanly).
//
// `denyMode` widens the TRAILING boundary so a hyphen-suffixed extension of a
// denied word still trips the fail-closed denylist: with the MAP boundary a
// reference like "secret-project-42" would slip past the bare "secret-project"
// rule (the trailing "-" was treated as part of the same token), leaking the
// term into free-text fields. In deny mode the trailing lookahead drops "-" so
// "secret-project-42" matches the "secret-project" entry and the word is
// stripped. The leading boundary stays "(?<![\\w-])" so a denied word embedded
// mid-token (e.g. inside an already-mapped compound) is not double-handled.
// MAP_RULES keep the original boundary so compound replacements are unchanged.
function wordRe(key: string, denyMode = false): RegExp {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trailing = denyMode ? "(?![\\w])" : "(?![\\w-])";
  return new RegExp(`(?<![\\w-])${esc}${trailing}`, "gi");
}

// Pre-compile, longest-key-first so compound terms beat their substrings.
const MAP_RULES: { re: RegExp; replacement: string }[] = Object.keys(DISPLAY_MAP)
  .sort((a, b) => b.length - a.length)
  .map((key) => ({ re: wordRe(key), replacement: DISPLAY_MAP[key] }));

const DENY_RES: RegExp[] = DENYLIST.sort((a, b) => b.length - a.length).map((key) =>
  wordRe(key, true),
);

// Preserve a token's original casing class (UPPER / Title / lower) when
// substituting, so "WIP" -> "IN PROGRESS", "Wip" -> "In progress", "wip" -> "in progress".
function matchCase(sample: string, replacement: string): string {
  if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) {
    return replacement.toUpperCase();
  }
  if (sample[0] === sample[0]?.toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * sealLabel — map a display label to its professional, outward form.
 *
 * 1. Apply DISPLAY_MAP word-replacements (case-preserving).
 * 2. After mapping, if the residual label is empty OR still contains a pure
 *    denylist term that was NOT mapped, hide it (return "").
 *
 * The mapping in step 1 neutralizes most internal jargon; step 2 is the
 * fail-closed backstop for terms that have no professional equivalent — these
 * are hidden rather than re-labeled.
 */
export function sealLabel(text: string): string {
  if (text == null) return "";
  let out = String(text);

  // Step 1 — professional word-mapping (case-preserving).
  for (const rule of MAP_RULES) {
    out = out.replace(rule.re, (m) => matchCase(m, rule.replacement));
  }

  // Step 2 — fail-closed: any surviving denylist term hides the whole label
  // (these have no outward equivalent; they must never render).
  for (const re of DENY_RES) {
    if (re.test(out)) {
      // Strip the offending term; if what remains is just separators, hide all.
      const stripped = out.replace(re, "").replace(/\s*[·\-—|]\s*/g, " ").trim();
      out = stripped;
    }
  }

  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * sealHide — true when a label should not render AT ALL (a pure denied term).
 * Use for whole-row/section gating where an empty mapped label means "drop it".
 */
export function sealHide(text: string): boolean {
  return sealLabel(text).length === 0 && String(text ?? "").trim().length > 0;
}
