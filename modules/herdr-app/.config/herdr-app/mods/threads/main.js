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
// Cleanup: a worktree space (under ~/.herdr/worktrees, this computer) whose tabs have all
// been settled for 7 days, with no agent working or waiting, has its checkout removed
// (`git worktree remove`, never forced) and its space closed. Its branch is left alone. One
// with uncommitted or untracked changes, or that git won't remove, is kept and named in
// the notification (once per reason). It runs 20 s after start and then hourly.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, Popup } from "gpui-base";
import { spaces, agents, terminals, panes, focused, run, exec, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, nextCommand, notify, home, checking } from "herdr";

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
const CLEAN_AFTER = 7 * 86400000;
const WARNED = "cleanup.warned"; // path -> the reason it was last kept, so it's said once

// When a space's last tab was settled, if all of them are; else null.
const settledSince = (s) => (s.tabs.length && s.tabs.every((tb) => tb.settled && tb.settled_at) ? Math.max(...s.tabs.map((tb) => tb.settled_at)) : null);
const GIT_EVERY = 30000;

export default class Threads extends View {
  init(_props, cx) {
    this.git = {}; // keyOf -> { project, top, main, linked, changes } | null (not git)
    this.asked = {}; // keyOf -> when git was last asked
    this.inflight = new Set();
    this.wasWorking = new Set(); // spaces working at the last look
    // When each space last changed state (ms), kept across restarts: the inbox order.
    this.activity = JSON.parse(localStorage.getItem(ACTIVITY) ?? "{}");
    this.lastStatus = {};
    this.known = new Set(spaces().flatMap((s) => s.tabs.map((tb) => tb.id)));
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
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "toggle") this.toggle();
        else if (c === "settle") this.settleShown();
        else if (c === "subs") { const th = this.order.find((x) => x.id === focused()?.tab); if (th?.subs.length) this.fold(th.id); }
        else if (/^slot[1-9]$/.test(c)) { const th = this.order[Number(c.slice(4)) - 1]; if (th) this.open(th); }
        cx.notify();
      }
    });
  }

  // ---- git, per place: project name, linked worktree, uncommitted changes ----

  poll(cx) {
    const ps = panes();
    const now = Date.now();
    const front = window()?.active;
    for (const r of agentTabs(spaces(), agents(), ps)) {
      const { s, tab, lead } = r;
      const key = keyOf(s, lead, ps);
      if (!JSON.parse(key)[1]) continue;
      if (key in this.asked && !this.isThread(r, key)) continue;
      const working = tab.status === "working";
      // An agent's turn just ended: its edits and commits change the counts.
      const ended = this.wasWorking.has(tab.id) && !working;
      if (working) this.wasWorking.add(tab.id); else this.wasWorking.delete(tab.id);
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
        const on = this.cursor === "sub:" + k.address && this.handle.is_focused();
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

  // ---- what a thread is ----

  // Stamps threads (tabs) whose state changed; a new one counts as activity.
  track(rows, now) {
    let dirty = false;
    for (const { tab } of rows) {
      const st = tab.status === "done" ? "idle" : tab.status ?? "none";
      const born = !this.known.has(tab.id);
      if (born) this.known.add(tab.id);
      if (this.lastStatus[tab.id] === st && !born) continue;
      const first = !(tab.id in this.lastStatus);
      this.lastStatus[tab.id] = st;
      // At start the last-known state isn't news: keep the stored time.
      if (first && !born && this.activity[tab.id]) continue;
      const changed = Math.max(tab.changed_at ?? 0, tab.working_since ?? 0);
      this.activity[tab.id] = born || !first ? now : Math.max(this.activity[tab.id] ?? 0, changed);
      dirty = true;
    }
    if (!dirty) return;
    // Forget tabs that are gone (all of them, not just those without an agent now).
    const ids = new Set(spaces().flatMap((s) => s.tabs.map((tb) => tb.id)));
    for (const id of Object.keys(this.activity)) if (!ids.has(id) && ids.size) delete this.activity[id];
    localStorage.setItem(ACTIVITY, JSON.stringify(this.activity));
  }

  // Worktree spaces always show (every tab); other spaces only their tabs with an agent.
  isThread({ s, agents: mine }, key) {
    if (mine.length) return true;
    const g = this.git[key];
    return g ? g.linked : /\/worktrees\/[^/]+\/[^/]+\/?$/.test(s.folder ?? "");
  }

  thread({ s, tab, agents: mine, lead }, ps) {
    const key = keyOf(s, lead, ps);
    const g = this.git[key];
    const said = mine.map(telling).find(Boolean);
    const name = s.name.replace(/ \(deleted\)$/, "");
    const title = said || (tab.named ? tab.name : null) || mine[0]?.program?.name || (s.tabs.length > 1 ? name + " · " + tab.name : name);
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
    // The card speaks for its most urgent agent or sub-agent.
    const status = [tab.status, ...subs.map((x) => x.status)].reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), tab.status);
    return { id: tab.id, subs, s, tab, key, g, title, project, branch: lead?.branch ?? s.branch ?? null,
      // A worktree's own space name says which checkout; a main checkout's adds nothing.
      place: g?.linked ? name : null,
      status, since: tab.working_since ?? null, programs, agents: mine, lead,
      settled: tab.settled, settledAt: tab.settled_at ?? 0, at: this.activity[tab.id] ?? 0 };
  }

  // ---- actions ----

  open(th) {
    if (th.tab.settled) run("tab.unsettle", { id: th.tab.id });
    if (th.lead) run("pane.focus", { pane: th.lead.pane });
    else { run("space.select", { id: th.s.id }); run("tab.select", { id: th.tab.id }); }
  }

  settle(th) {
    // Settling the shown thread moves on to the next one, as an inbox does.
    if (focused()?.tab === th.id) {
      const at = this.order.findIndex((x) => x.id === th.id);
      const next = this.order[at + 1] ?? this.order[at - 1];
      if (next) this.open(next);
    }
    run("tab.settle", { id: th.id });
    if (this.hovered === th.id) this.hovered = null;
  }

  settleShown() {
    const th = this.order.find((x) => x.id === focused()?.tab);
    if (th) this.settle(th);
  }

  toggle() {
    if (this.handle.is_focused()) return this.leave();
    this.menu = null;
    this.picking = null;
    this.back = focused()?.pane ?? null;
    const tab = focused()?.tab;
    this.cursor = this.nav.includes(tab) ? tab : this.nav[0] ?? null;
    this.handle.focus();
  }

  leave() {
    const back = this.back;
    this.back = null;
    this.cursor = null;
    this.menu = null;
    this.picking = null;
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
    if (k === "escape" || k === "h" || k === "left") { this.leave(); return true; }
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
        if (th) this.menu = { id: th.id, at: 0 };
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
    this.cursor = th.id;
    this.picking = null;
    this.menu = { id: th.id, at: 0 };
    this.handle.focus();
    cx.notify();
  }

  // ---- the card's menu, pinned under it (m or right-click) ----

  menuItems() {
    const th = this.rows.find((x) => x.id === this.menu?.id);
    if (!th) return [];
    const { s, tab } = th;
    return [
      ...(!tab.settled ? [["Pick", I("layers"), () => { this.picking = th.id; this.cursor = th.id; }]] : []),
      ["Rename", I("square-pen"), () => run("tab.rename", { id: tab.id })],
      [tab.settled ? "Unsettle" : "Settle", I("check"), () => (tab.settled ? run("tab.unsettle", { id: tab.id }) : this.settle(th))],
      ["New tab here", I("plus"), () => run("tab.new", { space: s.id })],
      ...(th.g?.linked ? [["Remove worktree", I("git-branch"), () => openOverlay({ mod: "worktree-dialog", kind: "dialog", width: 440, height: 260, props: { space: s.id, action: "remove" } })]] : []),
      ["Close tab", I("x"), () => run("tab.close", { id: tab.id })],
    ];
  }

  choose(i) {
    const it = this.menuItems()[i];
    this.menu = null;
    if (it) it[2]();
  }

  // `el` (a thread's card or row), with its menu below it while open.
  withMenu(th, el, t) {
    if (this.menu?.id !== th.id || !this.handle.is_focused()) return el;
    const card = v_flex().id("th-menu").w(210).p(5).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg().text_size(12.8)
      .on_mouse_down_out((_e, cx) => { this.menu = null; cx.notify(); })
      .children(this.menuItems().map(([label, ic], i) => v_flex()
        .when(label === "Close tab", (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id("th-menu-" + i).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground).cursor_pointer()
          .when(i === this.menu.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.choose(i); cx.notify(); })
          .child(svg(ic).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().child(label))
          .when(label === "Pick", (el) => el.child(div().text_size(11).text_color(t.dim).child("j/k move"))))));
    return Popup.new("th-menu-" + th.id, el).anchor("top_left").content(card);
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
    const shown = focused()?.tab === th.id;
    const hovered = this.hovered === th.id;
    const cursorOn = this.cursor === th.id && this.handle.is_focused();
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
    const cursorOn = this.cursor === th.id && this.handle.is_focused();
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

  rail(t, active) {
    return v_flex().id("threads").size_full().bg(t.chrome).items_center().pt(6).gap(4)
      .child(v_flex().id("rail").flex_1().min_h(0).w_full().items_center().gap(4).overflow_y_scroll()
        .children(active.map((th) => div().id("rail-" + th.id).relative().p(4).rounded(6).cursor_pointer()
          .when(focused()?.tab === th.id, (el) => el.bg(t.selected)).hover((el) => el.bg(t.hover))
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
    const t = theme();
    const now = Date.now();
    const ps = panes();
    this.readSubs(now);
    const rows = agentTabs(spaces(), agents(), ps).filter((r) => this.isThread(r, keyOf(r.s, r.lead, ps)));
    this.track(rows, now);
    const all = rows.map((r) => this.thread(r, ps));
    this.rows = all;
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
    if (narrow()) return this.rail(t, active);
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
        .child(this.headerButton(t, "add-project", "folder-plus", "Add project", () => openOverlay({ mod: "thread-new", kind: "dialog", width: 560, props: { pick: true } })))
        .child(this.headerButton(t, "new-thread", "square-pen", "New thread (ctrl-shift-n)", () => run("mod.open", { name: "thread-new" }))))
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
