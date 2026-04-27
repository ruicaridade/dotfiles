const REASONING_SUFFIX_RE = /(^|[-_.])(extra-high|xhigh|high|medium|low|none|thinking|reasoning|fast)$/i;

export function hasReasoningSuffix(id: string): boolean {
  return REASONING_SUFFIX_RE.test(id);
}

const FAMILY_LABELS: Array<[RegExp, string]> = [
  [/^claude/i, "Claude"],
  [/^gpt/i, "GPT"],
  [/^composer/i, "Composer"],
  [/^gemini/i, "Gemini"],
  [/^grok/i, "Grok"],
  [/^kimi/i, "Kimi"],
];

export function prettyCursorModelName(id: string): string {
  // Replace family prefix with cap label (claude → Claude), then title-case the rest.
  for (const [re, label] of FAMILY_LABELS) {
    if (re.test(id)) {
      const rest = id.replace(re, "");
      // Acronym families (GPT) keep a hyphen before the version number.
      const useHyphen = label === "GPT";
      return `${label}${prettify(rest, false, useHyphen)}`;
    }
  }
  return prettify(id, true);
}

function prettify(s: string, capFirst = false, hyphenFirst = false): string {
  // "-4.6-sonnet-extra-high" → " 4.6 Sonnet Extra High"
  const parts = s.split(/[-_]+/).filter(Boolean);
  const titled = parts.map((p, i) =>
    /^\d/.test(p) ? p : (i === 0 && !capFirst) ? p.charAt(0).toUpperCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1),
  );
  if (capFirst && titled.length) titled[0] = titled[0]!.charAt(0).toUpperCase() + titled[0]!.slice(1);
  if (!parts.length) return "";
  const head = hyphenFirst ? `-${titled[0]}` : ` ${titled[0]}`;
  const tail = titled.slice(1).join(" ");
  return tail ? `${head} ${tail}` : head;
}

export function resolveCursorModelName(id: string, displayName?: string | null): string {
  const trimmed = (displayName ?? "").trim();
  return trimmed || prettyCursorModelName(id);
}
