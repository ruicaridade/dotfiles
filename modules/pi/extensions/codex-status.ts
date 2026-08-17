import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_FILE = join(homedir(), ".codex", "auth.json");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

interface AuthJson {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

interface UsageWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
}

interface UsagePayload {
  plan_type: string;
  rate_limit?: {
    primary_window?: UsageWindow | null;
    secondary_window?: UsageWindow | null;
  } | null;
}

type StatusContext = ExtensionContext & {
  getThinkingLevel?: () => string;
  model?: {
    provider: string;
    id: string;
    name?: string;
    reasoning?: boolean;
  };
};

function isCodexModel(model: { provider: string; id: string } | undefined): boolean {
  if (!model) return false;
  const provider = model.provider.toLowerCase();
  const id = model.id.toLowerCase();
  return provider.includes("codex") || id.includes("codex");
}

function loadAuth(): { token: string; accountId: string } | null {
  try {
    const raw = readFileSync(AUTH_FILE, "utf-8");
    const data = JSON.parse(raw) as AuthJson;
    const token = data.tokens?.access_token;
    const accountId = data.tokens?.account_id;
    if (!token || !accountId) return null;
    return { token, accountId };
  } catch {
    return null;
  }
}

async function fetchUsage(auth: { token: string; accountId: string }): Promise<UsagePayload | null> {
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "ChatGPT-Account-ID": auth.accountId,
        "User-Agent": "codex_cli_rs/0.125.0",
        originator: "codex_cli_rs",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as UsagePayload;
  } catch {
    return null;
  }
}

function formatUsage(payload: UsagePayload): string {
  const p = payload.rate_limit?.primary_window;
  const s = payload.rate_limit?.secondary_window;
  const parts: string[] = [];
  if (p) parts.push(`5H ${Math.round(p.used_percent)}%`);
  if (s) parts.push(`W ${Math.round(s.used_percent)}%`);
  return parts.join(" ") || "-";
}

function formatReasoning(level: string): string {
  const labels: Record<string, string> = {
    minimal: " min",
    low: " low",
    medium: " med",
    high: " high",
    xhigh: " xhi",
  };
  return labels[level] ?? level;
}

function updateModelStatuses(ctx: StatusContext) {
  const model = ctx.model;
  const modelName = model?.name || model?.id || "";
  ctx.ui.setStatus("model-status", modelName);

  const level = ctx.getThinkingLevel?.() ?? "off";
  ctx.ui.setStatus("reasoning-status", level !== "off" ? formatReasoning(level) : "");
}

export default function (pi: ExtensionAPI) {
  let lastCtx: StatusContext | undefined;

  async function refreshCodexUsage() {
    const model = lastCtx?.model;
    if (!isCodexModel(model)) {
      lastCtx?.ui.setStatus("codex-status", "");
      return;
    }

    const auth = loadAuth();
    if (!auth) {
      lastCtx?.ui.setStatus("codex-status", "-");
      return;
    }

    lastCtx?.ui.setStatus("codex-status", "-");

    const payload = await fetchUsage(auth);
    if (!payload) {
      lastCtx?.ui.setStatus("codex-status", "-");
      return;
    }

    lastCtx?.ui.setStatus("codex-status", formatUsage(payload));
  }

  /** Fire-and-forget refresh so we never block the UI. */
  function refreshBg(ctx: ExtensionContext) {
    lastCtx = ctx as StatusContext;
    updateModelStatuses(lastCtx);
    void refreshCodexUsage();
  }

  pi.on("session_start", async (_event, ctx) => {
    refreshBg(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    refreshBg(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    refreshBg(ctx);
  });

  pi.on("session_shutdown", async () => {
    lastCtx = undefined;
  });
}
