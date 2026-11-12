// Modified from Herdr's shipped "changes" mod (0.1.8), Apache License 2.0.
// Changes by Vytas Gavelis, MIT License. See LICENSE and THIRD-PARTY-NOTICES.
//
// Changes, for code review: the diff rows are syntax colored (highlight.js,
// palette.js), and the diff is reviewed like a pull request: click a line
// (two clicks for a range, a @@ header for its hunk) to open the comment
// box, add the comment, and it sits inline under those lines; comments can be
// added on several files; the comment icon on a file row comments on the
// file as a whole (an image, a deleted file). "Submit
// review" sends every comment with its
// lines to the space's agent as one message (ask.js); right-click a line to
// ask about it at once instead. Esc closes the comment box.
// The comment box is a card floating over the top-right of the diff (a
// strip under it when the panel is narrow), so the rows never move: a
// list row may hold no input, so the box can't sit between the lines.
// Keyboard: the panel is focusable (pane.go, alt-h/j/k/l, moves onto it);
// a cursor walks the diff rows and comment cards (f moves it to the file
// list: j/k pick a file, Enter or l opens it), and `?` lists the keys.
// Commands: "reviewer.submit", "reviewer.ask" (about the whole
// diff), "reviewer.clear" (drops the draft comments), "reviewer.focus"
// (takes the keyboard); in the send dialog (dialog.js) "reviewer.send"
// and "reviewer.close".
// The scope bar under the header chooses what is reviewed: "Changes", a
// source → target comparison (the pull-request view; both ends pickable from
// the repo's branches, automatic by default: the current branch with its
// uncommitted changes against the base branch, or the upstream when on the
// base), the uncommitted changes, or the latest commit plus them;
// "reviewer.scope" cycles it.
// Props: { palette: "one-dark-pro" | "theme" | "dark-plus" (default: one-dark-pro),
//          font_size: px (default: the terminal's font size minus one),
//          base: the branch reviews are against (default: origin/HEAD, else main, else master) }.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, v_virtual_list, VirtualListScrollHandle, Popover } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, nextCommand, props, shared, setShared } from "herdr";
import { tokenize, languageOf } from "./highlight.js";
import { ask } from "./ask.js";
import { palette } from "./palette.js";
import { Dialog } from "./dialog.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // A shell whose folder was deleted reports its cwd with Linux's " (deleted)" on the end.
  const cwd = (pane?.cwd || f?.cwd || space?.folder)?.replace(/ \(deleted\)$/, "");
  return { cwd, on, folder: space?.folder ?? null };
}
const key = () => { const { cwd, on } = location(); return JSON.stringify({ cwd, on }); };
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const NONE = "#00000000", SENT = "reviewer.sent", DRAFTS = "reviewer.drafts", SCOPE = "reviewer.scope", HANDOFF = "reviewer.handoff", REFS = "reviewer.refs";
// The review scopes, in picker order.
const SCOPES = ["branch", "work", "last"];
const MISSING = /os error 2|No such file or directory/;
// Diff rows a comment can sit on (not hunk headers or notes like "Binary file").
const LINE = new Set(["+", "-", " "]);
// The panel's keys, as the `?` card lists them.
const KEYS = [
  ["f", "switch between files and diff"], ["j k  ↓ ↑", "move"], ["shift + move", "select lines"], ["] [", "next / previous hunk"], ["n p", "next / previous file"],
  ["g G", "top / bottom"], ["ctrl-d ctrl-u", "half a page"], ["c  Enter", "comment (edits a comment)"], ["C", "comment on the whole file"],
  ["d", "delete the comment"], ["a", "ask about the line or selection"], ["A", "ask about the whole diff"], ["s", "submit review"],
  ["D D", "discard every comment"], ["v", "switch scope"], ["m", "commit message"], ["h", "to the files"], ["Enter  l", "in files: open the file"], ["Esc", "clear selection, close"], ["alt-h/j/k/l", "leave the panel"],
];
// The code font: the terminal's (`font` in settings, JetBrains Mono when
// unset), one size smaller than the terminal (`font_size`, 14 when unset);
// `props.font_size` overrides. Rows and widths scale with it.
const codeFont = () => (typeof settings().font === "string" && settings().font) || "JetBrains Mono";
const codeSize = () => Number(props()?.font_size) || Math.max(9, (Number(settings().font_size) || 14) - 1);
const rowOf = (size) => Math.round(size * 1.8);
const charOf = (size) => size * 0.62;

// A row's identity across reloads: its kind, number and text.
const desc = (r) => ({ kind: r.kind, number: r.number ?? null, text: r.text });
const descKey = (d) => `${d.kind}|${d.number}|${d.text}`;

// Numbers each diff line once and tokenizes it, so a frame only draws the rows on screen.
function diffRows(lines, lang) {
  let old = 0, next = 0, state = null, hunk = -1;
  return lines.map((line, i) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; state = null; hunk = i; return { kind: "@", text: line, hunk: i, spans: [{ text: line, cls: "" }] }; }
    const kind = line[0];
    let row;
    if (kind === "-") row = { kind, number: old++, text: line.slice(1) || " " };
    else if (kind === "+") row = { kind, number: next++, text: line.slice(1) || " " };
    else if (kind === " ") { old++; row = { kind, number: next++, text: line.slice(1) || " " }; }
    else row = { kind: "", text: line };
    row.hunk = hunk;
    const t = tokenize(row.text.replace(/\t/g, "    "), lang, state);
    row.spans = t.spans; state = t.state;
    return row;
  });
}

