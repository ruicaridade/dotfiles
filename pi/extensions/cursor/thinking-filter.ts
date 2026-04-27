const THINKING_TAG_NAMES = ["think", "thinking", "reasoning", "thought", "think_intent"];
const MAX_THINKING_TAG_LEN = 16;
const TAG_RE = new RegExp(`<(/?)(?:${THINKING_TAG_NAMES.join("|")})\\s*>`, "gi");

export interface ThinkingTagFilter {
  process(text: string): { content: string; reasoning: string };
  flush(): { content: string; reasoning: string };
}

export function createThinkingTagFilter(): ThinkingTagFilter {
  let buffer = "";
  let inThinking = false;

  return {
    process(text: string) {
      const input = buffer + text;
      buffer = "";
      let content = "";
      let reasoning = "";
      let lastIdx = 0;
      const re = new RegExp(TAG_RE.source, "gi");
      let match: RegExpExecArray | null;
      while ((match = re.exec(input)) !== null) {
        const before = input.slice(lastIdx, match.index);
        if (inThinking) reasoning += before;
        else content += before;
        inThinking = match[1] !== "/";
        lastIdx = re.lastIndex;
      }
      const rest = input.slice(lastIdx);
      const ltPos = rest.lastIndexOf("<");
      if (
        ltPos >= 0 &&
        rest.length - ltPos < MAX_THINKING_TAG_LEN &&
        /^<\/?[a-z_]*$/i.test(rest.slice(ltPos))
      ) {
        buffer = rest.slice(ltPos);
        const before = rest.slice(0, ltPos);
        if (inThinking) reasoning += before;
        else content += before;
      } else if (inThinking) {
        reasoning += rest;
      } else {
        content += rest;
      }
      return { content, reasoning };
    },

    flush() {
      const remaining = buffer;
      buffer = "";
      if (!remaining) return { content: "", reasoning: "" };
      return inThinking
        ? { content: "", reasoning: remaining }
        : { content: remaining, reasoning: "" };
    },
  };
}
