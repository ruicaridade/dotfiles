// Pull requests: every open PR in your projects' GitHub repos (the projects New thread
// knows, shared "threads.projects"), grouped Authored / Review requested (you, or a team
// you're in) / Others.
// Enter (or a click) opens the PR's thread: the space already on its branch, else the
// worktree for it, else a new worktree of its branch (fetched from origin; a fork's PR from
// pull/N/head) with your last-picked agent. A branch can only be checked out once, so a
// PR whose branch already has a checkout reuses it: its thread is unsettled and shown, or a
// space is opened there. Rows say when a PR has a thread, a settled one, or a bare checkout.
//
// Keys: type to fuzzy-search (#, title, author, repo, branch). Filters are words in the
// same box: author:<login|me>, repo:<name>, is:draft|ready, review:approved|changes|required,
// ci:pass|fail|pending, sort:updated|created|size. Chips under the box toggle them too.
// ↑/↓ or ctrl-j/ctrl-k (ctrl-n/ctrl-p) move, Enter opens, ctrl-o opens it on GitHub,
// Tab / shift-Tab switch view (All, Authored, Review requested, Others), ctrl-r refreshes,
// Esc closes. It also closes when the keyboard moves elsewhere in the window (alt-a, ...).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, ScrollHandle } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, exec, home, shared, setShared, knownAgents, checking, panes, window } from "herdr";

const I = (name) => "mods/workspace-chrome/" + name + ".svg";
const P = (name) => "mods/pulls/" + name + ".svg";
const CACHE = "prs"; // localStorage: { at, me, prs }
const FIELDS = "number,title,author,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup,additions,deletions,updatedAt,createdAt,url,isCrossRepository,reviewRequests";
const VIEWS = [["all", "All"], ["authored", "Authored"], ["review", "Review requested"], ["others", "Others"]];

const MARK = ["#22a99a", "#e3814f", "#5b8def", "#8b7cf6", "#3fae6a", "#d9649a", "#d4a72c", "#e05d5d"];
const colorOf = (name) => MARK[Math.abs([...name].reduce((h, c) => (h * 31 + c.codePointAt(0)) | 0, 7)) % MARK.length];

function ago(iso) {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return Math.max(1, m) + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d < 60 ? d + "d ago" : Math.floor(d / 30) + "mo ago";
}
const num = (n) => n.toLocaleString("en-US");
const slug = (b) => b.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const repoOfUrl = (url) => url.replace(/\.git$/, "").match(/github\.com[:/]([^/]+\/[^/]+)$/)?.[1] ?? null;

// CI from statusCheckRollup: fail beats pending beats pass; null without checks.
function ci(rollup) {
  if (!rollup?.length) return null;
  let pending = false;
  for (const c of rollup) {
    const v = (c.conclusion || c.state || c.status || "").toUpperCase();
    if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v)) return "fail";
    if (["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", ""].includes(v) || (c.status && c.status !== "COMPLETED")) pending = true;
  }
  return pending ? "pending" : "pass";
}

// Subsequence match: null when a letter is missing, else a score (higher = tighter).
function fuzzy(text, q) {
  let at = 0, score = 0, run = 0;
  for (const ch of q) {
    const i = text.indexOf(ch, at);
    if (i < 0) return null;
    run = i === at ? run + 1 : 0;
    score += 1 + run * 2 - Math.min(3, (i - at) * 0.1);
    at = i + 1;
  }
  return score;
}