export default class Changes extends View {
  init(_props, cx) {
    // Opened as the send dialog (ask.js): this copy is the dialog, nothing else.
    if (props()?.dialog) { this.dialog = Object.create(Dialog.prototype); this.dialog.init(_props, cx); return; }
    this.files = []; this.rows = []; this.index = new Map(); this.items = []; this.sizes = []; this.diffWidth = 0; this.gutter = 30; this.message = "";
    this.comments = []; this.composer = null; this.handle = cx.focus_handle(); this.scroll = VirtualListScrollHandle.new();
    this.fontSize = codeSize(); this.row = rowOf(this.fontSize);
    this.scope = "work"; this.scopeInfo = null; this.choosingScope = false; this.ref = "HEAD"; this.range = ["HEAD"]; this.tree = true; this.draftId = null;
    // The source / target ref pickers: which one is open, the repo's refs, the search field.
    this.choosingRef = null; this.refList = null; this.refQuery = "";
    // The file list's dragged height (null: fitted to the files) and the drag in progress.
    this.drag = null; this.listH = null;
    // Refreshes: the current one's number (older ones are dropped), the repo top per folder, and when the watcher may count gitdir changes again.
    this.gen = 0; this.tops = new Map(); this.quietUntil = 0;
    // Which part the keyboard walks ("diff" or "files", f switches; Tab is left to the app, which moves focus to the commit message) and the file under the files cursor.
    this.zone = "diff"; this.fileCursor = null; this.filesScroll = VirtualListScrollHandle.new();
    try { const h = Number(localStorage.getItem("listHeight")); if (h > 0) this.listH = h; } catch {}
    this.refSearch = InputState.new({ placeholder: "Search refs…" });
    this.refSearch.on("change", (_e, cx) => { this.refQuery = this.refSearch.value(); cx.notify(); });
    this.refSearch.on("submit", (_e, cx) => { const first = this.refMatches()[0]; if (this.choosingRef && first) this.setRef(this.choosingRef, first.name, cx); });
    this.refSearch.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.refSearch.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    // The keyboard cursor ({ row: descriptor } or { comment: id }), the range anchor (a row descriptor), the `?` card.
    this.cursor = null; this.anchor = null; this.keysHelp = false; this.wantFirst = false; this.discardAt = 0; this.flash = null;
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.note = TextareaState.new({ placeholder: "Leave a comment on these lines…", rows: 4 });
    this.note.set_auto_grow(4, 14);
    // Enter adds; shift-enter is the textarea's own newline, so its submit is ignored.
    this.note.on("submit", (e, cx) => { if (!e?.shift) this.addComment(cx); });
    this.note.on("change", (_e, cx) => { this.noteText = this.note.value(); if (this.composer?.editing) this.rebuild(); cx.notify(); });
    this.note.on("focus", (_e, cx) => { this.noteFocused = true; cx.notify(); });
    this.note.on("blur", (_e, cx) => { this.noteFocused = false; cx.notify(); });
    this.noteText = "";
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "ask") this.askAbout(null, cx);
        else if (c === "submit") this.submit(cx);
        else if (c === "clear") this.setComments([], cx);
        else if (c === "scope") this.cycleScope(cx);
        else if (c === "focus") this.takeFocus();
        cx.notify();
      }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          const paths = await watchFolder(root);
          if (this.watched !== root) break;
          // The panel's own git calls touch the gitdir (git status takes index.lock, and may
          // rewrite the index): left in, every refresh would start the next one. Lock files
          // never count; other gitdir changes don't while a refresh runs or just after it.
          const ours = this.loading || Date.now() < this.quietUntil;
          if (paths.some((p) => !p.endsWith(".lock") && !(ours && /\/\.git(\/|$)/.test(p)))) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  // `force`: a new scope or refs, which replaces a refresh in flight instead of
  // waiting for it. A new place (another space, pane or folder) always does: the
  // old refresh's results are dropped (`gen`), so a switch never waits on the last space.
  refresh(cx, force = false) {
    if (this.busy) { this.again = true; return; }
    const { cwd, on, folder } = location(), context = key();
    if (this.loading && context === this.context && !force) { this.again = true; return; }
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null; this.comments = []; this.composer = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note_ = null; this.watched = null; this.closed = false; this.limited = false;
    }
    const gen = ++this.gen;
    if (!cwd) { this.loading = false; return; }
    this.loading = true; this.again = false;
    const stale = () => gen !== this.gen || key() !== context;
    cx.spawn(async (cx) => {
      try {
        // The repo's top folder, remembered per folder. A terminal left in a deleted folder
        // (a removed worktree) can't run git there: the space's folder is tried instead.
        const topKey = `${on ?? ""}|${cwd}`;
        let root = this.tops.get(topKey);
        if (!root) {
          const toplevel = (dir) => exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, on });
          let top;
          try { top = await toplevel(cwd); }
          catch (e) {
            if (!MISSING.test(String(e)) || !folder || folder === cwd) throw e;
            top = await toplevel(folder).catch(() => { throw e; });
          }
          if (stale()) return;
          if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
          root = top.stdout.trim(); this.tops.set(topKey, root);
        }
        const git = (args) => exec("git", args, { cwd: root, on });
        // The status and the repo's scopes at once (the scopes run their own git calls in parallel).
        const scopeKey = `${on ?? ""}:${root}`, remembered = (shared(SCOPE) ?? {})[scopeKey];
        const [status, info] = await Promise.all([git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]), this.scopes(git, scopeKey)]);
        if (stale()) return;
        if (status.code !== 0) throw new Error(status.stderr);
        const hasHead = info.head !== null;
        let scope = root === this.root ? this.scope : (remembered ?? (info.ahead ? "branch" : "work"));
        if (scope === "branch" && !info.merge) scope = "work";
        if (scope === "last" && !info.last) scope = "work";
        // `range`: the revisions given to git diff. One revision is diffed against the working
        // tree; a picked source is two commits, merge base to source, and the working tree is left out.
        const tree = !(scope === "branch" && info.source);
        const range = scope === "branch" ? (info.source ? [info.merge, info.source] : [info.merge]) : scope === "last" ? [`${info.last}~1`] : ["HEAD"];
        const ref = range.join(" ");
        // Each scope keeps its own comments, and so does each picked source → target.
        const draftId = scope === "branch" && info.picked ? `branch:${info.source ?? ""}..${info.pickedTarget ?? ""}` : scope;
        // Files: what differs from the scope's ref, plus untracked files and conflicts from the status.
        const stats = {}, changed = new Map();
        const [numstats, names] = await Promise.all(hasHead
          ? [Promise.all([git(["diff", ...range, "--numstat", "-z", "--no-renames"])]), git(["diff", ...range, "--name-status", "-z", "--no-renames"])]
          : [Promise.all([git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), git(["diff", "--numstat", "-z", "--no-renames"])]), null]);
        if (stale()) return;
        for (const result of numstats) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        if (names) {
          if (names.code !== 0) throw new Error(names.stderr);
          const parts = names.stdout.split("\0");
          for (let i = 0; i + 1 < parts.length && parts[i]; i += 2) changed.set(parts[i + 1], parts[i][0]);
        }
        const entries = tree ? status.stdout.split("\0").filter(Boolean) : [];
        for (const entry of entries) {
          const xy = entry.slice(0, 2), path = entry.slice(3);
          if (xy === "??") changed.set(path, "?");
          else if (xy.includes("U") || xy === "AA" || xy === "DD") changed.set(path, "U");
          else if (!hasHead) changed.set(path, xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M");
        }
        const files = [];
        for (const [path, s0] of [...changed.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 1000)) {
          const fresh = s0 === "?", s = fresh ? "A" : s0 === "D" || s0 === "A" || s0 === "U" ? s0 : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (root !== this.root || scope !== this.scope || ref !== this.ref) { this.setLines([]); }
        const changedSet = root !== this.root || draftId !== this.draftId;
        this.root = root; this.on = on; this.hasHead = hasHead; this.scope = scope; this.scopeInfo = info; this.ref = ref; this.range = range; this.tree = tree; this.draftId = draftId;
        // Switching scope or refs swaps the comment set; the others stay saved.
        if (changedSet) { this.comments = this.loadDrafts(draftId); this.composer = null; this.rebuild(); }
        this.files = files; this.limited = changed.size > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        // The file list shows now; the open file's diff follows.
        cx.notify();
        if (this.open) {
          try { await this.load(this.open, context, gen); }
          catch { if (!stale()) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) {
        if (stale()) return;
        this.tops.clear();
        this.root = null; this.files = []; this.setLines([]); this.open = null;
        this.error = MISSING.test(String(e)) ? `Folder not found: ${cwd}` : String(e);
      }
      finally {
        if (gen === this.gen) {
          this.loading = false; this.quietUntil = Date.now() + 500; cx.notify();
          if (this.again) { this.again = false; cx.timer.after(1, (cx) => this.refresh(cx)); }
        }
      }
    });
  }

  // The draft comments of one scope of the shown repo. Drafts saved before
  // scopes existed (keyed by repo alone) were all on the uncommitted changes.
  draftKey(id = this.draftId ?? this.scope) { return `${this.on ?? ""}:${this.root}:${id}`; }
  loadDrafts(id) {
    const drafts = { ...(shared(DRAFTS) ?? {}) }, old = `${this.on ?? ""}:${this.root}`;
    if (drafts[old]) { drafts[`${old}:work`] = [...(drafts[`${old}:work`] ?? []), ...drafts[old]]; delete drafts[old]; setShared(DRAFTS, drafts); }
    return drafts[this.draftKey(id)] ?? [];
  }

  // What this repo can be reviewed against: its branch; the base branch
  // (props.base, else origin/HEAD, else main, else master); the source and
  // target picked for "Changes" (null: automatic, the current branch with
  // its uncommitted changes, and the base, or the upstream when on the base);
  // their merge base; and HEAD's short hash when it has a parent.
  async scopes(git, repo) {
    const out = async (args) => { const r = await git(args); return r.code === 0 ? r.stdout.trim() : null; };
    const exists = async (ref) => Boolean(ref) && (await out(["rev-parse", "--verify", "-q", `${ref}^{commit}`])) !== null;
    const picked = (shared(REFS) ?? {})[repo] ?? {}, propBase = typeof props()?.base === "string" ? props().base : null;
    // Everything that needs nothing else, at once.
    const [branch, head, originHead, parent, short, subject, source0, target0, upstream, hasMain, hasMaster] = await Promise.all([
      out(["rev-parse", "--abbrev-ref", "HEAD"]), out(["rev-parse", "--verify", "-q", "HEAD"]),
      propBase ? null : out(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]),
      out(["rev-parse", "--verify", "-q", "HEAD~1"]), out(["rev-parse", "--short", "HEAD"]), out(["log", "-1", "--format=%s"]),
      // A picked ref that is gone (a deleted branch) falls back to automatic.
      exists(picked.source), exists(picked.target),
      out(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
      exists("refs/heads/main"), exists("refs/heads/master"),
    ]);
    if (head === null) return { head: null, branch: null, base: null, last: null, merge: null };
    const base = propBase ?? (originHead ? originHead.replace(/^refs\/remotes\/origin\//, "") : hasMain ? "main" : hasMaster ? "master" : null);
    // Then the automatic target, which needs the base.
    let auto = upstream;
    if (base && branch !== base) {
      const [local, remote] = await Promise.all([exists(`refs/heads/${base}`), exists(`origin/${base}`)]);
      auto = local ? base : remote ? `origin/${base}` : null;
    }
    const source = source0 ? picked.source : null, pickedTarget = target0 ? picked.target : null, target = pickedTarget ?? auto;
    // Then the merge base, which needs the target.
    const [merge, tip] = await Promise.all([target ? out(["merge-base", target, source ?? "HEAD"]) : null, source ? out(["rev-parse", source]) : head]);
    const last = parent !== null ? short : null;
    return { head, branch, base, auto, source, pickedTarget, target, picked: Boolean(source || pickedTarget), merge, ahead: Boolean(merge && merge !== tip), last, subject: last ? subject : null };
  }

  // The scope's name for the header and the submit message.
  scopeLabel(scope = this.scope) {
    return scope === "branch" ? "Changes" : scope === "last" ? "Latest commit" : "Uncommitted";
  }
  scopeWords() {
    const i = this.scopeInfo ?? {}, merge = (i.merge ?? "").slice(0, 7);
    return this.scope === "branch" ? (i.source ? `the changes on ${i.source} since it left ${i.target} (merge base ${merge}); not the working tree`
        : `all changes on ${i.branch} since it left ${i.target} (merge base ${merge}), committed or not`)
      : this.scope === "last" ? `the last commit (${i.last}${i.subject ? `, "${i.subject}"` : ""}) plus the uncommitted changes`
      : "uncommitted changes";
  }
  setScope(scope, cx) {
    if (!this.root || scope === this.scope) { this.choosingScope = false; cx.notify(); return; }
    const all = { ...(shared(SCOPE) ?? {}) }; all[`${this.on ?? ""}:${this.root}`] = scope; setShared(SCOPE, all);
    this.scope = scope; this.choosingScope = false; this.composer = null; this.cursor = null; this.anchor = null; this.wantFirst = true; this.setLines([]);
    // "Changes" drafts depend on the picked refs, so they load with the refresh.
    this.draftId = scope === "branch" ? null : scope; this.comments = this.draftId ? this.loadDrafts(scope) : []; this.rebuild();
    this.refresh(cx, true); cx.notify();
  }
  // Picks the source or target of "Changes" (null: automatic), remembered per repo.
  setRef(which, ref, cx) {
    const repo = `${this.on ?? ""}:${this.root}`, all = { ...(shared(REFS) ?? {}) }, mine = { ...(all[repo] ?? {}) };
    if (ref) mine[which] = ref; else delete mine[which];
    if (Object.keys(mine).length) all[repo] = mine; else delete all[repo];
    setShared(REFS, all);
    this.choosingRef = null; this.composer = null; this.cursor = null; this.anchor = null; this.wantFirst = true;
    this.refresh(cx, true); cx.notify();
  }
  openRefs(which, cx) {
    this.choosingRef = which; this.refQuery = ""; this.refSearch.set_value("");
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      const r = await exec("git", ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"], { cwd: root, on }).catch(() => null);
      if (r?.code === 0 && root === this.root) this.refList = r.stdout.split("\n").filter((n) => n && !n.endsWith("/HEAD"))
        .map((n) => n.startsWith("refs/heads/") ? { name: n.slice(11), remote: false } : { name: n.slice(13), remote: true });
      cx.notify();
    });
    cx.timer.after(60, () => this.refSearch.focus());
    cx.notify();
  }
  // The refs the search matches: every word of it, in any order.
  refMatches() {
    const words = this.refQuery.toLowerCase().split(/\s+/).filter(Boolean);
    return (this.refList ?? []).filter((r) => words.every((w) => r.name.toLowerCase().includes(w))).slice(0, 200);
  }
  cycleScope(cx) {
    const ok = SCOPES.filter((s) => s === "work" || (s === "last" ? this.scopeInfo?.last : this.scopeInfo?.merge));
    this.setScope(ok[(ok.indexOf(this.scope) + 1) % ok.length], cx);
  }

  async load(path, context, gen) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", ["diff", ...(this.hasHead ? this.range : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path && (gen === undefined || gen === this.gen)) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line), path);
  }

  setLines(lines, path) {
    const same = this.lines && lines.length === this.lines.length && lines.every((l, i) => l === this.lines[i]);
    if (same) return;
    this.lines = lines;
    this.rows = diffRows(lines, languageOf(path));
    this.index = new Map();
    this.rows.forEach((r, i) => { const k = descKey(desc(r)); if (!this.index.has(k)) this.index.set(k, i); });
    this.measure();
    if (this.wantFirst && this.rows.length) { this.wantFirst = false; this.toFirstChange(); }
  }

  // Sizes that depend on the font: the gutter (wide enough for the largest
  // line number), the diff's width, and the rows.
  measure() {
    const ch = charOf(this.fontSize), digits = String(Math.max(0, ...this.rows.map((r) => r.number ?? 0))).length;
    this.gutter = Math.max(30, Math.ceil(digits * ch + 10));
    this.diffWidth = Math.max(300, ...(this.lines ?? []).map((line) => Math.ceil(line.length * ch) + this.gutter + 36));
    this.rebuild();
  }

  // Where a row descriptor is in the current diff, or -1.
  at(d) { return d ? (this.index.get(descKey(d)) ?? -1) : -1; }

  // The list's items: diff rows, with each comment under its last line;
  // comments on the whole file come first. The comment being edited stays
  // in place as a live preview of what is typed in the box.
  rebuild() {
    const items = this.rows.map((_r, i) => ({ key: `r:${i}`, kind: "row", i, height: this.row }));
    const under = new Map(), editing = this.composer?.editing ?? null;
    this.items = [];
    for (const c of this.comments) {
      if (c.path !== this.open) continue;
      const live = c.id === editing, text = live ? this.noteText : c.text;
      const it = { key: `c:${c.id}`, kind: "comment", id: c.id, live, text, height: this.commentHeight(text) };
      if (c.whole) { this.items.push({ ...it, whole: true, from: -1, to: -1 }); continue; }
      const from = this.at(c.from), to = this.at(c.to);
      if (from < 0 || to < 0 || to < from) continue;
      (under.get(to) ?? under.set(to, []).get(to)).push({ ...it, from, to });
    }
    for (const item of items) { this.items.push(item); for (const c of under.get(item.i) ?? []) this.items.push(c); }
    this.sizes = this.items.map((it) => it.height);
  }

  commentHeight(text) {
    const cpl = Math.max(24, Math.floor(((this.size?.width ?? 368) - 90) / charOf(this.fontSize)));
    const lines = text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cpl)), 0);
    return 44 + lines * Math.round(this.fontSize * 1.45);
  }
  // The composer's target rows in the current diff, or null (also for a whole-file comment).
  target() {
    if (!this.composer || this.composer.whole || this.composer.path !== this.open) return null;
    const from = this.at(this.composer.from), to = this.at(this.composer.to);
    return from < 0 || to < 0 ? null : { from: Math.min(from, to), to: Math.max(from, to) };
  }

  // Click on a diff row: open the comment box there, or widen it to a range.
  clickRow(i, cx) {
    const row = this.rows[i];
    if (!row || row.kind === "") return;
    let from = i, to = i;
    if (row.kind === "@") {
      const members = this.rows.map((r, j) => j).filter((j) => j !== i && this.rows[j].hunk === i && this.rows[j].kind !== "");
      if (!members.length) return;
      from = members[0]; to = members[members.length - 1];
    }
    const t = this.target();
    if (t && !this.composer.editing && !this.noteText.trim()) {
      // A click inside the highlighted lines clears them; outside, it widens them.
      if (from >= t.from && to <= t.to) { this.closeComposer(cx); return; }
      from = Math.min(t.from, from); to = Math.max(t.to, to);
    }
    // Editing a line comment keeps its identity when retargeted; a whole-file comment stays what it is.
    const editing = this.composer?.editing && !this.composer.whole && this.composer.path === this.open ? this.composer.editing : null;
    this.composer = { path: this.open, from: desc(this.rows[from]), to: desc(this.rows[to]), editing };
    this.openBox(cx);
  }

  // Opening the box: rebuild and give the textarea the keyboard (again
  // once the frame is drawn). The list is not scrolled: what was clicked
  // is on screen already, and a scroll would make the rows jump.
  // `scrollTo`: an item index to bring on screen anyway (a whole-file
  // comment, whose card is at the top of the diff).
  openBox(cx, scrollTo = -1) {
    this.rebuild();
    this.note.focus();
    if (scrollTo >= 0) this.scroll.scroll_to_item(scrollTo);
    cx.timer.after(300, () => this.note.focus());
    cx.notify();
  }

  // Comment on a file as a whole (an image, a deleted file, anything without lines to click).
  commentFile(path, cx) {
    if (this.composer?.whole && this.composer.path === path && !this.composer.editing && !this.noteText.trim()) { this.closeComposer(cx); return; }
    if (this.open !== path) this.pick(path, cx);
    this.composer = { path, whole: true, editing: null };
    this.openBox(cx, 0);
  }

  editComment(id, cx) {
    const c = this.comments.find((c) => c.id === id);
    if (!c) return;
    this.composer = c.whole ? { path: c.path, whole: true, editing: id } : { path: c.path, from: c.from, to: c.to, editing: id };
    this.note.set_value(c.text); this.noteText = c.text;
    this.openBox(cx);
  }

  closeComposer(cx) {
    this.composer = null; this.note.set_value(""); this.noteText = ""; this.rebuild(); this.handle.focus(); cx.notify();
  }

  setComments(list, cx) {
    this.comments = list; this.rebuild();
    const drafts = { ...(shared(DRAFTS) ?? {}) }, k = this.draftKey();
    if (list.length) drafts[k] = list; else delete drafts[k];
    setShared(DRAFTS, drafts);
    cx?.notify();
  }

  addComment(cx) {
    const text = this.note.value().trim(), c = this.composer;
    if (c?.editing && !text) { this.deleteComment(cx); return; }
    if (!c || !text) return;
    const list = this.comments.filter((x) => x.id !== c.editing);
    const id = c.editing ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const comment = c.whole ? { id, path: c.path, whole: true, text } : { id, path: c.path, from: c.from, to: c.to, text };
    const t = this.target();
    if (t) { comment.from = desc(this.rows[t.from]); comment.to = desc(this.rows[t.to]); comment.quote = this.quote(this.rows.slice(t.from, Math.min(t.to, t.from + 60) + 1)); }
    else if (c.editing) { const old = this.comments.find((x) => x.id === c.editing); if (old?.quote) comment.quote = old.quote; }
    list.push(comment);
    this.setComments(list);
    this.closeComposer(cx);
  }

  deleteComment(cx) {
    const id = this.composer?.editing;
    if (id) this.setComments(this.comments.filter((c) => c.id !== id));
    this.closeComposer(cx);
  }

  // The text the agent gets for a set of rows (indexes; null: every row of the open diff).
  quote(rows) {
    return rows.map((r) => r.kind === "@" ? r.text : `${r.number === undefined ? "" : String(r.number).padStart(5)} ${r.kind || " "} ${r.text}`).join("\n");
  }
  span(rows) {
    const nums = rows.filter((r) => r.number !== undefined && r.kind !== "-").map((r) => r.number), olds = rows.filter((r) => r.kind === "-").map((r) => r.number);
    const range = (a) => a.length > 1 ? `lines ${Math.min(...a)}-${Math.max(...a)}` : `line ${a[0]}`;
    return nums.length ? range(nums) : olds.length ? `removed ${range(olds)}` : "";
  }
  where(path) { return `${this.root}/${path}${this.on ? ` (on ${this.on})` : ""}`; }
  // A file's change in words, for a whole-file comment: "added, binary".
  describe(path) {
    const f = this.files.find((f) => f.path === path);
    if (!f) return "no longer changed";
    const what = f.status === "A" ? "added" : f.status === "D" ? "deleted" : f.status === "U" ? "conflict" : "modified";
    return f.binary ? `${what}, binary` : f.add || f.del ? `${what}, +${f.add} −${f.del}` : what;
  }

  askAbout(indexes, cx) {
    if (!this.open || !this.rows.length) return;
    const rows = (indexes ? indexes.sort((a, b) => a - b).map((i) => this.rows[i]) : this.rows).filter(Boolean).slice(0, 400);
    const span = this.span(rows), title = `${this.open}${span ? `:${span.replace(/^(removed )?lines? /, "")}` : ""}`;
    const head = indexes ? `In ${this.where(this.open)}, ${span || "these lines"} of the diff (${this.scopeWords()}; new-file line numbers; - lines are removed):` : `The diff of ${this.where(this.open)} (${this.scopeWords()}):`;
    cx.spawn(async (cx) => { try { await ask({ title, context: `${head}\n${this.quote(rows)}` }); } catch (e) { this.note_ = `Ask failed: ${e}`; } cx.notify(); });
  }

  // A hunk header's rows, the header included: what a right-click or `a` on it asks about.
  hunkRows(i) { return this.rows.map((_r, j) => j).filter((j) => this.rows[j].hunk === i && this.rows[j].kind !== ""); }

  // The keyboard cursor, as an item key and index into this.items (null / -1 when it is not on screen).
  cursorKey() {
    const c = this.cursor;
    if (!c) return null;
    if (c.comment) return `c:${c.comment}`;
    const i = this.at(c.row);
    return i < 0 ? null : `r:${i}`;
  }
  cursorIndex() { const k = this.cursorKey(); return k ? this.items.findIndex((it) => it.key === k) : -1; }
  // The diff row under the cursor: a comment card counts as its last line; a whole-file comment as none.
  cursorRow() {
    const it = this.items[this.cursorIndex()];
    return !it ? -1 : it.kind === "row" ? it.i : it.whole ? -1 : it.to;
  }
  // The rows between the range anchor and the cursor, or null.
  selection() {
    if (!this.anchor) return null;
    const a = this.at(this.anchor), b = this.cursorRow();
    return a < 0 || b < 0 ? null : { from: Math.min(a, b), to: Math.max(a, b) };
  }
  setCursor(index) {
    const it = this.items[index];
    if (!it) return;
    this.cursor = it.kind === "comment" ? { comment: it.id } : { row: desc(this.rows[it.i]) };
    this.scroll.scroll_to_item(index);
  }
  toFirstChange() {
    const i = this.items.findIndex((it) => it.kind === "row" && (this.rows[it.i].kind === "+" || this.rows[it.i].kind === "-"));
    if (i >= 0) this.setCursor(i);
  }
  takeFocus() {
    // The send dialog just gave the keyboard to an agent: the "focus" its closing brings is not taken.
    const handoff = shared(HANDOFF);
    if (typeof handoff === "number" && Date.now() - handoff < 1500) return;
    if (this.composer) { this.note.focus(); return; }
    this.handle.focus();
    if (this.cursorIndex() < 0) this.toFirstChange();
  }
  // About as many rows as the diff shows at once.
  pageRows() {
    const list = this.listHeight();
    return Math.max(3, Math.floor(((this.size?.height ?? 600) - 42 - 38 - list - 53) / this.row) - 2);
  }

  // The file list's height: the one dragged on the divider (kept within the
  // panel, leaving the diff some rows), else fitted to the files up to 200px.
  listHeight() {
    const fit = Math.min(200, Math.max(44, this.files.length * 28 + 12));
    if (this.listH === null || this.listH === undefined) return fit;
    const max = Math.max(44, (this.size?.height ?? 600) - 42 - 38 - 53 - 120);
    return Math.round(Math.min(max, Math.max(44, this.listH)));
  }
  // Dragging the divider under the file list resizes it; the height is remembered across reloads.
  endDrag(cx) {
    if (!this.drag) return;
    this.drag = null;
    try { if (this.listH === null) localStorage.removeItem("listHeight"); else localStorage.setItem("listHeight", String(this.listH)); } catch {}
    cx.notify();
  }

  // Moves the cursor `delta` stops over diff rows and comment cards (rows only while
  // `extend` widens the selection); ±Infinity goes to the top or bottom.
  move(delta, extend) {
    if (!this.items.length) return;
    const ok = (it) => it.kind === "row" ? this.rows[it.i].kind !== "" : !extend;
    if (extend && !this.anchor) { const r = this.cursorRow(); if (r >= 0) this.anchor = desc(this.rows[r]); }
    if (!extend) this.anchor = null;
    const step = Math.sign(delta);
    let i = this.cursorIndex(), last = i;
    if (i < 0) i = step > 0 ? -1 : this.items.length;
    for (let n = Math.abs(delta); n > 0;) {
      i += step;
      if (i < 0 || i >= this.items.length) break;
      if (ok(this.items[i])) { last = i; n--; }
    }
    if (last >= 0) this.setCursor(last);
  }
  jumpHunk(dir) {
    for (let i = this.cursorIndex() + dir; i >= 0 && i < this.items.length; i += dir) {
      const it = this.items[i];
      if (it.kind === "row" && this.rows[it.i].kind === "@") { this.anchor = null; this.setCursor(i); return; }
    }
  }
  stepFile(dir, cx) {
    if (!this.files.length) return;
    const i = this.files.findIndex((f) => f.path === this.open), n = this.files.length;
    const next = this.files[i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n];
    if (next.path !== this.open) this.pick(next.path, cx);
  }

  // `c` / Enter: edit the comment under the cursor, or open the box on the selection, the cursor's line or its hunk.
  commentHere(cx) {
    if (this.composer) { this.note.focus(); return; }
    const it = this.items[this.cursorIndex()], sel = this.selection();
    if (!it) return;
    if (it.kind === "comment") { this.editComment(it.id, cx); return; }
    this.anchor = null;
    if (!sel || sel.from === sel.to) { this.clickRow(it.i, cx); return; }
    const lines = [];
    for (let j = sel.from; j <= sel.to; j++) if (LINE.has(this.rows[j].kind)) lines.push(j);
    if (!lines.length) return;
    this.composer = { path: this.open, from: desc(this.rows[lines[0]]), to: desc(this.rows[lines[lines.length - 1]]), editing: null };
    this.openBox(cx);
  }
  // `a`: ask about the selection, the cursor's line, its hunk, or the lines of the comment under it.
  askHere(cx) {
    const it = this.items[this.cursorIndex()], sel = this.selection();
    const span = (a, b) => Array.from({ length: b - a + 1 }, (_v, k) => a + k);
    this.anchor = null;
    if (sel) this.askAbout(span(sel.from, sel.to), cx);
    else if (!it) return;
    else if (it.kind === "comment") this.askAbout(it.whole ? null : span(it.from, it.to), cx);
    else this.askAbout(this.rows[it.i].kind === "@" ? this.hunkRows(it.i) : [it.i], cx);
  }
  // `d`: delete the comment under the cursor; the cursor goes back to its line.
  deleteHere() {
    const it = this.items[this.cursorIndex()];
    if (it?.kind !== "comment") return;
    this.setComments(this.comments.filter((c) => c.id !== it.id));
    if (it.whole) { this.cursor = null; this.move(1, false); }
    else this.cursor = { row: desc(this.rows[it.to]) };
  }
  // `D` twice within three seconds drops every draft comment.
  discardAll(cx) {
    const n = this.comments.length;
    if (!n) return;
    if (Date.now() - this.discardAt < 3000) { this.discardAt = 0; this.flash = null; this.setComments([], cx); return; }
    this.discardAt = Date.now(); this.flash = `Press D again to discard ${n} comment${n > 1 ? "s" : ""}`;
    cx.timer.after(3000, (cx) => { if (Date.now() - this.discardAt >= 3000) { this.flash = null; cx?.notify(); } });
  }

  // A key while the panel itself has the keyboard (not the commit message or the comment box). True when used.
  navKey(e, cx) {
    const m = e.modifiers ?? {}, raw = e.key ?? "", k = raw.length === 1 ? raw.toLowerCase() : raw;
    const shift = Boolean(m.shift) || (raw.length === 1 && raw !== raw.toLowerCase());
    if (m.alt || m.platform) return false;
    if (m.control) {
      if (k === "d" || k === "u") { this.move((k === "d" ? 1 : -1) * Math.ceil(this.pageRows() / 2), false); return true; }
      return false;
    }
    if (e.key_char === "?" || raw === "?" || (shift && k === "/")) { this.keysHelp = !this.keysHelp; return true; }
    if (k === "f" && !shift) { this.setZone(this.zone === "files" ? "diff" : "files"); return true; }
    if (this.zone === "files") return this.filesKey(k, shift, cx);
    switch (k) {
      case "j": case "down": this.move(1, shift); return true;
      case "k": case "up": this.move(-1, shift); return true;
      case "pagedown": this.move(this.pageRows(), shift); return true;
      case "pageup": this.move(-this.pageRows(), shift); return true;
      case "home": this.move(-Infinity, shift); return true;
      case "end": this.move(Infinity, shift); return true;
      case "g": this.move(shift ? Infinity : -Infinity, false); return true;
      case "]": this.jumpHunk(1); return true;
      case "[": this.jumpHunk(-1); return true;
      case "n": this.stepFile(1, cx); return true;
      case "p": this.stepFile(-1, cx); return true;
      case "enter": this.commentHere(cx); return true;
      case "c": if (shift) { if (this.open) this.commentFile(this.open, cx); } else this.commentHere(cx); return true;
      case "a": if (shift) this.askAbout(null, cx); else this.askHere(cx); return true;
      case "d": if (shift) this.discardAll(cx); else this.deleteHere(); return true;
      case "delete": this.deleteHere(); return true;
      case "s": this.submit(cx); return true;
      case "v": this.cycleScope(cx); return true;
      case "m": this.input.focus(); return true;
      case "h": case "left": this.setZone("files"); return true;
      case "escape":
        if (this.keysHelp) this.keysHelp = false;
        else if (this.anchor) this.anchor = null;
        else return false;
        return true;
    }
    return false;
  }

  // f: the keyboard walks the file list or the diff.
  setZone(zone) {
    this.zone = zone; this.anchor = null;
    if (zone === "files") {
      if (!this.files.some((f) => f.path === this.fileCursor)) this.fileCursor = this.open ?? this.files[0]?.path ?? null;
      this.revealFile();
    } else if (this.cursorIndex() < 0) this.toFirstChange();
  }
  // Keeps the files cursor's row fully on screen. scroll_to_item already scrolls the
  // least it can (the row to the nearest edge, nothing when it is fully visible), so
  // it is asked for the cursor's row on every move, as the diff's cursor does.
  revealFile() {
    const i = this.files.findIndex((f) => f.path === this.fileCursor);
    if (i >= 0) this.filesScroll.scroll_to_item(i);
  }
  // A key while the file list has the keyboard: j/k move, Enter or l opens the file and goes to its diff.
  filesKey(k, shift, cx) {
    const n = this.files.length, at = this.files.findIndex((f) => f.path === this.fileCursor);
    const go = (i) => { if (!n) return; this.fileCursor = this.files[Math.max(0, Math.min(n - 1, i))].path; this.revealFile(); };
    switch (k) {
      case "j": case "down": go(at < 0 ? 0 : at + 1); return true;
      case "k": case "up": go(at < 0 ? n - 1 : at - 1); return true;
      case "g": go(shift ? n - 1 : 0); return true;
      case "home": go(0); return true;
      case "end": go(n - 1); return true;
      case "pagedown": case "pageup": go(at + (k === "pagedown" ? 1 : -1) * Math.max(1, Math.floor(this.listHeight() / 28) - 1)); return true;
      case "enter": case "l": case "right": case "o":
        if (this.fileCursor) { if (this.open !== this.fileCursor) this.pick(this.fileCursor, cx); this.setZone("diff"); }
        return true;
      case "c": if (shift && this.fileCursor) this.commentFile(this.fileCursor, cx); return true;
      case "escape": case "h": case "left": this.setZone("diff"); return true;
      case "s": this.submit(cx); return true;
      case "v": this.cycleScope(cx); return true;
      case "m": this.input.focus(); return true;
      case "a": if (shift) this.askAbout(null, cx); return true;
      case "d": if (shift) this.discardAll(cx); return true;
    }
    return false;
  }

  // The `?` card: every key of the panel.
  keysCard(t) {
    return v_flex().id("keys-help").absolute().top(12).right(14).w(290).p(10).gap(3).rounded(10).border_1().border_color(t.border).bg(t.surface + "f2").shadow_lg().text_size(11.5)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.keysHelp = false; cx.notify(); })
      .child(h_flex().pb(4).child(div().font_semibold().text_size(12).child("Keys")).child(div().flex_1()).child(div().text_size(10.5).text_color(t.dim).child("? or Esc closes")))
      .children(KEYS.map(([key, what]) => h_flex().gap(8).child(div().w(96).flex_none().font_family(codeFont()).text_size(11).text_color(t.accent).child(key)).child(div().flex_1().min_w(0).text_color(t.muted).child(what))));
  }

  // Every comment, with its lines, as one review message.
  submit(cx) {
    if (!this.comments.length || !this.root) return;
    const list = [...this.comments].sort((a, b) => a.path.localeCompare(b.path) || (a.from?.number ?? -1) - (b.from?.number ?? -1));
    const parts = list.map((c) => {
      if (c.whole) return `### ${c.path}, whole file (${this.describe(c.path)})\n\nComment: ${c.text}`;
      let body;
      if (c.path === this.open) {
        const from = this.at(c.from), to = this.at(c.to);
        body = from >= 0 && to >= from ? this.quote(this.rows.slice(from, to + 1)) : null;
      }
      const span = c.from.number === c.to.number ? `line ${c.from.number}` : `lines ${c.from.number}-${c.to.number}`;
      // Lines gone from the diff: the ones captured when the comment was made.
      if (body === undefined || body === null) body = c.quote ?? (c.from.text === c.to.text ? `${String(c.from.number).padStart(5)} ${c.from.kind} ${c.from.text}` : `${String(c.from.number).padStart(5)} ${c.from.kind} ${c.from.text}\n      …\n${String(c.to.number).padStart(5)} ${c.to.kind} ${c.to.text}`);
      return `### ${c.path}, ${span}\n${body}\n\nComment: ${c.text}`;
    });
    const n = list.length, title = `Review · ${n} comment${n > 1 ? "s" : ""}`;
    const context = `Code review of ${this.root}${this.on ? ` (on ${this.on})` : ""}: ${this.scopeWords()}. ${n} comment${n > 1 ? "s" : ""}. Line numbers are new-file numbers; "-" lines are removed.\n\n${parts.join("\n\n")}`;
    this.submitting = Date.now();
    cx.spawn(async (cx) => {
      try { const r = await ask({ title, context, sent: SENT }); if (r === "sent") this.setComments([], cx); else if (r === "none") this.submitting = null; }
      catch (e) { this.note_ = `Submit failed: ${e}`; this.submitting = null; }
      cx.notify();
    });
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note_ = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note_ = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // The scope picker: a small select-looking box with the scope's name; a
  // Popover lists the scopes the repo offers, with a check on the current one.
  scopePicker(t) {
    const i = this.scopeInfo ?? {};
    const options = [
      { scope: "branch", label: "Changes", detail: i.merge ? `${i.source ?? i.branch} → ${i.target}` : "no base branch or upstream to compare against", ok: Boolean(i.merge) },
      { scope: "work", label: "Uncommitted", detail: "working tree vs HEAD", ok: true },
      { scope: "last", label: "Latest commit", detail: i.last ? `${i.last}${i.subject ? ` · ${i.subject}` : ""}, plus uncommitted` : "HEAD has no parent", ok: Boolean(i.last) },
    ];
    const box = h_flex().id("scope-box").h(24).px(8).gap(6).items_center().rounded(6).border_1().border_color(this.choosingScope ? t.accent : t.border).bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip("What is reviewed: a source → target comparison, the uncommitted changes, or the latest commit (v)").child(div().text_size(12).child(this.scopeLabel())).child(svg("mods/reviewer/chevron-down.svg").size(11).text_color(t.dim));
    return Popover.new("scope").open(this.choosingScope).on_open_change((open, cx) => { this.choosingScope = open; cx.notify(); })
      .trigger(box)
      .content(v_flex().mt(4).min_w(260).p(6).gap(2).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_md().children(options.map((o) =>
        h_flex().id(`scope-${o.scope}`).px(10).py(7).gap(10).items_center().rounded(6).when(o.ok, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setScope(o.scope, cx))).when(!o.ok, (e) => e.opacity(0.5))
          .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(12).child(o.label)).child(div().text_size(11).text_color(t.dim).truncate().child(o.detail)))
          .child(o.scope === this.scope ? svg("mods/reviewer/check.svg").size(12).text_color(t.accent) : div().w(12)))));
  }

  // A source or target picker of "Changes": the ref's name, and a Popover
  // with a search field over Automatic, the local branches and the remote ones.
  refPicker(t, which) {
    const i = this.scopeInfo ?? {}, open = this.choosingRef === which;
    const picked = which === "source" ? i.source : i.pickedTarget;
    const label = which === "source" ? (i.source ?? i.branch ?? "HEAD") : (i.target ?? "none");
    const auto = which === "source" ? `${i.branch ?? "HEAD"}, with uncommitted changes` : (i.auto ?? "none");
    const tip = which === "source" ? "Source: the branch whose changes are reviewed" : "Target: the branch the changes are compared against";
    const box = h_flex().id(`ref-${which}-box`).h(24).max_w(220).px(8).gap(6).items_center().rounded(6).border_1().border_color(open ? t.accent : picked ? t.border : NONE)
      .when(Boolean(picked) || open, (e) => e.bg(t.raised)).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip)
      .child(div().min_w(0).truncate().text_size(12).text_color(picked ? t.foreground : t.muted).child(label)).child(svg("mods/reviewer/chevron-down.svg").flex_none().size(11).text_color(t.dim));
    const row = (id, name, detail, current, action) => h_flex().id(id).flex_none().h(28).px(10).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action)
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(name))
      .when(Boolean(detail), (e) => e.child(div().flex_none().max_w(140).truncate().text_size(10.5).text_color(t.dim).child(detail)))
      .child(current ? svg("mods/reviewer/check.svg").flex_none().size(12).text_color(t.accent) : div().flex_none().w(12));
    const heading = (text) => div().flex_none().px(10).pt(8).pb(3).text_size(10).font_semibold().text_color(t.dim).child(text);
    const matches = open ? this.refMatches() : [], local = matches.filter((r) => !r.remote), remote = matches.filter((r) => r.remote);
    const list = [];
    if (!this.refQuery.trim()) list.push(row(`ref-${which}-auto`, "Automatic", auto, !picked, (_e, cx) => this.setRef(which, null, cx)));
    if (local.length) list.push(heading("BRANCHES"), ...local.map((r) => row(`ref-${which}-l-${r.name}`, r.name, r.name === i.branch ? "current" : "", picked === r.name, (_e, cx) => this.setRef(which, r.name, cx))));
    if (remote.length) list.push(heading("REMOTE"), ...remote.map((r) => row(`ref-${which}-r-${r.name}`, r.name, "", picked === r.name, (_e, cx) => this.setRef(which, r.name, cx))));
    if (!list.length) list.push(div().px(10).py(8).text_size(12).text_color(t.dim).child(this.refList ? "No matching refs" : "Loading refs…"));
    return Popover.new(`ref-${which}`).open(open).on_open_change((o, cx) => { if (o) this.openRefs(which, cx); else { this.choosingRef = null; cx.notify(); } })
      .trigger(box)
      .content(v_flex().mt(4).w(340).p(6).gap(4).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_md()
        .child(div().h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.input).bg(t.background).child(Input.new(this.refSearch).w_full().text_size(12).text_color(t.foreground)))
        .child(v_flex().id(`ref-${which}-list`).max_h(320).overflow_y_scrollbar().children(list)));
  }

  // A panel under 600px has no room for a column beside the diff.
  narrow() { return (this.size?.width ?? 368) < 600; }

  // The comment box: title, the lines it is about, the textarea, Add / Cancel / Delete.
  // `docked`: a strip under the diff (narrow panel) instead of a 300px card over its top-right.
  box(t, target, docked) {
    const c = this.composer, editing = Boolean(c.editing);
    const where = c.whole ? `whole file (${this.describe(c.path)})` : target ? (target.from === target.to ? `line ${this.rows[target.from].number ?? ""}` : `lines ${this.rows[target.from].number}–${this.rows[target.to].number}`) : "those lines are no longer in the diff";
    const hint = [c.whole ? "Click a line to comment on lines instead." : editing ? "" : "Click a line to widen the range; click a highlighted line to clear it.", "Enter adds, shift-enter starts a new line, Esc cancels.", editing ? "Clear the text and press Enter to delete the comment." : ""].filter(Boolean).join("\n");
    // Every press inside the box stops here: the box floats over the list, and a click that
    // fell through to the row underneath would reopen the box the moment Add closed it.
    const stop = (action) => (e, cx) => { cx.stop_propagation(); action(e, cx); };
    const button = (id, label, primary, action, tip) => div().id(id).h(26).px(10).flex().items_center().rounded(6).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(11).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(stop(action)).tooltip(tip).child(label);
    const link = (id, label, color, action, tip) => div().id(id).h(26).px(7).flex().items_center().rounded(6).text_size(11).text_color(color).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(stop(action)).tooltip(tip).child(label);
    return v_flex().id("comment-box").flex_none().gap(8).p(10).text_size(12).when(docked, (e) => e.bg(t.surface))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_up("left", (_e, cx) => { this.endDrag(cx); cx.stop_propagation(); }).on_click((_e, cx) => cx.stop_propagation())
      .when(!docked, (e) => e.absolute().top(12).right(14).w(300).rounded(10).border_1().border_color(t.border).bg(t.surface + "eb").shadow_lg())
      .when(docked, (e) => e.w_full().border_t(1).border_color(t.border))
      .child(h_flex().items_center().gap(6)
        .child(div().font_semibold().child(editing ? "Edit comment" : "Comment"))
        // The how-to lives on this "?": a tooltip on hover, and a click shows it in the box.
        .child(div().id("comment-help").size(16).flex().items_center().justify_center().rounded(8).border_1().border_color(this.help ? t.accent : t.border).text_size(10).text_color(this.help ? t.accent : t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground).border_color(t.foreground)).tooltip(hint)
          .on_click(stop((_e, cx) => { this.help = !this.help; cx.notify(); })).child("?"))
        .child(div().flex_1())
        .child(div().id("comment-close").size(20).flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(stop((_e, cx) => this.closeComposer(cx))).tooltip("Close (Esc)").child("×")))
      .child(div().text_size(11).text_color(t.dim).whitespace_normal().child(`${c.path.split("/").pop()} · ${where}`))
      .when(Boolean(this.help), (e) => e.child(v_flex().gap(2).px(8).py(6).rounded(6).bg(t.raised).text_size(10.5).text_color(t.dim).children(hint.split("\n").map((l) => div().whitespace_normal().child(l)))))
      .child(div().w_full().child(Textarea.new(this.note).w_full().px(8).py(6).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground)))
      .child(h_flex().items_center().gap(6).flex_wrap()
        .child(button("comment-add", editing ? "Save" : "Add comment", true, (_e, cx) => this.addComment(cx), "Enter"))
        .child(link("comment-cancel", "Cancel", t.dim, (_e, cx) => this.closeComposer(cx), "Esc"))
        .when(editing, (e) => e.child(div().flex_1()).child(link("comment-delete", "Delete", t.ansi1, (_e, cx) => this.deleteComment(cx), "Remove this comment from the review"))));
  }

  item(it, t, colors, target, commented, nav) {
    const width = (this.size?.width ?? 368) - 60, here = nav.key === it.key;
    if (it.kind === "comment") {
      const span = it.whole ? "whole file" : it.from === it.to ? `line ${this.rows[it.from].number}` : `lines ${this.rows[it.from].number}–${this.rows[it.to].number}`;
      const label = it.live ? `Comment · ${span} · editing` : here ? `Comment · ${span} · Enter to edit · d to delete` : `Comment · ${span} · click to edit`;
      return div().w_full().h(it.height).flex_none().pl(42).pr(12).py(4).cursor_pointer()
        .child(v_flex().max_w(width).rounded(8).border_1().border_color(it.live || here ? t.accent : t.accent + "66").bg(here ? t.selected : t.surface).px(10).py(6).gap(3)
          .child(div().text_size(10).text_color(it.live || here ? t.accent : t.dim).child(label))
          .child(div().text_size(this.fontSize).whitespace_normal().text_color(it.text ? t.foreground : t.dim).child(it.text || "(empty)")));
    }
    const { kind, number, spans } = this.rows[it.i], i = it.i;
    const on = (target && i >= target.from && i <= target.to) || (nav.sel && i >= nav.sel.from && i <= nav.sel.to), mark = commented.has(i);
    if (kind === "@") {
      return h_flex().w_full().h(this.row).flex_none().items_center().cursor_pointer().bg(here ? t.selected : t.raised).border_l(2).border_color(on || here ? t.accent : NONE)
        .child(div().w(this.gutter + 16).flex_none()).child(div().flex_1().min_w(0).truncate().text_color(here ? t.foreground : t.dim).child(spans[0].text));
    }
    // Added and removed rows get a clear tint (stronger when targeted), a
    // colored sign column and a tinted gutter, like a GitHub diff.
    const tint = kind === "+" ? colors.added : kind === "-" ? colors.removed : null;
    return h_flex().w_full().h(this.row).flex_none().cursor_pointer().border_l(2).border_color(on || here ? t.accent : mark ? t.accent + "66" : NONE)
      .when(Boolean(tint), (e) => e.bg(tint + (on ? "5c" : "30")))
      .when(!tint && on, (e) => e.bg(t.selected))
      .child(div().w(this.gutter).flex_none().text_right().pr(4).when(Boolean(tint), (e) => e.bg(tint + "26")).when(here, (e) => e.bg(t.accent + "66").font_bold())
        .text_color(on || here ? t.foreground : tint ? t.foreground + "cc" : t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(16).flex_none().text_center().font_bold().text_color(tint ?? NONE).child(kind === "+" ? "+" : kind === "-" ? "−" : " "))
      .child(h_flex().flex_1().min_w(0).whitespace_nowrap().children(spans.map((s) => s.cls ? div().text_color(colors[s.cls] ?? t.foreground).child(s.text) : div().child(s.text))));
  }

  render(cx) {
    if (this.dialog) return this.dialog.render(cx);
    if (key() !== this.context) this.refresh(cx);
    const size = codeSize();
    if (size !== this.fontSize) { this.fontSize = size; this.row = rowOf(size); this.measure(); }
    // The dialog reports a sent review through a shared key; the draft goes.
    const sentAt = shared(SENT);
    if (this.submitting && typeof sentAt === "number" && sentAt >= this.submitting) { this.submitting = null; cx.timer.after(1, (cx) => this.setComments([], cx)); }
    const t = theme(), colors = palette(props()?.palette, t), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const target = this.target(), n = this.comments.length, canAsk = Boolean(this.open && this.rows.length);
    // The cursor shows while the panel itself has the keyboard; the comment box has its own highlight.
    const nav = this.composer || !this.handle.is_focused() || this.zone === "files" ? { key: null, sel: null } : { key: this.cursorKey(), sel: this.selection() };
    // The files cursor shows while the panel has the keyboard and f put it on the file list.
    const fileNav = !this.composer && this.handle.is_focused() && this.zone === "files";
    const commented = new Set();
    for (const it of this.items) if (it.kind === "comment") for (let j = it.from; j <= it.to; j++) commented.add(j);
    const perFile = {};
    for (const c of this.comments) perFile[c.path] = (perFile[c.path] ?? 0) + 1;
    const button = (id, label, primary, action) => div().id(id).h(24).px(10).flex().items_center().rounded(6).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(12).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action).child(label);
    const link = (id, label, action) => div().id(id).h(24).px(8).flex().items_center().rounded(6).text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(label);
    // The accent border of a focused pane: while the panel, its comment box or its commit message has the keyboard.
    return v_flex().id("changes").size_full().min_h(0).relative().overflow_hidden().bg(t.background).border_1()
      .border_color(this.typing || this.noteFocused ? t.accent : t.border).focus((s) => s.border_color(t.accent)).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => { const w = this.size?.width; this.size = size; if (w !== size.width) { this.rebuild(); cx.notify(); } })
      // The divider drag: moves resize the file list; a release, or the pointer leaving the panel, ends it.
      .on_mouse_move((e, cx) => { if (!this.drag) return; this.listH = this.drag.h + (e.position.y - this.drag.y); cx.notify(); })
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_hover((over, cx) => { if (!over) this.endDrag(cx); })
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "escape" && this.composer) { this.closeComposer(cx); cx.stop_propagation(); }
        else if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control) && this.composer) { this.addComment(cx); cx.stop_propagation(); }
        // Single-letter keys only while nothing that takes text has the keyboard.
        else if (!this.typing && !this.composer && this.handle.is_focused() && this.navKey(e, cx)) { cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().h(24).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .when(n > 0, (e) => e.child(link("review-discard", "Discard", (_e, cx) => this.setComments([], cx))).child(button("review-submit", `Submit review · ${n}`, true, (_e, cx) => this.submit(cx))))
        .when(n === 0 && canAsk, (e) => e.child(button("ask", "Ask about diff", false, (_e, cx) => this.askAbout(null, cx)))))
      // What is reviewed: the scope, and for "Changes" its source → target.
      .when(Boolean(this.root) && this.hasHead, (e) => e.child(h_flex().h(38).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(this.scopePicker(t))
        .when(this.scope === "branch", (e) => e.child(this.refPicker(t, "source")).child(div().flex_none().text_size(12).text_color(t.dim).child("→")).child(this.refPicker(t, "target")))))
      // The file list is virtual: a branch can change a thousand files, and drawing every row on
      // every render made the whole panel crawl. Its rows can't hold handlers, so one click handler
      // routes by key, and a press on the speech bubble (the row's last 28px) comments on the file.
      .child(div().id("changes-list-box").flex_none().h(this.listHeight()).relative().p(6)
        .on_mouse_down("left", (e) => { this.listPress = e.local_position && e.bounds ? e.bounds.size.width - e.local_position.x : null; })
        .when(this.files.length > 0, (e) => e.child(v_virtual_list("changes-list", this.files.length, 28, (i) => `f:${this.files[i].path}`, (range) => {
          return this.files.slice(range.start, range.end).map((f) => {
            const parts = f.path.split("/"), name = parts.pop(), k = perFile[f.path];
            const here = fileNav && this.fileCursor === f.path;
            return h_flex().w_full().h(28).flex_none().pl(8).pr(2).gap(8).items_center().rounded(7).border_1().border_color(here ? t.accent : NONE).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
              .child(div().w(14).flex_none().text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
              .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
              .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
              // One speech bubble: the draft count when there are drafts; a press on it comments on the whole file.
              .child(h_flex().w(26).h(18).flex_none().gap(3).items_center().justify_center().rounded(4)
                .when(Boolean(k), (e) => e.bg(t.accent + "33").text_size(10).text_color(t.foreground)).when(!k, (e) => e.text_color(t.muted))
                .when(Boolean(k), (e) => e.child(String(k))).child(svg("mods/reviewer/comment.svg").size(k ? 10 : 12)));
          });
        }).size_full().track_scroll(this.filesScroll)
          .on_item_click((key, cx) => {
            const path = key.slice(2), onBubble = this.listPress !== null && this.listPress !== undefined && this.listPress <= 6 + 2 + 28;
            this.listPress = null; this.fileCursor = path;
            if (onBubble) this.commentFile(path, cx); else this.pick(path, cx);
          }))
          .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
        .when(!this.files.length, (e) => e.child(div().p(2).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? (this.scope === "work" ? "No uncommitted changes" : "No changes") : "No folder")))))
      // The divider: drag to resize the file list, double-click to fit it to the files again.
      .child(div().id("list-divider").h(7).flex_none().flex().flex_col().justify_center().cursor_row_resize().hover((s) => s.bg(t.hover)).tooltip("Drag to resize · double-click to fit")
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          if (e.click_count >= 2) { this.listH = null; this.drag = {}; this.endDrag(cx); return; }
          this.drag = { y: e.position.y, h: this.listHeight() }; this.listH = this.drag.h; cx.notify();
        })
        .child(div().w_full().h(this.drag ? 2 : 1).bg(this.drag ? t.accent : t.border)))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(h_flex().flex_1().min_h(0).items_stretch()
        .child(div().flex_1().min_w(0).min_h(0).relative().font_family(codeFont()).text_size(this.fontSize)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.items.length, this.sizes.length ? this.sizes : this.row, (i) => this.items[i].key,
            (range) => this.items.slice(range.start, range.end).map((it) => this.item(it, t, colors, target, commented, nav))).size_full().track_scroll(this.scroll)
            .on_item_click((k, cx) => {
              // The keyboard picks up where the mouse was.
              this.anchor = null; this.zone = "diff";
              if (k.startsWith("c:")) { this.cursor = { comment: k.slice(2) }; if (k.slice(2) !== this.composer?.editing) this.editComment(k.slice(2), cx); }
              else { const i = Number(k.slice(2)); if (this.rows[i]?.kind) this.cursor = { row: desc(this.rows[i]) }; this.clickRow(i, cx); }
            })
            .on_item_secondary_click((k, _e, cx) => { if (!k.startsWith("r:")) return; const i = Number(k.slice(2)); const r = this.rows[i]; if (!r || r.kind === "") return; this.askAbout(r.kind === "@" ? this.hunkRows(i) : [i], cx); }))))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes")))
        .when(Boolean(this.flash), (e) => e.child(div().absolute().bottom(6).right(14).px(8).py(3).rounded(6).bg(t.raised).text_size(11).text_color(t.blocked).child(this.flash)))
        .when(!this.flash && canAsk && !this.composer && n === 0, (e) => e.child(div().absolute().bottom(6).right(14).px(8).py(3).rounded(6).bg(t.raised + "e0").text_size(10).text_color(t.dim).child("Click a line to comment · right-click to ask · ? keys")))
        .when(this.keysHelp && !this.composer, (e) => e.child(this.keysCard(t))))
        // The comment box, a card floating over the top-right of the diff while it is open (a strip below it on a narrow panel).
        .when(Boolean(this.composer) && !this.narrow(), (e) => e.child(this.box(t, target, false))))
      // Narrow panel: the comment box is a strip under the diff instead of a column beside it.
      .when(Boolean(this.composer) && this.narrow(), (e) => e.child(this.box(t, target, true)))
      .when(Boolean(this.note_), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note_)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note_ = null;
    this.closed = !this.open; this.cursor = null; this.anchor = null; this.wantFirst = Boolean(this.open);
    if (this.open) this.fileCursor = path;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note_ = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }
}
