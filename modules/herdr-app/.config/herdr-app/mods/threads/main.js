// Threads: the whole sidebar, one inbox of cards in the style of T3 Code. A thread is a
// tab. In a worktree's space every tab is one, always; in any other space only tabs with
// an agent running are (the rest get no card). A
// card shows the space's project, what its agent is doing, its status, branch,
// uncommitted changes and agents. Hover a card to Settle it (tab.settle): it folds into
// the Settled accordion at the bottom and goes quiet. Clicking a settled thread
// unsettles it and shows it again. An agent in a settled tab that needs you brings it
// back by itself (Herdr's own rule).
//
// Sub-agents (terminals an agent started with `hc run`): a chip on the card's last row, one
// dot per sub-agent (the most urgent four, then +N); click it, or `o` on the card, to
// unfold all of them under the card. Click one (or Enter on it) to peek at it. A sub-agent
// waiting on you makes its card say Needs you.
//
// Settling stops the thread's agents (Ctrl+C twice, then SIGTERM; the pane's shell stays) and
// remembers how to bring each back (HARNESSES below): Claude Code and Copilot by their exact
// session id, the rest by their own "continue the latest session in this folder" flag. When the tab comes
// back from Settled, by any route, each one is started again in its shell, resuming its
// conversation. Kept in shared "threads.parked".
//
// Order: yours. Drag a card onto another to move it, or Pick it from its menu and move it
// with j/k. New threads (and ones coming back from Settled) go on top. Kept in shared
// "threads.order".
//
// Keys (keys.json): "threads.toggle" (alt-a) gives the list the keyboard: j/k or ↓/↑ move
// the cursor, g/G first/last, l/Enter open, h/Esc go back to the pane, s settles or
// unsettles, m opens the card's menu (j/k, Enter, Esc; right-click opens it too). Pick
// in the menu: j/k move the thread, Esc/Enter/m drop it. o folds or unfolds a card's
// sub-agents; j/k step through them too, Enter peeks at one. "threads.slot1".."slot9" show
// the nth card; "threads.settle" settles the shown thread and moves to the next one.
// New threads come from the thread-new dialog (ctrl-shift-n).
//
// Spaces: a compact list above the threads, of every space that isn't a worktree (your
// projects' main folders). Click one (or Enter) to show it. In these spaces a thread is one
// agent: each tab or split running one gets its own card, and it's gone when that agent
// exits or its pane closes. Settling one stops just that agent (no Settled entry, nothing
// to resume). "threads.spaces" (alt-f) gives the list the keyboard: j/k, g/G, l/Enter show,
// n new thread there, t new terminal tab, m menu (Pick, New thread, New terminal, Rename,
// Remove), Tab to the threads. Reorder by dragging, or Pick + j/k. Kept in shared
// "threads.spaceOrder". Remove closes the space (Herdr asks first if anything runs) and, once
// it's gone, drops its repo from the New thread dialog's projects.
//
// Cleanup: a worktree space (under ~/.herdr/worktrees, this computer) whose tabs have all
// been settled for 7 days, with no agent working or waiting, has its checkout removed
// (`git worktree remove`, never forced) and its space closed. Its branch is left alone. One
// with uncommitted or untracked changes, or that git won't remove, is kept and named in
// the notification (once per reason). It runs 20 s after start and then hourly.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, Popup } from "gpui-base";
import { spaces, agents, terminals, panes, focused, run, exec, hc, readTextFile, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, nextCommand, notify, home, checking } from "herdr";

const I = (name) => "mods/workspace-chrome/" + name + ".svg";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 303) : window()?.platform === "macos" ? 76 : 44 });
}

// Project avatars: two letters on a tint of one stable color per project name
// (the same functions are in thread-new).
const MARK = ["#22a99a", "#e3814f", "#5b8def", "#8b7cf6", "#3fae6a", "#d9649a", "#d4a72c", "#e05d5d"];
const colorOf = (name) => MARK[Math.abs([...name].reduce((h, c) => (h * 31 + c.codePointAt(0)) | 0, 7)) % MARK.length];
function initials(name) {
  const words = name.split(/[-_ ./]+/).filter(Boolean);
  if (!words.length) return name.slice(0, 1) || "?";
  return (words.length > 1 ? words[0][0] + words.at(-1)[0] : words[0].slice(0, 2)).toUpperCase();
}
function avatar(name, size = 18) {
  const c = colorOf(name);
  return h_flex().size(size).flex_none().rounded(4).bg(c + "2e").items_center().justify_center()
    .text_size(size * 0.5).font_bold().text_color(c).child(initials(name));
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || "";
}
// Where a thread's git is asked: its lead agent's live folder, else its space's.
const keyOf = (s, lead, ps) => JSON.stringify([s.machine ?? null, lead?.cwd || place(s, ps)]);