async function git(cwd, args, timeout = 30000) {
  const r = await exec("git", args, { cwd, timeout });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

export default class Pulls extends View {
  init(_props, cx) {
    const cached = JSON.parse(localStorage.getItem(CACHE) ?? "null");
    this.prs = cached?.prs ?? [];
    this.me = cached?.me ?? null;
    this.teams = cached?.teams ?? null;
    this.fetchedAt = cached?.at ?? 0;
    this.repos = {}; // "owner/repo" -> { path, name }
    this.checkouts = {}; // "owner/repo" -> { branch: checkout path }
    this.loading = false;
    this.errors = [];
    this.view = shared("pulls.view") ?? "all";
    this.at = 0;
    this.busy = null; // url being opened
    this.error = "";
    this.text = shared("pulls.query") ?? "";
    this.input = InputState.new({ value: this.text, placeholder: "Search pull requests  (author:me  repo:  is:draft  review:  ci:  sort:)" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; this.error = ""; setShared("pulls.query", this.text); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.open(this.shown()[this.at], cx));
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.scroll = ScrollHandle.new();
    cx.timer.after(60, () => this.input.focus());
    // Close when the keyboard goes elsewhere in the window (alt-a, a click on a pane...).
    // Switching to another app keeps it: only a focus change inside an active window counts.
    this.inputFocused = false;
    this.input.on("focus", () => { this.inputFocused = true; });
    this.input.on("blur", () => { this.inputFocused = false; });
    this.born = Date.now();
    cx.timer.every(250, () => this.checkFocus());
    if (!checking()) this.refresh(cx);
  }

  close() { if (!this.closed) { this.closed = true; closeOverlay(props().overlay); } }

  checkFocus() {
    if (checking() || Date.now() - this.born < 600 || !window()?.active) return;
    if (!this.inputFocused && !this.handle.is_focused()) this.close();
  }

  // ---- data ----

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    this.errors = [];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!this.me) {
          const r = await exec("gh", ["api", "user", "-q", ".login"], { timeout: 15000 });
          if (r.code === 0) this.me = r.stdout.trim();
        }
        // Teams you're in ("org/slug"): a review asked of one of them is asked of you.
        if (!this.teams) {
          const r = await exec("gh", ["api", "user/teams", "--paginate", "-q", '.[] | .organization.login + "/" + .slug'], { timeout: 15000 }).catch(() => null);
          this.teams = r?.code === 0 ? r.stdout.split("\n").filter(Boolean).map((s) => s.toLowerCase()) : [];
        }
        // The projects' GitHub repos (a project's origin remote).
        const projects = shared("threads.projects") ?? [];
        const repos = {};
        await Promise.all(projects.filter((p) => !p.machine).map(async (p) => {
          const r = await git(p.path, ["remote", "get-url", "origin"], 5000).catch(() => null);
          const full = r?.ok ? repoOfUrl(r.out) : null;
          if (full) repos[full] = { path: p.path, name: p.name };
        }));
        this.repos = repos;
        // Each repo's checkouts by branch, to mark PRs that already have a thread.
        const checkouts = {};
        await Promise.all(Object.entries(repos).map(async ([full, r]) => {
          const list = await git(r.path, ["worktree", "list", "--porcelain"], 5000).catch(() => null);
          const map = {};
          for (const block of (list?.out ?? "").split(/\n\n+/)) {
            const l = block.split("\n");
            const b = l.find((x) => x.startsWith("branch refs/heads/"))?.slice(18);
            const at = l.find((x) => x.startsWith("worktree "))?.slice(9);
            if (b && at) map[b] = at;
          }
          checkouts[full] = map;
        }));
        this.checkouts = checkouts;
        const lists = await Promise.all(Object.keys(repos).map(async (full) => {
          try {
            const r = await exec("gh", ["pr", "list", "-R", full, "--state", "open", "--limit", "100", "--json", FIELDS], { timeout: 30000 });
            if (r.code !== 0) { this.errors.push(full + ": " + (r.stderr || r.stdout).trim().split("\n").pop()); return []; }
            return JSON.parse(r.stdout).map((p) => ({ ...p, repo: full }));
          } catch (e) { this.errors.push(full + ": " + String(e.message ?? e)); return []; }
        }));
        this.prs = lists.flat().map((p) => ({
          repo: p.repo, number: p.number, title: p.title, url: p.url, author: p.author?.login ?? "?",
          head: p.headRefName, base: p.baseRefName, draft: p.isDraft, fork: p.isCrossRepository,
          review: p.reviewDecision || null, ci: ci(p.statusCheckRollup), adds: p.additions, dels: p.deletions,
          updated: p.updatedAt, created: p.createdAt,
          requested: (p.reviewRequests ?? []).some((r) => r.login === this.me || (r.slug && this.teams.includes(r.slug.toLowerCase()))),
        }));
        this.fetchedAt = Date.now();
        localStorage.setItem(CACHE, JSON.stringify({ at: this.fetchedAt, me: this.me, teams: this.teams, prs: this.prs }));
      } catch (e) {
        this.errors.push(String(e.message ?? e));
      }
      this.loading = false;
      cx.notify();
    });
  }

  // ---- filtering ----

  parse() {
    const f = { words: [], sort: "updated" };
    for (const tok of this.text.trim().split(/\s+/).filter(Boolean)) {
      const m = tok.match(/^(author|repo|is|review|ci|sort|base):(.*)$/i);
      if (m) f[m[1].toLowerCase()] = m[2].toLowerCase();
      else f.words.push(tok.toLowerCase());
    }
    return f;
  }

  group(p) {
    if (p.author === this.me) return "authored";
    if (p.requested) return "review";
    return "others";
  }

  // The rows in view order, each with its group.
  shown() {
    const f = this.parse();
    const me = (this.me ?? "").toLowerCase();
    const scored = [];
    for (const p of this.prs) {
      if (this.view !== "all" && this.group(p) !== this.view) continue;
      if (f.author && p.author.toLowerCase() !== (f.author === "me" ? me : f.author) && !(f.author !== "me" && p.author.toLowerCase().includes(f.author))) continue;
      if (f.repo && !p.repo.toLowerCase().includes(f.repo)) continue;
      if (f.base && p.base.toLowerCase() !== f.base) continue;
      if (f.is === "draft" && !p.draft) continue;
      if (f.is === "ready" && p.draft) continue;
      if (f.review === "approved" && p.review !== "APPROVED") continue;
      if (f.review === "changes" && p.review !== "CHANGES_REQUESTED") continue;
      if (f.review === "required" && p.review !== "REVIEW_REQUIRED") continue;
      if (f.ci && (f.ci === "pass" ? p.ci !== "pass" : f.ci === "fail" ? p.ci !== "fail" : p.ci !== "pending")) continue;
      let score = 0, ok = true;
      const hay = ("#" + p.number + " " + p.title + " " + p.author + " " + p.repo + " " + p.head).toLowerCase();
      for (const w of f.words) {
        const s = hay.includes(w) ? 100 + w.length : fuzzy(hay, w);
        if (s === null) { ok = false; break; }
        score += s;
      }
      if (ok) scored.push({ p, score });
    }
    const by = {
      updated: (a, b) => Date.parse(b.p.updated) - Date.parse(a.p.updated),
      created: (a, b) => Date.parse(b.p.created) - Date.parse(a.p.created),
      size: (a, b) => b.p.adds + b.p.dels - (a.p.adds + a.p.dels),
    }[f.sort] ?? ((a, b) => Date.parse(b.p.updated) - Date.parse(a.p.updated));
    const order = { authored: 0, review: 1, others: 2 };
    scored.sort((a, b) => order[this.group(a.p)] - order[this.group(b.p)] || (f.words.length ? b.score - a.score : 0) || by(a, b));
    return scored.map((x) => x.p);
  }

  // Toggle a filter word in the box: same key and value removes it, a different value replaces it.
  toggle(key, value, cx) {
    const toks = this.text.trim().split(/\s+/).filter(Boolean);
    const at = toks.findIndex((t) => t.toLowerCase().startsWith(key + ":"));
    const word = key + ":" + value;
    if (at >= 0 && toks[at].toLowerCase() === word) toks.splice(at, 1);
    else if (at >= 0) toks[at] = word;
    else toks.push(word);
    this.text = toks.join(" ") + (toks.length ? " " : "");
    this.input.set_value(this.text);
    setShared("pulls.query", this.text);
    this.at = 0;
    this.input.focus();
    cx.notify();
  }

  // ---- opening a PR's thread ----

  open(p, cx) {
    if (!p || this.busy) return;
    const repo = this.repos[p.repo];
    if (!repo) { this.error = "No local checkout of " + p.repo + ". Add it as a project in New thread."; return cx.notify(); }
    this.busy = p.url;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.openThread(p, repo);
        this.close();
      } catch (e) {
        this.error = String(e.message ?? e);
      }
      this.busy = null;
      cx.notify();
    });
  }

  async agentArgv() {
    try {
      const list = (await knownAgents()).filter((a) => a.installed);
      const key = shared("threads.agent");
      if (key === "shell") return null;
      return (list.find((a) => a.key === key) ?? list[0])?.run ?? null;
    } catch { return null; }
  }

  // Where the branch is checked out now (git allows one checkout per branch), or null.
  async checkoutOf(repo, branch) {
    const list = await git(repo.path, ["worktree", "list", "--porcelain"]);
    for (const block of list.out.split(/\n\n+/)) {
      const l = block.split("\n");
      if (l.includes("branch refs/heads/" + branch)) return l.find((x) => x.startsWith("worktree "))?.slice(9) ?? null;
    }
    return null;
  }

  // The space on that checkout (the deepest match wins, so a worktree isn't taken for its parent).
  spaceAt(path) {
    const ps = panes();
    const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
    return spaces().filter((s) => !s.machine).find((s) => {
      const at = ps.find((x) => s.tabs.some((t) => t.id === x.tab) && x.cwd)?.cwd || s.folder || "";
      return inside(at, path) || inside(s.folder || "", path);
    }) ?? null;
  }

  // Show a thread that already exists: unsettle its tabs and show the one with an agent.
  reopen(s) {
    for (const tab of s.tabs) if (tab.settled) run("tab.unsettle", { id: tab.id });
    run("space.select", { id: s.id });
    const withAgent = s.tabs.find((tab) => tab.status) ?? s.tabs.find((tab) => tab.active) ?? s.tabs[0];
    if (withAgent) run("tab.select", { id: withAgent.id });
  }

  async openThread(p, repo) {
    // Same-repo PRs use their own branch; a fork's is fetched as pr-<n>-<branch>.
    const branch = p.fork ? "pr-" + p.number + "-" + slug(p.head) : p.head;
    let path = await this.checkoutOf(repo, branch);
    if (path) {
      // Already checked out somewhere: its thread, settled or not, is the one to show.
      const s = this.spaceAt(path);
      if (s) { this.reopen(s); return; }
      run("space.new", { folder: path, machine: "", ...((await this.agentArgv()) ? { argv: await this.agentArgv() } : {}) });
      return;
    }
    path = home() + "/.herdr/worktrees/" + repo.name + "/" + slug(branch);
    let r;
    if (!p.fork) {
      r = await git(repo.path, ["fetch", "origin", "+refs/heads/" + p.head + ":refs/remotes/origin/" + p.head], 120000);
      if (!r.ok) throw new Error(r.err || "git fetch failed.");
      const has = (await git(repo.path, ["show-ref", "--verify", "--quiet", "refs/heads/" + p.head])).ok;
      r = await git(repo.path, has ? ["worktree", "add", path, p.head] : ["worktree", "add", "--track", "-b", p.head, path, "origin/" + p.head], 600000);
    } else {
      r = await git(repo.path, ["fetch", "origin", "+refs/pull/" + p.number + "/head:refs/heads/" + branch], 120000);
      if (!r.ok) throw new Error(r.err || "git fetch failed.");
      r = await git(repo.path, ["worktree", "add", path, branch], 600000);
    }
    if (!r.ok) throw new Error(r.err || "git worktree add failed.");
    const argv = await this.agentArgv();
    run("space.new", { folder: path, machine: "", ...(argv ? { argv } : {}) });
  }

  // Which PRs have a thread now: "open", "settled", or a checkout with no space ("checkout").
  threadState(p) {
    const repo = this.repos[p.repo];
    const path = repo && this.checkouts[p.repo]?.[p.fork ? "pr-" + p.number + "-" + slug(p.head) : p.head];
    if (!path) return null;
    const s = this.spaceAt(path);
    if (!s) return "checkout";
    return s.tabs.length && s.tabs.every((t) => t.settled) ? "settled" : "open";
  }

  // ---- keys ----

  key(e, cx) {
    const m = e.modifiers ?? {};
    const k = e.key;
    const rows = this.shown();
    const n = rows.length;
    const move = (by) => { if (n) { this.at = Math.max(0, Math.min(n - 1, this.at + by)); this.scroll.scroll_to_item(this.rowIndex(rows, this.at)); } };
    if (k === "escape") return this.close();
    if (k === "down" || (m.control && (k === "j" || k === "n"))) move(1);
    else if (k === "up" || (m.control && (k === "k" || k === "p"))) move(-1);
    else if (k === "pagedown") move(10);
    else if (k === "pageup") move(-10);
    else if (k === "tab") {
      const i = VIEWS.findIndex((v) => v[0] === this.view);
      this.view = VIEWS[(i + (m.shift ? VIEWS.length - 1 : 1)) % VIEWS.length][0];
      setShared("pulls.view", this.view);
      this.at = 0;
    }
    else if (m.control && k === "r") this.refresh(cx);
    else if (m.control && k === "o" && rows[this.at]) exec("xdg-open", [rows[this.at].url]).catch(() => {});
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // The list's child index of row i (group headers come first in each group).
  rowIndex(rows, i) {
    let headers = 0, last = null;
    for (let j = 0; j <= i; j++) { const g = this.group(rows[j]); if (g !== last) { headers++; last = g; } }
    return i + headers;
  }

  // ---- drawing ----

  chip(t, id, label, key, value, on) {
    return h_flex().id("chip-" + id).flex_none().h(24).px(8).gap(5).rounded(6).items_center().cursor_pointer().text_size(12)
      .border_1().border_color(on ? t.accent : t.border).when(on, (el) => el.bg(t.selected)).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.toggle(key, value, cx))
      .child(label);
  }

  row(t, p, i) {
    const on = i === this.at;
    const g = colorOf(p.repo);
    const review = p.review === "APPROVED" ? ["user-check", t.ansi2, "Approved"] : p.review === "CHANGES_REQUESTED" ? ["user-x", t.blocked, "Changes requested"] : p.review === "REVIEW_REQUIRED" ? ["user", t.dim, "Review required"] : null;
    const check = p.ci === "pass" ? svg(I("circle-check")).size(14).flex_none().text_color(t.ansi2)
      : p.ci === "fail" ? svg(P("circle-x")).size(14).flex_none().text_color(t.blocked)
      : p.ci === "pending" ? svg(I("spinner")).size(13).flex_none().text_color(t.working).spin(1200) : null;
    const opening = this.busy === p.url;
    const state = this.threadState(p);
    return v_flex().id("pr-" + p.url).flex_none().px(12).py(7).gap(2).rounded(8).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.at = i; this.open(p, cx); })
      .child(h_flex().gap(8).items_center().text_size(14)
        .child(svg(P(p.draft ? "git-pull-request-draft" : "git-pull-request")).size(16).flex_none().text_color(p.draft ? t.dim : t.ansi2))
        .child(div().flex_none().text_color(t.dim).child("#" + p.number))
        .child(div().flex_shrink_1().min_w(0).truncate().text_color(t.foreground).child(p.title))
        .when(Boolean(check), (el) => el.child(div().id("ci-" + p.url).flex_none().tooltip("Checks " + (p.ci === "pass" ? "passing" : p.ci === "fail" ? "failing" : "running")).child(check)))
        .when(Boolean(review), (el) => el.child(div().id("rv-" + p.url).flex_none().tooltip(review[2]).child(svg(P(review[0])).size(14).text_color(review[1]))))
        .child(div().flex_1())
        .when(opening, (el) => el.child(h_flex().flex_none().gap(5).items_center().text_size(12).text_color(t.working).child(svg(I("spinner")).size(12).spin(900)).child("Opening…")))
        .when(!opening, (el) => el.child(h_flex().flex_none().gap(5).text_size(12.5).child(div().text_color(t.ansi2).child("+" + num(p.adds))).child(div().text_color(t.ansi1).child("-" + num(p.dels))))))
      .child(h_flex().gap(8).items_center().pl(24).text_size(12.5).text_color(t.dim)
        .child(div().flex_none().text_color(p.author === this.me ? t.muted : t.dim).child(p.author))
        .child(h_flex().flex_none().gap(5).items_center().child(div().size(7).rounded(2).bg(g)).child(p.repo))
        .child(div().flex_shrink_1().min_w(0).truncate().child(p.head))
        .when(Boolean(state), (el) => el.child(h_flex().id("th-" + p.url).flex_none().gap(4).px(6).h(18).rounded(5).items_center().text_size(11.5)
          .bg(state === "open" ? t.accent + "26" : t.hover).text_color(state === "open" ? t.accent : t.muted)
          .tooltip(state === "open" ? "Has a thread: Enter shows it" : state === "settled" ? "Its thread is settled: Enter brings it back" : "Checked out without a thread: Enter opens one there")
          .child(state === "open" ? "thread" : state === "settled" ? "settled thread" : "checked out")))
        .child(div().flex_1())
        .child(div().flex_none().child(ago(p.updated))));
  }

  render(cx) {
    const t = theme();
    const rows = this.shown();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const f = this.parse();
    const counts = { all: this.prs.length, authored: 0, review: 0, others: 0 };
    for (const p of this.prs) counts[this.group(p)]++;
    const LABEL = { authored: ["Authored", "square-pen"], review: ["Review requested", "user"], others: ["Others", "layers"] };
    const children = [];
    let last = null;
    rows.forEach((p, i) => {
      const g = this.group(p);
      if (g !== last) {
        last = g;
        const n = rows.filter((x) => this.group(x) === g).length;
        children.push(h_flex().flex_none().h(34).px(12).pt(8).gap(8).items_center().text_size(12.5).text_color(t.dim)
          .child(svg(LABEL[g][1] === "user" ? P("user") : I(LABEL[g][1])).size(13))
          .child(LABEL[g][0]).child(div().text_color(t.dim).child(String(n))).child(div().flex_1().h(1).bg(t.border)));
      }
      children.push(this.row(t, p, i));
    });
    return v_flex().id("pulls").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().p(16).gap(10).bg(t.popover).text_size(13)
      // Search
      .child(h_flex().flex_none().gap(8).items_center()
        .child(h_flex().flex_1().h(36).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
          .child(this.loading ? svg(I("spinner")).size(15).flex_none().text_color(t.muted).spin(900) : svg(I("search")).size(15).flex_none().text_color(t.dim))
          .child(Input.new(this.input).flex_1().h(34).items_center().text_color(t.foreground)))
        .child(h_flex().id("refresh").flex_none().size(36).rounded(8).border_1().border_color(t.border).items_center().justify_center()
          .cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground)).tooltip("Refresh (ctrl-r)")
          .on_click((_e, cx) => this.refresh(cx)).child(svg(P("refresh")).size(15))))
      // Views and filter chips
      .child(h_flex().flex_none().gap(6).items_center().flex_wrap()
        .children(VIEWS.map(([id, label]) => h_flex().id("view-" + id).flex_none().h(24).px(8).gap(6).rounded(6).items_center().cursor_pointer().text_size(12)
          .when(this.view === id, (el) => el.bg(t.selected).text_color(t.foreground)).when(this.view !== id, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
          .on_click((_e, cx) => { this.view = id; setShared("pulls.view", id); this.at = 0; this.input.focus(); cx.notify(); })
          .child(label).child(div().text_color(t.dim).child(String(counts[id])))))
        .child(div().w(1).h(16).mx(4).bg(t.border))
        .child(this.chip(t, "me", "Mine", "author", "me", f.author === "me"))
        .child(this.chip(t, "draft", "Draft", "is", "draft", f.is === "draft"))
        .child(this.chip(t, "ready", "Ready", "is", "ready", f.is === "ready"))
        .child(this.chip(t, "approved", "Approved", "review", "approved", f.review === "approved"))
        .child(this.chip(t, "changes", "Changes requested", "review", "changes", f.review === "changes"))
        .child(this.chip(t, "fail", "CI failing", "ci", "fail", f.ci === "fail"))
        .child(div().flex_1())
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child("sort: " + f.sort)))
      // List
      .child(div().relative().flex_1().min_h(0)
        .child(v_flex().id("pr-list").size_full().overflow_y_scroll().track_scroll(this.scroll).children(children)
          .when(rows.length === 0, (el) => el.child(div().p(16).text_color(t.dim)
            .child(this.loading && !this.prs.length ? "Loading pull requests…" : this.prs.length ? "No pull requests match." : "No open pull requests in your projects."))))
        .child(Scrollbar.vertical("pr-list").absolute().inset_0()))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().text_color(t.blocked).child(this.error)))
      .when(this.errors.length > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.blocked).truncate().child("Couldn't list " + this.errors.join("; "))))
      .child(h_flex().flex_none().gap(12).text_size(11.5).text_color(t.dim)
        .child("↑↓ move · ↵ open thread · ctrl-o on GitHub · tab view · ctrl-r refresh · esc close")
        .child(div().flex_1())
        .child(this.fetchedAt ? "updated " + ago(new Date(this.fetchedAt).toISOString()).replace(" ago", "") + " ago" : ""));
  }
}