// Every tab: { s, tab, agents (most urgent first), lead (the first agent's pane, else the
// tab's first terminal) }. Which become threads is decided once git says which are worktrees.
function agentTabs(list, ags, ps) {
  const paneOf = new Map(ps.map((p) => [p.pane, p]));
  const byTab = new Map();
  for (const a of ags) {
    if (!byTab.has(a.tab)) byTab.set(a.tab, []);
    byTab.get(a.tab).push(a);
  }
  const out = [];
  for (const s of list) for (const tab of s.tabs) {
    const mine = byTab.get(tab.id) ?? [];
    mine.sort((x, y) => (RANK[y.status] ?? 0) - (RANK[x.status] ?? 0) || y.seq - x.seq);
    const lead = mine.length ? paneOf.get(mine[0].pane) : ps.find((p) => p.tab === tab.id && p.terminal);
    out.push({ s, tab, agents: mine, lead: lead ?? null });
  }
  return out;
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// What an agent's terminal title says, when it says something (Claude Code puts its
// task summary there); not its program's name, a path or user@host.
function telling(a) {
  const live = clean(a.title);
  const prog = a.program?.name;
  const path = /^[~/]|^[A-Za-z]:\\/.test((a.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  return live && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== a.program?.key ? live : null;
}

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  const d = Math.floor(h / 24);
  return d < 60 ? d + "d" : Math.floor(d / 30) + "mo";
}
function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

// The program's icon: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

const ACTIVITY = "activity";
const SUB_CHANGED = "subChanged"; // sub-agent address -> { s, at }: when its state last changed
const MAX_DOTS = 4;
// A sub-agent's state: what agents() says if it has a pane, else its raw word; error counts as
// blocked, and done as idle (it reports to its parent; the parent's done is the news).
const subStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : RANK[s] ? s : "idle";
};
const ORDER = "threads.order";
const SPACE_ORDER = "threads.spaceOrder";
const PROJECTS = "threads.projects";
// Where a space's own git is asked: where its first terminal is now (as Herdr names it; its
// `folder` is only where new terminals start, often inherited from another space).
const spaceKey = (s, ps = PANES) => JSON.stringify([s.machine ?? null, place(s, ps)]);
// How each harness resumes. Tested by stopping and resuming a real session (2026-11-24):
// claude, codex, copilot, opencode, omp, grok, agy. Not testable here (no login or model):
// pi and kimi (flags from --help, cwd-scoped), cursor-agent, crush, kiro, gemini, amp (amp
// restarts its command: it has no non-interactive "continue last").
const HARNESSES = [
  { name: "claude", match: /^claude/, resume: (bin, id) => (id ? [bin, "--resume", id] : [bin, "--continue"]) },
  { name: "codex", match: /^codex/, resume: (bin) => [bin, "resume", "--last"] },
  { name: "copilot", match: /^copilot/, resume: (bin, id) => (id ? [bin, "--resume=" + id] : [bin, "--continue"]) },
  { name: "opencode", match: /^opencode/, resume: (bin) => [bin, "--continue"] },
  { name: "omp", match: /^omp$/, resume: (bin) => [bin, "--continue"] },
  { name: "pi", match: /^pi$/, resume: (bin) => [bin, "--continue"] },
  { name: "grok", match: /^grok/, resume: (bin) => [bin, "--continue"] },
  { name: "agy", match: /^(agy|antigravity)$/, resume: (bin) => [bin, "--continue"] },
  { name: "kimi", match: /^kimi/, bin: "kimi", resume: (bin) => [bin, "--continue"] },
  { name: "cursor", match: /^(cursor-agent|agent)$/, resume: (bin) => [bin, "--continue"] },
  { name: "crush", match: /^crush/, resume: (bin) => [bin, "--continue"] },
  { name: "kiro", match: /^kiro/, resume: (bin) => [bin, "chat", "--resume"] },
  { name: "gemini", match: /^gemini/, resume: (bin) => [bin, "--resume", "latest"] },
  { name: "amp", match: /^amp/ },
];
const PARKED = "threads.parked";
// The panes of a tab, from the snapshot render takes (see render: this.panesNow).
let PANES = [];
const panesInTab = (tab) => PANES.filter((p) => p.tab === tab); // tab id -> { space, title, agents: [{ shell, argv, program }] }
const quote = (s) => (/^[A-Za-z0-9_\/.:=@%+-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'");
const CLEAN_AFTER = 7 * 86400000;
const WARNED = "cleanup.warned"; // path -> the reason it was last kept, so it's said once

// When a space's last tab was settled, if all of them are; else null.
const settledSince = (s) => (s.tabs.length && s.tabs.every((tb) => tb.settled && tb.settled_at) ? Math.max(...s.tabs.map((tb) => tb.settled_at)) : null);
const GIT_EVERY = 30000;
const CMD = "threads.command"; // the last key command: { c, id }

export default class Threads extends View {
  init(_props, cx) {
    this.git = {}; // keyOf -> { project, top, main, linked, changes } | null (not git)
    this.asked = {}; // keyOf -> when git was last asked
    this.inflight = new Set();
    this.wasWorking = new Set(); // spaces working at the last look
    // When each space last changed state (ms), kept across restarts: the inbox order.
    this.activity = JSON.parse(localStorage.getItem(ACTIVITY) ?? "{}");
    this.lastStatus = {};
    this.known = new Set([...spaces().flatMap((s) => s.tabs.map((tb) => tb.id)), ...panes().map((p) => "pn:" + p.pane)]);
    this.since = {}; // agent thread -> when it started working (tabs have working_since)
    this.openSettled = Boolean(shared("threads.settledOpen"));
    this.hovered = null;
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.cursor = null;
    this.back = null;
    this.nav = [];
    this.order = []; // the active threads as last drawn
    this.rows = []; // every thread as last drawn
    this.menu = null; // { id, at }: the menu open on that thread
    this.picking = null; // the thread being moved with j/k
    this.toPark = []; // threads just settled, whose agents are stopped on the next poll
    this.toStop = []; // agent threads (in a non-worktree space) just settled: stop that agent
    this.stopping = new Set(); // their ids, hidden while they stop
    this.zone = "threads"; // which list has the keyboard: "spaces" or "threads"
    this.spCursor = null;
    this.spNav = []; // space ids as last drawn
    this.spPicking = null;
    this.spPressed = null;
    this.spOver = null;
    this.spacesOpen = shared("threads.spacesOpen") ?? true;
    this.removing = null; // { id, project }: a space being removed, to drop its project once gone
    this.shownId = null;
    this.cxTimer = (ms, fn) => cx.timer.after(ms, (c2) => fn(c2));
    this.parking = new Set();
    this.unfolded = new Set(JSON.parse(localStorage.getItem("unfolded") ?? "[]")); // threads showing their sub-agents
    this.subChanged = JSON.parse(localStorage.getItem(SUB_CHANGED) ?? "{}");
    this.pressed = null; // the card a drag started on
    this.over = null; // the card it's over
    cx.timer.every(1000, (cx) => { if (spaces().some((s) => s.status === "working")) cx.notify(); });
    cx.timer.every(30000, (cx) => cx.notify());
    cx.timer.every(1500, (cx) => this.poll(cx));
    if (!checking()) {
      cx.timer.after(20000, (cx) => this.cleanup(cx));
      cx.timer.every(3600000, (cx) => this.cleanup(cx));
    }
    // Key commands go through shared state: Herdr may hand one to a copy of this mod that
    // doesn't draw (one a hot reload left behind), so whichever copy gets it posts it, and
    // the copy that draws runs it.
    this.lastCmd = shared(CMD)?.id ?? null;
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        setShared(CMD, { c, id: Date.now() + "-" + Math.random().toString(36).slice(2, 8) });
      }
    });
  }

  command(c) {
    if (c === "toggle") this.toggle("threads");
    else if (c === "spaces") this.toggle("spaces");
    else if (c === "settle") this.settleShown();
    // "settle-<terminal>": settle the thread that terminal leads (for scripts).
    else if (c.startsWith("settle-")) { const th = this.order.find((x) => x.lead?.terminal === c.slice(7)); if (th) this.settle(th); }
    else if (c === "subs") { const th = this.order.find((x) => x.id === this.shownId); if (th?.subs.length) this.fold(th.id); }
    else if (/^slot[1-9]$/.test(c)) { const th = this.order[Number(c.slice(4)) - 1]; if (th) this.open(th); }
  }

  // ---- git, per place: project name, linked worktree, uncommitted changes ----

  poll(cx) {
    this.parkAndResume(cx);
    const ps = panes();
    const now = Date.now();
    const front = window()?.active;
    const list = spaces();
    // Each space's own folder: is it a worktree (its tabs are threads) or a project's main one.
    for (const s of list) {
      const k = spaceKey(s, ps);
      const at = JSON.parse(k)[1];
      if (at && !(k in this.asked) && !this.inflight.has(k)) this.ask(k, s.machine ?? null, at, cx);
    }
    if (this.removing && list.length && !list.some((s) => s.id === this.removing.id)) {
      const gone = this.removing.project;
      this.removing = null;
      if (gone) setShared(PROJECTS, (shared(PROJECTS) ?? []).filter((p) => !(p.path === gone.path && (p.machine ?? null) === gone.machine)));
    }
    for (const u of this.units(list, agents(), ps)) {
      const { s, tab, lead } = u;
      const key = keyOf(s, lead, ps);
      if (!JSON.parse(key)[1]) continue;
      const working = this.statusOf(u) === "working";
      // An agent's turn just ended: its edits and commits change the counts.
      const ended = this.wasWorking.has(u.id) && !working;
      if (working) this.wasWorking.add(u.id); else this.wasWorking.delete(u.id);
      const due = !(key in this.asked) || ended || (front && !tab.settled && now - this.asked[key] > GIT_EVERY);
      if (due && !this.inflight.has(key)) this.ask(key, s.machine ?? null, JSON.parse(key)[1], cx);
    }
  }

  ask(key, on, cwd, cx) {
    this.inflight.add(key);
    this.asked[key] = Date.now();
    cx.spawn(async (cx) => {
      try {
        const known = this.git[key];
        let info = known ? { ...known } : null;
        if (!known) {
          const r = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd, on, timeout: 5000 });
          if (r.code === 0) {
            const [top, common] = r.stdout.trim().split("\n");
            const main = common.replace(/\/$/, "").replace(/\/\.git$/, "");
            info = { top, main, linked: main !== top, project: main.split("/").pop().replace(/\.git$/, ""), changes: 0 };
          }
        }
        if (info) {
          const st = await exec("git", ["--no-optional-locks", "status", "--porcelain"], { cwd: info.top, on, timeout: 8000 });
          if (st.code === 0) info.changes = st.stdout.split("\n").filter(Boolean).length;
        }
        this.git[key] = info;
      } catch {
        if (!(key in this.git)) this.git[key] = null; // gone folder or an away machine
      }
      this.inflight.delete(key);
      cx.notify();
    });
  }

  // ---- cleanup of long-settled worktrees ----

  cleanup(cx) {
    if (this.cleaning) return;
    this.cleaning = true;
    cx.spawn(async (cx) => {
      const removed = [], kept = [];
      const warned = JSON.parse(localStorage.getItem(WARNED) ?? "{}");
      const root = home() + "/.herdr/worktrees/";
      const git = async (cwd, args, timeout = 10000) => {
        const r = await exec("git", args, { cwd, timeout });
        return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
      };
      try {
        const now = Date.now();
        const ags = agents();
        for (const s of spaces()) {
          const since = settledSince(s);
          if (s.machine || !since || now - since < CLEAN_AFTER) continue;
          if (ags.some((a) => a.space === s.id && (a.status === "working" || a.status === "blocked"))) continue;
          if (!(s.folder ?? "").startsWith(root)) continue;
          let top, main;
          try {
            const r = await git(s.folder, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], 5000);
            if (!r.ok) continue; // a deleted folder: nothing to remove
            [top, main] = r.out.split("\n");
            main = main.replace(/\/$/, "").replace(/\/\.git$/, "");
          } catch { continue; }
          if (main === top || !top.startsWith(root)) continue; // only linked worktrees
          const name = top.slice(root.length);
          const keep = (why) => {
            if (warned[top] !== why) kept.push(name + " (" + why + ")");
            warned[top] = why;
          };
          const st = await git(top, ["--no-optional-locks", "status", "--porcelain"]);
          if (!st.ok) { keep("git status failed"); continue; }
          if (st.out) { keep("uncommitted changes"); continue; }
          // Still settled and idle right now (it may have come back while git ran).
          const fresh = spaces().find((x) => x.id === s.id);
          if (!fresh || settledSince(fresh) !== since || agents().some((a) => a.space === s.id && (a.status === "working" || a.status === "blocked"))) continue;
          const rm = await git(main, ["worktree", "remove", top], 120000);
          if (!rm.ok) { keep(rm.err.split("\n")[0].replace(/^fatal: /, "") || "git worktree remove failed"); continue; }
          run("space.close", { id: s.id, confirmed: true });
          delete warned[top];
          removed.push(name);
        }
      } catch (e) {
        console.log("threads cleanup:", String(e));
      }
      localStorage.setItem(WARNED, JSON.stringify(warned));
      this.cleaning = false;
      if (removed.length || kept.length) {
        const lines = [];
        if (removed.length) lines.push("Removed: " + removed.join(", ") + ". Branches kept.");
        if (kept.length) lines.push("Kept: " + kept.join(", ") + ".");
        notify({
          title: removed.length ? "Removed " + removed.length + " settled " + (removed.length === 1 ? "worktree" : "worktrees") : "Settled worktrees kept",
          body: lines.join("\n"),
          level: kept.length ? "warning" : "info",
          timeout: 15000,
        });
      }
      cx.notify();
    });
  }

  // ---- sub-agents ----

  // Live terminals by parent, and when each sub-agent's state last changed.
  readSubs(now) {
    const all = terminals().filter((x) => x.state === "live");
    this.listed = new Map(agents().map((a) => [a.address, a.status]));
    this.parentOf = new Map(all.map((x) => [x.address, x.parent]));
    this.kids = new Map();
    for (const x of all) if (x.parent) {
      if (!this.kids.has(x.parent)) this.kids.set(x.parent, []);
      this.kids.get(x.parent).push(x);
    }
    let dirty = false;
    for (const x of all) if (x.parent) {
      const s = subStatus(x, this.listed);
      if (this.subChanged[x.address]?.s !== s) { this.subChanged[x.address] = { s, at: now }; dirty = true; }
    }
    if (!dirty) return;
    const live = new Set(all.map((x) => x.address));
    for (const k of Object.keys(this.subChanged)) if (!live.has(k) && all.length) delete this.subChanged[k];
    localStorage.setItem(SUB_CHANGED, JSON.stringify(this.subChanged));
  }

  fold(id) {
    this.unfolded.has(id) ? this.unfolded.delete(id) : this.unfolded.add(id);
    localStorage.setItem("unfolded", JSON.stringify([...this.unfolded]));
  }

  // The chip: the most urgent few dots, then +N.
  subChip(t, th) {
    const open = this.unfolded.has(th.id);
    const top = [...th.subs].sort((x, y) => (RANK[y.status] ?? 0) - (RANK[x.status] ?? 0)).slice(0, MAX_DOTS);
    const more = th.subs.length - top.length;
    return h_flex().id("sub-chip-" + th.id).flex_none().gap(4).px(5).h(18).rounded(5).items_center().bg(t.hover).cursor_pointer()
      .tooltip(th.subs.length + (th.subs.length === 1 ? " sub-agent" : " sub-agents") + (open ? " · fold" : " · unfold"))
      .hover((el) => el.bg(t.selected))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.fold(th.id); cx.notify(); })
      .child(svg(I("layers")).size(11).text_color(t.muted))
      .children(top.map((x) => this.subDot(t, x.status, 5)))
      .when(more > 0, (el) => el.child(div().text_size(10.5).text_color(t.muted).child("+" + more)))
      .child(svg(I(open ? "chevron-down" : "chevron-right")).size(10).text_color(t.dim));
  }

  subDot(t, st, size = 7) {
    if (st === "working") return svg(I("spinner")).size(size + 4).flex_none().text_color(t.working).spin(900);
    if (st === "idle") return div().size(size).flex_none().rounded(size).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(size).flex_none().rounded(size).bg(t[st] ?? t.dim);
  }

  subList(t, th, now) {
    return v_flex().mt(4).pt(4).border_t(1).border_color(t.border)
      .children(th.subs.map((x) => {
        const k = x.k;
        const on = this.cursor === "sub:" + k.address && this.handle.is_focused() && this.zone === "threads";
        const at = this.subChanged[k.address]?.at;
        return h_flex().id("sub-" + k.address).h(24).pl(2 + x.depth * 12).pr(2).gap(7).items_center().rounded(5).text_size(12)
          .border_1().border_color(on ? t.accent : "#00000000")
          .hover((el) => el.bg(t.hover)).cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.peek(k.address); })
          .child(h_flex().w(12).flex_none().justify_center().child(this.subDot(t, x.status)))
          .child(div().flex_1().min_w(0).truncate().text_color(x.status === "blocked" ? t.foreground : t.muted)
            .child(k.name || k.template || k.program?.name || k.agent || k.address))
          .when(Boolean(at), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(x.status === "working" ? elapsed(now - at) : ago(now - at))));
      }));
  }

  peek(address) {
    if (this.listed.has(address)) run("pane.focus", { terminal: address });
    else run("terminal.peek", { terminal: address });
  }

  // ---- stopping agents on settle, resuming them when the thread is back ----

  parkAndResume(cx) {
    for (const th of this.toStop.splice(0)) {
      cx.spawn(async (cx) => {
        let ok = false;
        try { ok = await this.stopAgent(th); } catch (e) { console.log("threads stop:", String(e)); }
        // Gone: give agents() a moment to drop it before showing what's left. Not gone: show it again.
        this.cxTimer(ok ? 2500 : 0, () => { this.stopping.delete(th.id); cx.notify(); });
        if (!ok) notify({ title: "Couldn't stop " + th.title, body: "It's still running.", level: "warning", timeout: 6000 });
      });
    }
    for (const th of this.toPark.splice(0)) {
      if (this.parking.has(th.id)) continue;
      this.parking.add(th.id);
      cx.spawn(async (cx) => {
        try { await this.park(th); } catch (e) { console.log("threads park:", String(e)); }
        this.parking.delete(th.id);
        cx.notify();
      });
    }
    const parked = shared(PARKED) ?? {};
    const tabs = new Map(spaces().flatMap((s) => s.tabs.map((tb) => [tb.id, { s, tb }])));
    let changed = false;
    const next = { ...parked };
    for (const [id, rec] of Object.entries(parked)) {
      const at = tabs.get(id);
      if (!at && tabs.size) { delete next[id]; changed = true; continue; } // the tab is gone
      if (at && !at.tb.settled && !this.parking.has(id)) {
        delete next[id];
        changed = true;
        cx.spawn(async () => { try { await this.resume(at.s, at.tb, rec); } catch (e) { console.log("threads resume:", String(e)); } });
      }
    }
    if (changed) setShared(PARKED, next);
  }

  // The harness a terminal runs, from its launch command (Herdr starts agents as
  // `bash -ic '"$@"; exec "$0" -i' bash <cmd...>`; Kimi renames its process, so the launch
  // command is the truer name), else its foreground program.
  harnessOf(info) {
    const a = info.argv ?? [];
    const launched = a.length > 4 && /"\$@"/.test(a[2] ?? "") ? a.slice(4) : null;
    const cmd = launched ?? info.foreground?.argv ?? [];
    const base = (cmd[0] ?? "").split("/").pop();
    const h = HARNESSES.find((x) => x.match.test(base)) ?? HARNESSES.find((x) => x.match.test((info.foreground?.argv?.[0] ?? "").split("/").pop()));
    return h ? { h, bin: launched ? cmd[0] : (h.bin ?? info.foreground.argv[0]), cmd } : null;
  }

  // The exact session to resume, where the harness says which one this process has.
  async sessionId(h, pid, on) {
    if (h.name === "claude" && !on) {
      try { return JSON.parse(await readTextFile(home() + "/.claude/sessions/" + pid + ".json"))?.sessionId ?? null; } catch { return null; }
    }
    if (h.name === "copilot") {
      try {
        const r = await exec("sh", ["-c", "ls -l /proc/" + pid + "/fd 2>/dev/null"], { on, timeout: 5000 });
        return r.stdout.match(/session-state\/([0-9a-f-]{36})\//)?.[1] ?? null;
      } catch { return null; }
    }
    return null;
  }

  // Stop an agent the way a person would (Ctrl+C twice), then SIGTERM if it's still there.
  // True if it's gone; `hard` when it took a signal (its terminal modes may be left set).
  async stop(address, fgPid, on) {
    const fgOf = async () => { try { return JSON.parse((await hc(["get", address, "--json"])).stdout).foreground?.pid; } catch { return null; } };
    const wait = async (ms) => { for (let t = 0; t < ms; t += 250) { await new Promise((r) => this.cxTimer(250, r)); if ((await fgOf()) !== fgPid) return true; } return false; };
    await hc(["keys", address, "ctrl+c"]);
    await new Promise((r) => this.cxTimer(400, r));
    await hc(["keys", address, "ctrl+c"]);
    if (await wait(4000)) return { gone: true, hard: false };
    await exec("kill", ["-TERM", String(fgPid)], { on, timeout: 5000 }).catch(() => null);
    if (await wait(3000)) return { gone: true, hard: true };
    return { gone: false };
  }

  // An agent thread in a project's main space: stop just that agent, nothing to resume.
  async stopAgent(th) {
    const address = th.lead?.terminal;
    if (!address) return false;
    let info;
    try { info = JSON.parse((await hc(["get", address, "--json"])).stdout); } catch { return true; } // already gone
    const fg = info.foreground;
    if (!fg?.pid) return true;
    const on = th.s.machine ?? null;
    const stopped = await this.stop(address, fg.pid, on);
    // A signalled TUI can leave mouse or keyboard modes on in the shell it returns to.
    if (stopped.gone && stopped.hard && fg.pid !== info.pid) await hc(["send", address, "reset"]).catch(() => null);
    return stopped.gone;
  }

  // Stop the thread's agents, keeping their shells, and remember how to resume them.
  async park(th) {
    const on = th.s.machine ?? null;
    const out = [];
    // Every terminal of the tab running a known harness, whether or not it reports a status.
    const terms = panes().filter((p) => p.tab === th.id && p.terminal).map((p) => p.terminal);
    for (const address of terms) {
      let info;
      try { info = JSON.parse((await hc(["get", address, "--json"])).stdout); } catch { continue; }
      const fg = info.foreground;
      // Only an agent running under the pane's shell: one that is the terminal's own program
      // would take its pane (and maybe the tab) with it, so that one keeps running.
      if (!fg?.pid || fg.pid === info.pid) continue;
      const found = this.harnessOf(info);
      if (!found) continue;
      const id = await this.sessionId(found.h, fg.pid, on);
      const argv = found.h.resume ? found.h.resume(found.bin, id) : found.cmd;
      const stopped = await this.stop(address, fg.pid, on);
      if (!stopped.gone) continue;
      const a = th.agents.find((x) => x.address === address);
      out.push({ shell: address, cwd: fg.cwd ?? null, argv, reset: stopped.hard, harness: found.h.name,
        program: a?.program ? { key: a.program.key, name: a.program.name, icon: a.program.icon, tint: a.program.tint } : null });
    }
    if (!out.length) return;
    const title = /^t[0-9a-z]+$/.test(th.title) ? (out[0].program?.name ?? th.title) : th.title;
    setShared(PARKED, { ...(shared(PARKED) ?? {}), [th.id]: { space: th.s.id, title, agents: out } });
  }

  // Start each parked agent again in its shell (or, if that shell is gone, in a new tab).
  async resume(s, tab, rec) {
    const live = new Map(terminals().map((x) => [x.address, x]));
    for (const a of rec.agents) {
      // A signalled TUI can leave mouse or keyboard modes on: reset the terminal first.
      const cmd = (a.reset ? "reset; " : "") + a.argv.map(quote).join(" ");
      if (live.get(a.shell)?.state === "live") await hc(["send", a.shell, cmd]);
      else run("tab.new", { space: s.id, ...(a.cwd ? { folder: a.cwd } : {}), argv: a.argv });
    }
  }

  // ---- what a thread is ----

  // Stamps threads (tabs) whose state changed; a new one counts as activity.
  track(rows, now) {
    let dirty = false;
    for (const u of rows) {
      const { tab, id } = u;
      const raw = this.statusOf(u);
      const st = raw === "done" ? "idle" : raw ?? "none";
      const born = !this.known.has(id);
      if (born) this.known.add(id);
      if (this.lastStatus[id] === st && !born) continue;
      const first = !(id in this.lastStatus);
      this.lastStatus[id] = st;
      if (st === "working") this.since[id] = first && u.unit === "agent" ? (tab.working_since ?? now) : now;
      // At start the last-known state isn't news: keep the stored time.
      if (first && !born && this.activity[id]) continue;
      const changed = u.unit === "tab" ? Math.max(tab.changed_at ?? 0, tab.working_since ?? 0) : (tab.changed_at ?? 0);
      this.activity[id] = born || !first ? now : Math.max(this.activity[id] ?? 0, changed);
      dirty = true;
    }
    if (!dirty) return;
    // Forget tabs and panes that are gone (all of them, not just those without an agent now).
    const ids = new Set([...spaces().flatMap((s) => s.tabs.map((tb) => tb.id)), ...panes().map((p) => "pn:" + p.pane)]);
    for (const id of Object.keys(this.activity)) if (!ids.has(id) && ids.size) delete this.activity[id];
    localStorage.setItem(ACTIVITY, JSON.stringify(this.activity));
  }

  // A space made in a linked worktree (git says so; until it has, its path does).
  isWorktree(s) {
    const k = spaceKey(s);
    const g = this.git[k];
    return g ? g.linked : /\/worktrees\/[^/]+\/[^/]+\/?$/.test(JSON.parse(k)[1]);
  }

  // The threads: in a worktree's space every tab, always (unit "tab", settled to the
  // Settled list); in any other space each pane running an agent (unit "agent").
  units(list, ags, ps) {
    const parked = shared(PARKED) ?? {};
    const out = [];
    for (const r of agentTabs(list, ags, ps)) {
      if (this.isWorktree(r.s) || parked[r.tab.id]) { out.push({ ...r, id: r.tab.id, unit: "tab" }); continue; }
      const mine = new Set(r.agents.map((a) => a.address));
      const seen = new Set();
      for (const a of r.agents) {
        seen.add(a.pane);
        // A sub-agent kept in a pane of this tab shows under its parent's card instead.
        if (mine.has(this.parentOf?.get(a.address))) continue;
        out.push({ s: r.s, tab: r.tab, agents: [a], lead: ps.find((p) => p.pane === a.pane) ?? null, id: "pn:" + a.pane, unit: "agent" });
      }
      // Harnesses that report no status (agy) still name their program on the pane.
      for (const p of ps) if (p.tab === r.tab.id && p.terminal && p.program?.agent && !seen.has(p.pane))
        out.push({ s: r.s, tab: r.tab, agents: [], lead: p, id: "pn:" + p.pane, unit: "agent" });
    }
    return out.filter((u) => !this.stopping.has(u.id));
  }

  statusOf(u) {
    return u.unit === "tab" ? u.tab.status : (u.agents[0]?.status ?? null);
  }

  thread(u, ps) {
    const { s, tab, agents: mine, lead, unit } = u;
    const key = keyOf(s, lead, ps);
    const g = this.git[key];
    const said = mine.map(telling).find(Boolean);
    const name = s.name.replace(/ \(deleted\)$/, "");
    const rec = (shared(PARKED) ?? {})[tab.id];
    const own = unit === "agent" ? [lead].filter(Boolean) : panesInTab(tab.id);
    const quiet = own.find((p) => p?.program?.agent);
    const title = said || (unit === "agent" ? lead?.name : null) || (tab.named ? tab.name : null) || rec?.title || mine[0]?.program?.name || quiet?.program?.name || (s.tabs.length > 1 ? name + " · " + tab.name : name);
    // Git can't answer for a deleted worktree: its path (…/worktrees/<repo>/<name>) still can.
    const fromPath = (s.folder ?? "").match(/\/worktrees\/([^/]+)\/[^/]+\/?$/)?.[1];
    const project = g?.project || fromPath || (g === undefined ? "" : name);
    // Sub-agents: live descendants of this tab's agents, depth first, with their depth.
    // A kept one (with a pane in this tab) is a sub-agent here, not a second agent.
    const mineSet = new Set(mine.map((a) => a.address));
    const roots = mine.filter((a) => !mineSet.has(this.parentOf.get(a.address)));
    const subs = [];
    const walk = (addr, depth) => {
      for (const k of this.kids.get(addr) ?? []) {
        subs.push({ k, depth, status: subStatus(k, this.listed) });
        walk(k.address, depth + 1);
      }
    };
    for (const a of roots) walk(a.address, 0);
    const programs = [];
    for (const a of roots) if (a.program?.icon && !programs.some((p) => p.key === a.program.key)) programs.push(a.program);
    // Harnesses that report no status (agy) still name their program on the pane.
    for (const p of own) if (p.program?.agent && p.program.icon && !programs.some((x) => x.key === p.program.key)) programs.push(p.program);
    // A settled thread's stopped agents still show what they were.
    for (const a of rec?.agents ?? []) if (a.program?.icon && !programs.some((p) => p.key === a.program.key)) programs.push(a.program);
    // The card speaks for its most urgent agent or sub-agent.
    const own0 = this.statusOf(u);
    const status = [own0, ...subs.map((x) => x.status)].reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), own0);
    return { id: u.id, unit, subs, s, tab, key, g, title, project, branch: lead?.branch ?? s.branch ?? null,
      // A worktree's own space name says which checkout; a main checkout's adds nothing.
      place: g?.linked ? name : null,
      status, since: unit === "agent" ? (this.since[u.id] ?? null) : (tab.working_since ?? null), programs, agents: mine, lead,
      settled: unit === "tab" && tab.settled, settledAt: tab.settled_at ?? 0, at: this.activity[tab.id] ?? 0 };
  }

  // ---- actions ----

  open(th) {
    if (th.tab.settled) run("tab.unsettle", { id: th.tab.id });
    if (th.lead) run("pane.focus", { pane: th.lead.pane });
    else { run("space.select", { id: th.s.id }); run("tab.select", { id: th.tab.id }); }
  }

  settle(th) {
    // Settling the shown thread moves on to the next one, as an inbox does.
    if (this.shownId === th.id) {
      const at = this.order.findIndex((x) => x.id === th.id);
      const next = this.order[at + 1] ?? this.order[at - 1];
      if (next) this.open(next);
    }
    if (th.unit === "agent") {
      // Not a worktree: stop just this agent; its card goes when it does.
      this.stopping.add(th.id);
      this.toStop.push(th);
    } else {
      run("tab.settle", { id: th.id });
      this.toPark.push(th);
    }
    if (this.hovered === th.id) this.hovered = null;
  }

  settleShown() {
    const th = this.order.find((x) => x.id === this.shownId);
    if (th) this.settle(th);
  }

  // alt-a (threads) / alt-f (spaces): give that list the keyboard, or take it back.
  toggle(zone) {
    const on = this.handle.is_focused();
    if (on && this.zone === zone) return this.leave();
    this.menu = null;
    this.picking = null;
    this.spPicking = null;
    if (!on) this.back = focused()?.pane ?? null;
    this.zone = zone;
    if (zone === "spaces") {
      this.spacesOpen = true;
      const at = spaces().find((s) => s.active)?.id;
      if (!this.spNav.includes(this.spCursor)) this.spCursor = this.spNav.includes(at) ? at : this.spNav[0] ?? null;
    } else {
      this.cursor = this.nav.includes(this.shownId) ? this.shownId : this.nav[0] ?? null;
    }
    this.handle.focus();
  }

  leave() {
    const back = this.back;
    this.back = null;
    this.cursor = null;
    this.spCursor = null;
    this.menu = null;
    this.picking = null;
    this.spPicking = null;
    if (back && panes().some((p) => p.pane === back)) run("pane.focus", { pane: back });
  }

  // Move a thread `by` places, or to `to`'s place.
  moveThread(id, { by, to }) {
    const order = this.order.map((th) => th.id);
    const from = order.indexOf(id);
    if (from < 0) return false;
    const at = to !== undefined ? order.indexOf(to) : Math.max(0, Math.min(order.length - 1, from + by));
    if (at < 0 || at === from) return false;
    order.splice(at, 0, order.splice(from, 1)[0]);
    this.order = order.map((x) => this.order.find((th) => th.id === x));
    setShared(ORDER, order);
    return true;
  }

  reveal() {
    const id = String(this.cursor ?? "").startsWith("sub:") ? this.rows.find((th) => th.subs.some((x) => "sub:" + x.k.address === this.cursor))?.id : this.cursor;
    const i = this.order.findIndex((th) => th.id === id);
    if (i >= 0) this.scroll.scroll_to_item(i);
  }

  // A key while the list has the keyboard. True when used.
  navKey(e) {
    const m = e.modifiers ?? {}, raw = e.key ?? "";
    if (m.alt || m.control || m.platform) return false;
    const shift = Boolean(m.shift) || (raw.length === 1 && raw !== raw.toLowerCase());
    const k = raw.length === 1 ? raw.toLowerCase() : raw;
    if (this.menu) {
      const n = this.menuItems().length;
      switch (k) {
        case "j": case "down": this.menu.at = (this.menu.at + 1) % n; return true;
        case "k": case "up": this.menu.at = (this.menu.at + n - 1) % n; return true;
        case "enter": case "l": this.choose(this.menu.at); return true;
        case "escape": case "m": case "h": this.menu = null; return true;
      }
      return true; // the menu keeps every other key
    }
    if (this.picking) {
      switch (k) {
        case "j": case "down": this.moveThread(this.picking, { by: 1 }); this.reveal(); return true;
        case "k": case "up": this.moveThread(this.picking, { by: -1 }); this.reveal(); return true;
        case "escape": case "enter": case "m": this.picking = null; return true;
      }
      return true;
    }
    if (this.spPicking) {
      switch (k) {
        case "j": case "down": this.moveSpace(this.spPicking, { by: 1 }); return true;
        case "k": case "up": this.moveSpace(this.spPicking, { by: -1 }); return true;
        case "escape": case "enter": case "m": this.spPicking = null; return true;
      }
      return true;
    }
    if (k === "tab") { this.toggle(this.zone === "spaces" ? "threads" : "spaces"); return true; }
    if (k === "escape" || k === "h" || k === "left") { this.leave(); return true; }
    if (this.zone === "spaces") return this.spaceKey(k, shift);
    const nav = this.nav;
    if (!nav.length) return false;
    let at = nav.indexOf(this.cursor);
    const sub = String(nav[at] ?? "").startsWith("sub:") ? nav[at].slice(4) : null;
    const th = this.rows.find((x) => x.id === nav[at]);
    if (sub && (k === "enter" || k === "l" || k === "right")) { this.back = null; this.cursor = null; this.peek(sub); return true; }
    if (k === "o" || (k === "space")) {
      const owner = th ?? this.rows.find((x) => x.subs.some((y) => y.k.address === sub));
      if (owner?.subs.length) { this.fold(owner.id); this.cursor = owner.id; }
      return true;
    }
    switch (k) {
      case "j": case "down": at = Math.min(nav.length - 1, at + 1); break;
      case "k": case "up": at = Math.max(0, at - 1); break;
      case "g": at = shift ? nav.length - 1 : 0; break;
      case "home": at = 0; break;
      case "end": at = nav.length - 1; break;
      case "s":
        if (th) th.settled ? run("tab.unsettle", { id: th.id }) : this.settle(th);
        return true;
      case "m":
        if (th) this.menu = { kind: "thread", id: th.id, at: 0 };
        return true;
      case "enter": case "l": case "right":
        if (th) { this.back = null; this.cursor = null; this.open(th); }
        return true;
      default: return false;
    }
    this.cursor = nav[at];
    this.reveal();
    return true;
  }

  // Right-click: the same menu, on that thread; the list takes the keyboard for it.
  menuAt(th, cx) {
    if (!this.handle.is_focused()) this.back = focused()?.pane ?? null;
    this.zone = "threads";
    this.cursor = th.id;
    this.picking = null;
    this.spPicking = null;
    this.menu = { kind: "thread", id: th.id, at: 0 };
    this.handle.focus();
    cx.notify();
  }

  // ---- the card's menu, pinned under it (m or right-click) ----

  menuItems() {
    if (this.menu?.kind === "space") return this.spaceMenuItems();
    const th = this.rows.find((x) => x.id === this.menu?.id);
    if (!th) return [];
    const { s, tab } = th;
    return [
      ...(!tab.settled ? [["Pick", I("layers"), () => { this.picking = th.id; this.cursor = th.id; }]] : []),
      ["Rename", I("square-pen"), () => run("tab.rename", { id: tab.id })],
      [tab.settled ? "Unsettle" : "Settle", I("check"), () => (tab.settled ? run("tab.unsettle", { id: tab.id }) : this.settle(th))],
      ["New tab here", I("plus"), () => run("tab.new", { space: s.id })],
      ...(th.g?.linked ? [["Remove worktree", I("git-branch"), () => openOverlay({ mod: "worktree-dialog", kind: "dialog", width: 440, height: 260, props: { space: s.id, action: "remove" } })]] : []),
      th.unit === "agent" && th.lead
        ? ["Close pane", I("x"), () => run("pane.close", { pane: th.lead.pane })]
        : ["Close tab", I("x"), () => run("tab.close", { id: tab.id })],
    ];
  }

  choose(i) {
    const it = this.menuItems()[i];
    this.menu = null;
    if (it) it[2]();
  }

  // `el` (a thread's card or row), with its menu below it while open.
  withMenu(th, el, t) {
    if (!th || this.menu?.id !== th.id || !this.handle.is_focused()) return el;
    const card = v_flex().id("th-menu").w(210).p(5).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg().text_size(12.8)
      .on_mouse_down_out((_e, cx) => { this.menu = null; cx.notify(); })
      .children(this.menuItems().map(([label, ic], i) => v_flex()
        .when(/^(Close|Remove)/.test(label), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id("th-menu-" + i).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground).cursor_pointer()
          .when(i === this.menu.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.choose(i); cx.notify(); })
          .child(svg(ic).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().child(label))
          .when(label === "Pick", (el) => el.child(div().text_size(11).text_color(t.dim).child("j/k move"))))));
    return Popup.new("th-menu-" + th.id, el).anchor("top_left").content(card);
  }

  // ---- spaces: projects' main folders ----

  showSpace(s) {
    run("space.select", { id: s.id });
  }

  newThreadIn(s) {
    openOverlay({ mod: "thread-new", kind: "dialog", width: 560, props: { space: s.id } });
  }

  // Close the space (Herdr asks first if something runs in it); once it's gone, poll drops
  // its repo from the New thread dialog's projects too.
  removeSpace(s) {
    const g = this.git[spaceKey(s)];
    this.removing = { id: s.id, project: g?.main ? { path: g.main, machine: s.machine ?? null } : null };
    run("space.close", { id: s.id });
  }

  spaceMenuItems() {
    const s = spaces().find((x) => x.id === this.menu?.id);
    if (!s) return [];
    return [
      ["Pick", I("layers"), () => { this.spPicking = s.id; this.spCursor = s.id; }],
      ["New thread", I("plus"), () => this.newThreadIn(s)],
      ["New terminal", I("terminal"), () => run("tab.new", { space: s.id })],
      ["Rename", I("square-pen"), () => run("space.rename", { id: s.id })],
      ["Remove", I("x"), () => this.removeSpace(s)],
    ];
  }

  spaceMenuAt(s, cx) {
    if (!this.handle.is_focused()) this.back = focused()?.pane ?? null;
    this.zone = "spaces";
    this.spCursor = s.id;
    this.picking = null;
    this.spPicking = null;
    this.menu = { kind: "space", id: s.id, at: 0 };
    this.handle.focus();
    cx.notify();
  }

  moveSpace(id, { by, to }) {
    const order = [...this.spNav];
    const from = order.indexOf(id);
    if (from < 0) return false;
    const at = to !== undefined ? order.indexOf(to) : Math.max(0, Math.min(order.length - 1, from + by));
    if (at < 0 || at === from) return false;
    order.splice(at, 0, order.splice(from, 1)[0]);
    this.spNav = order;
    setShared(SPACE_ORDER, order);
    return true;
  }

  // A key while the spaces list has the keyboard. True when used.
  spaceKey(k, shift) {
    const nav = this.spNav;
    if (!nav.length) return false;
    let at = nav.indexOf(this.spCursor);
    const s = spaces().find((x) => x.id === nav[at]);
    const away = (fn) => { this.back = null; this.spCursor = null; fn(); };
    switch (k) {
      case "j": case "down": at = Math.min(nav.length - 1, at + 1); break;
      case "k": case "up": at = Math.max(0, at - 1); break;
      case "g": at = shift ? nav.length - 1 : 0; break;
      case "home": at = 0; break;
      case "end": at = nav.length - 1; break;
      case "m": if (s) this.menu = { kind: "space", id: s.id, at: 0 }; return true;
      case "n": if (s) away(() => this.newThreadIn(s)); return true;
      case "t": if (s) away(() => run("tab.new", { space: s.id })); return true;
      case "enter": case "l": case "right": if (s) away(() => this.showSpace(s)); return true;
      default: return false;
    }
    this.spCursor = nav[Math.max(0, at)];
    return true;
  }

  spaceRow(t, sp) {
    const { s, name, count, status } = sp;
    const keys = this.handle.is_focused() && this.zone === "spaces";
    const cursorOn = keys && this.spCursor === s.id;
    const picked = keys && this.spPicking === s.id;
    const hovered = this.spHovered === s.id;
    const dropHere = this.spPressed !== null && this.spPressed !== s.id && this.spOver === s.id;
    const from = this.spNav.indexOf(this.spPressed), to = this.spNav.indexOf(s.id);
    // Highlighted when it's shown and the shown tab isn't one of the threads below.
    const here = s.active && !this.shownId;
    return this.withMenu({ id: s.id }, h_flex().id("sp-" + s.id).relative().flex_none().h(26).pl(7).pr(5).gap(8).rounded(7).items_center()
      .text_size(13).cursor_pointer().tooltip((place(s, PANES) || "~") + (s.branch ? " · " + s.branch : ""))
      .border_1().border_color(cursorOn || picked ? t.accent : "#00000000")
      .when(picked, (el) => el.bg(t.accent + "1f"))
      .when(here, (el) => el.bg(t.selected))
      .when(!here, (el) => el.hover((st) => st.bg(t.hover)))
      .when(this.spPressed === s.id && this.spOver && this.spOver !== s.id, (el) => el.opacity(0.5))
      .when(dropHere, (el) => el.child(div().absolute().left(6).right(6).h(2).rounded(1).bg(t.accent)
        .when(from < to, (line) => line.bottom(-2))
        .when(from > to, (line) => line.top(-2))))
      .on_mouse_down("left", () => { this.spPressed = s.id; this.spOver = s.id; })
      .on_mouse_move((_e, cx) => { if (this.spPressed !== null && this.spOver !== s.id) { this.spOver = s.id; cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => {
        const fromId = this.spPressed;
        this.spPressed = null;
        this.spOver = null;
        if (fromId && fromId !== s.id) this.moveSpace(fromId, { to: s.id });
        cx.notify();
      })
      .on_hover((on, cx) => {
        if (on) this.spHovered = s.id;
        else if (this.spHovered === s.id) this.spHovered = null;
        cx.notify();
      })
      .on_click(() => this.showSpace(s))
      .on_mouse_down("right", (_e, cx) => this.spaceMenuAt(s, cx))
      .child(avatar(name, 16))
      .child(div().flex_1().min_w(0).truncate().text_color(s.active ? t.foreground : t.muted).when(s.active, (el) => el.font_medium()).child(name))
      .when(Boolean(s.machine), (el) => el.child(svg(I("server")).size(11).flex_none().text_color(t.dim)))
      .when(hovered, (el) => el.child(div().id("sp-new-" + s.id).size(20).flex_none().flex().items_center().justify_center().rounded(5)
        .text_color(t.muted).hover((b) => b.bg(t.selected).text_color(t.foreground)).tooltip("New thread here (n)")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.newThreadIn(s); })
        .child(svg(I("plus")).size(13))))
      .when(!hovered && count > 0, (el) => el.child(h_flex().flex_none().gap(5).items_center().pr(3)
        .child(this.subDot(t, status, 6))
        .child(div().text_size(11.5).text_color(t.dim).child(String(count))))), t);
  }

  // ---- drawing ----

  status(t, th, now) {
    const st = th.status;
    if (st === "working") return h_flex().flex_none().gap(5).items_center().text_color(t.working).font_medium()
      .child(svg(I("spinner")).size(13).flex_none().text_color(t.working).spin(900))
      .child("Working " + elapsed(now - (th.since ?? now)));
    if (st === "blocked") return h_flex().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").items_center()
      .text_size(11).font_semibold().text_color(t.blocked).child("Needs you");
    if (st === "done") return h_flex().flex_none().gap(5).items_center().text_color(t.done).font_medium()
      .child(div().size(7).rounded(4).bg(t.done)).child("Done");
    return th.at ? div().flex_none().text_color(t.dim).child(ago(now - th.at)) : null;
  }

  settleButton(t, th) {
    return h_flex().id("settle-" + th.id).flex_none().gap(4).px(6).h(20).rounded(5).items_center().text_color(t.muted)
      .cursor_pointer().hover((el) => el.bg(t.hover).text_color(t.foreground)).tooltip("Settle thread")
      .on_click((_e, cx) => { cx.stop_propagation(); this.settle(th); cx.notify(); })
      .child(svg(I("check")).size(12)).child("Settle");
  }

  card(t, th, now) {
    const s = th.s;
    const shown = this.shownId === th.id;
    const hovered = this.hovered === th.id;
    const cursorOn = this.cursor === th.id && this.handle.is_focused() && this.zone === "threads";
    const picked = this.picking === th.id && this.handle.is_focused();
    const dragging = this.pressed !== null && this.pressed !== th.id;
    const dropHere = dragging && this.over === th.id;
    const from = this.order.findIndex((x) => x.id === this.pressed), to = this.order.findIndex((x) => x.id === th.id);
    const remote = s.machine;
    const where = th.branch ?? (th.g === null ? s.name : "");
    return this.withMenu(th, v_flex().id("th-" + th.id).relative().flex_none().px(10).py(8).gap(3).rounded(10).cursor_pointer()
      .border_1().border_color(cursorOn || picked ? t.accent : "#00000000")
      .when(picked, (el) => el.bg(t.accent + "1f"))
      .when(this.pressed === th.id && this.over && this.over !== th.id, (el) => el.opacity(0.5))
      .when(dropHere, (el) => el.child(div().absolute().left(6).right(6).h(2).rounded(1).bg(t.accent)
        .when(from < to, (line) => line.bottom(-3))
        .when(from > to, (line) => line.top(-3))))
      .on_mouse_down("left", () => { this.pressed = th.id; this.over = th.id; })
      .on_mouse_move((_e, cx) => {
        if (this.pressed !== null && this.over !== th.id) { this.over = th.id; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const fromId = this.pressed;
        this.pressed = null;
        this.over = null;
        if (fromId && fromId !== th.id) this.moveThread(fromId, { to: th.id });
        cx.notify();
      })
      .when(shown, (el) => el.bg(t.selected))
      .when(!shown, (el) => el.hover((st) => st.bg(t.hover)))
      .on_hover((on, cx) => {
        if (on) this.hovered = th.id;
        else if (this.hovered === th.id) this.hovered = null;
        cx.notify();
      })
      .on_click(() => this.open(th))
      .on_mouse_down("right", (_e, cx) => this.menuAt(th, cx))
      // project · status or time (hover: Settle)
      .child(h_flex().h(20).gap(7).items_center().text_size(12)
        .when(Boolean(th.project), (el) => el.child(avatar(th.project, 17)))
        .child(div().flex_shrink_1().min_w(0).truncate().text_color(t.dim).child(th.project || "…"))
        .when(!th.place, (el) => el.child(div().flex_1()))
        .when(Boolean(th.place), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child("· " + th.place)))
        .when(hovered && th.at > 0 && th.status !== "working", (el) => el.child(div().flex_none().text_color(t.dim).child(ago(now - th.at))))
        .when(hovered, (el) => el.child(this.settleButton(t, th)))
        .when(!hovered, (el) => { const x = this.status(t, th, now); return x ? el.child(x) : el; }))
      // what it's doing
      .child(div().truncate().text_size(14).font_medium().text_color(t.foreground).child(th.title))
      // where: machine, branch · changes, agents
      .child(h_flex().h(18).gap(6).items_center().text_size(12).text_color(t.dim)
        .child(svg(I(remote ? "server" : "git-branch")).size(12).flex_none())
        .when(Boolean(remote), (el) => el.child(div().flex_none().child(remote)))
        .child(div().flex_1().min_w(0).truncate().child(where))
        .when((th.g?.changes ?? 0) > 0, (el) => el.child(h_flex().id("chg-" + th.id).flex_none().gap(3).items_center().text_color(t.ansi2)
          .tooltip(th.g.changes + " uncommitted " + (th.g.changes === 1 ? "file" : "files"))
          .child(svg(I("layers")).size(12)).child(String(th.g.changes))))
        .when(th.subs.length > 0, (el) => el.child(this.subChip(t, th)))
        .children(th.programs.slice(0, 3).map((p) => icon(p, 13, t.foreground))))
      .when(th.subs.length > 0 && this.unfolded.has(th.id), (el) => el.child(this.subList(t, th, now))), t);
  }

  settledRow(t, th, now) {
    const cursorOn = this.cursor === th.id && this.handle.is_focused() && this.zone === "threads";
    return this.withMenu(th, h_flex().id("st-" + th.id).flex_none().h(30).px(10).gap(8).rounded(8).items_center().text_size(12.5).cursor_pointer()
      .border_1().border_color(cursorOn ? t.accent : "#00000000")
      .hover((el) => el.bg(t.hover))
      .on_click(() => this.open(th))
      .on_mouse_down("right", (_e, cx) => this.menuAt(th, cx))
      .child(th.project ? avatar(th.project, 15) : div().size(15).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(th.title))
      .when(th.settledAt > 0, (el) => {
        // A worktree settled whole counts down to its cleanup.
        const since = th.g?.linked && !th.s.machine ? settledSince(th.s) : null;
        if (since === null) return el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(ago(now - th.settledAt)));
        const left = Math.max(0, CLEAN_AFTER - (now - since));
        return el.child(div().id("cl-" + th.id).flex_none().text_size(11.5).text_color(left < 86400000 ? t.blocked : t.dim)
          .tooltip("Its worktree is removed after 7 days settled, unless it has uncommitted changes. The branch stays.")
          .child(left < 3600000 ? "removing soon" : "removes in " + ago(left)));
      }), t);
  }

  rail(t, active, roots) {
    return v_flex().id("threads").size_full().bg(t.chrome).items_center().pt(6).gap(4)
      .children(roots.map((sp) => div().id("rail-sp-" + sp.s.id).flex_none().p(4).rounded(6).cursor_pointer()
        .when(sp.s.active && !this.shownId, (el) => el.bg(t.selected)).hover((el) => el.bg(t.hover))
        .tooltip(sp.name).on_click(() => this.showSpace(sp.s))
        .child(avatar(sp.name, 18))))
      .when(roots.length > 0, (el) => el.child(div().flex_none().w(20).h(1).my(2).bg(t.border)))
      .child(v_flex().id("rail").flex_1().min_h(0).w_full().items_center().gap(4).overflow_y_scroll()
        .children(active.map((th) => div().id("rail-" + th.id).relative().p(4).rounded(6).cursor_pointer()
          .when(this.shownId === th.id, (el) => el.bg(t.selected)).hover((el) => el.bg(t.hover))
          .tooltip(th.title).on_click(() => this.open(th))
          .child(avatar(th.project || th.s.name, 22))
          .when(Boolean(th.status && th.status !== "idle"), (el) => el.child(div().absolute().right(1).bottom(1).size(8).rounded(4)
            .border_1().border_color(t.chrome).bg(t[th.status] ?? t.dim))))))
      .child(div().id("expand").h(28).text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click(toggleSidebar).child("»"));
  }

  headerButton(t, id, ic, tip, act) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(act).child(svg(I(ic)).size(15));
  }

  render(cx) {
    const cmd = shared(CMD);
    if (cmd?.id && cmd.id !== this.lastCmd) {
      this.lastCmd = cmd.id;
      this.cxTimer(0, (c2) => { this.command(cmd.c); c2?.notify(); });
    }
    const t = theme();
    const now = Date.now();
    const ps = panes();
    PANES = ps;
    this.readSubs(now);
    const list = spaces();
    const units = this.units(list, agents(), ps);
    this.track(units, now);
    const all = units.map((u) => this.thread(u, ps));
    this.rows = all;
    // The shown thread: the focused agent's own card, else the shown tab's.
    const f = focused();
    this.shownId = (all.find((th) => th.unit === "agent" && th.lead?.pane === f?.pane) ?? all.find((th) => th.tab.id === f?.tab))?.id ?? null;
    // Spaces: every one that isn't a worktree, in your order (new ones last).
    const savedSp = shared(SPACE_ORDER) ?? [];
    const rootById = new Map(list.filter((s) => !this.isWorktree(s)).map((s) => [s.id, s]));
    const spOrder = [...savedSp.filter((id) => rootById.has(id)), ...[...rootById.keys()].filter((id) => !savedSp.includes(id))];
    if (list.length && JSON.stringify(spOrder) !== JSON.stringify(savedSp)) setShared(SPACE_ORDER, spOrder);
    this.spNav = spOrder;
    if (this.spPicking && !rootById.has(this.spPicking)) this.spPicking = null;
    const roots = spOrder.map((id) => {
      const s = rootById.get(id);
      const name = s.name.replace(/ \(deleted\)$/, "");
      const mine = all.filter((th) => th.unit === "agent" && th.s.id === id);
      const status = mine.map((th) => th.status).reduce((m, x) => ((RANK[x] ?? 0) > (RANK[m] ?? 0) ? x : m), "idle");
      return { s, name, count: mine.length, status };
    });
    // Inbox order: latest activity first, then Herdr's own order.
    // Your order; threads it doesn't have yet (new, or back from Settled) go on top, latest first.
    const saved = shared(ORDER) ?? [];
    const byId = new Map(all.filter((th) => !th.settled).map((th) => [th.id, th]));
    const fresh = [...byId.values()].filter((th) => !saved.includes(th.id)).sort((a, b) => b.at - a.at || a.s.index - b.s.index || a.tab.index - b.tab.index);
    const active = [...fresh, ...saved.filter((id) => byId.has(id)).map((id) => byId.get(id))];
    const next = active.map((th) => th.id);
    if (spaces().length && JSON.stringify(next) !== JSON.stringify(saved)) setShared(ORDER, next);
    if (this.picking && !byId.has(this.picking)) this.picking = null;
    const settled = all.filter((th) => th.settled).sort((a, b) => b.settledAt - a.settledAt || b.at - a.at);
    this.order = active;
    setAgentOrder(active.flatMap((th) => th.agents.map((a) => a.address)));
    if (narrow()) return this.rail(t, active, roots);
    this.nav = [...active, ...(this.openSettled ? settled : [])].flatMap((th) =>
      [th.id, ...(this.unfolded.has(th.id) ? th.subs.map((x) => "sub:" + x.k.address) : [])]);

    const settledOpen = this.openSettled && settled.length > 0;
    return v_flex().id("threads").track_focus(this.handle)
      .on_key_down((e, cx) => { if (this.handle.is_focused() && this.navKey(e)) { cx.stop_propagation(); cx.notify(); } })
      .size_full().min_h(0).bg(t.chrome).text_size(13)
      // Search · add project · new thread
      .child(h_flex().flex_none().h(40).pl(10).pr(8).gap(2).items_center()
        .child(h_flex().id("search").flex_1().h(30).px(6).gap(8).rounded(7).items_center().text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => run("mod.open", { name: "picker" }))
          .child(svg(I("search")).size(15)).child("Search"))
        .child(this.headerButton(t, "pulls", "git-compare", "Pull requests (alt-p)", () => run("mod.open", { name: "pulls" })))
        .child(this.headerButton(t, "new-thread", "square-pen", "New thread (ctrl-shift-n)", () => run("mod.open", { name: "thread-new" }))))
      // Spaces
      .child(h_flex().flex_none().h(26).pl(10).pr(8).gap(6).items_center()
        .child(h_flex().id("spaces-toggle").flex_1().h_full().gap(6).items_center().cursor_pointer().text_size(11.5).font_medium().text_color(t.dim)
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.spacesOpen = !this.spacesOpen; setShared("threads.spacesOpen", this.spacesOpen); cx.notify(); })
          .child("Spaces")
          .when(!this.spacesOpen, (el) => el.child(div().text_color(t.dim).child(String(roots.length))))
          .child(svg(I(this.spacesOpen ? "chevron-down" : "chevron-right")).size(11).flex_none()))
        .child(div().id("add-project").size(22).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Add project")
          .on_click(() => openOverlay({ mod: "thread-new", kind: "dialog", width: 560, props: { pick: true } }))
          .child(svg(I("folder-plus")).size(13))))
      .when(this.spacesOpen, (el) => el.child(v_flex().id("sp-list").flex_none().mb(6).px(8).pt(1).gap(1)
        .on_mouse_up("left", (_e, cx) => { if (this.spPressed) { this.spPressed = null; this.spOver = null; cx.notify(); } })
        .children(roots.map((sp) => this.spaceRow(t, sp)))
        .when(roots.length === 0, (el) => el.child(div().px(8).py(4).text_size(12).text_color(t.dim).child("No projects yet. Add one with the folder button.")))))
      .child(h_flex().flex_none().h(26).mt(2).pl(10).pr(8).gap(6).items_center().border_t(1).border_color(t.border)
        .text_size(11.5).font_medium().text_color(t.dim).child("Threads").child(div().child(active.length ? String(active.length) : "")))
      // The inbox
      .child(v_flex().id("th-list").on_mouse_up("left", (_e, cx) => { if (this.pressed) { this.pressed = null; this.over = null; cx.notify(); } }).flex_1().min_h(0).px(8).pt(4).pb(8).gap(4).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(active.map((th) => this.card(t, th, now)))
        .when(active.length === 0, (el) => el.child(div().px(8).py(6).text_size(12.5).text_color(t.dim)
          .child(settled.length ? "Inbox zero. Settled threads are below." : "No worktrees or running agents. Ctrl+Shift+N starts a thread."))))
      // Settled
      .when(settled.length > 0, (el) => el
        .child(h_flex().id("settled-toggle").flex_none().h(36).px(18).gap(8).items_center().border_t(1).border_color(t.border)
          .text_size(12.5).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.openSettled = !this.openSettled; setShared("threads.settledOpen", this.openSettled); cx.notify(); })
          .child(div().flex_1().child("Settled"))
          .child(div().text_color(t.dim).child(String(settled.length)))
          .child(svg(I(settledOpen ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim)))
        .when(settledOpen, (el) => el.child(v_flex().id("st-list").flex_none().max_h(260).px(8).pb(8).gap(1).overflow_y_scrollbar()
          .children(settled.map((th) => this.settledRow(t, th, now))))));
  }
}
