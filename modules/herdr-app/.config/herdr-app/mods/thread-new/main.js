// New thread (ctrl-shift-n): pick a project, name a branch, pick an agent; Create makes a
// git worktree of that project in ~/.herdr/worktrees/<repo>/<branch> and a space on it
// with the agent running. "Add project…" (or props { pick: true }) adds a repo from a
// folder on this computer and registers it as a Herdr space (the parent the worktrees sit
// under) when no space is there yet. Projects are remembered in shared "threads.projects", along
// with every repo an open space is in.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, ScrollHandle } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, focused, exec, home, shared, setShared, pickFolder, knownAgents, checking, window } from "herdr";

const I = (name) => "mods/workspace-chrome/" + name + ".svg";
const PROJECTS = "threads.projects"; // [{ path, name, machine, used }]
const AGENT = "threads.agent"; // the program key last picked ("shell": none)

// Same avatars as the threads sidebar.
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
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || "";
}
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const ADJ = ["amber", "brisk", "calm", "clever", "crisp", "dusty", "eager", "fuzzy", "gentle", "golden", "hazy", "humble", "jolly", "keen", "lucky", "mellow", "misty", "nimble", "plucky", "quiet", "rapid", "rusty", "shiny", "silent", "snappy", "sunny", "swift", "tidy", "vivid", "witty"];
const NOUN = ["badger", "comet", "otter", "falcon", "fern", "harbor", "heron", "lantern", "maple", "meadow", "moose", "nebula", "orchid", "panda", "pebble", "pigeon", "quartz", "raven", "river", "rocket", "sparrow", "spruce", "thistle", "tiger", "tulip", "walrus", "willow", "wombat", "yak", "zephyr"];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const tilde = (p, h) => (h && p.startsWith(h) ? "~" + p.slice(h.length) : p);
const same = (a, b) => a.path === b.path && (a.machine ?? null) === (b.machine ?? null);

async function git(cwd, args, on, timeout = 10000) {
  const r = await exec("git", args, { cwd, on, timeout });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

// The repo a folder is in: its main checkout and name. null outside git.
async function repoOf(folder, on) {
  const r = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on, 5000);
  if (!r.ok) return null;
  const main = r.out.replace(/\/$/, "").replace(/\/\.git$/, "");
  return { path: main, name: main.split("/").pop().replace(/\.git$/, ""), machine: on ?? null };
}

export default class ThreadNew extends View {
  init(_props, cx) {
    this.userHome = home();
    this.projects = (shared(PROJECTS) ?? []).map((p) => ({ ...p }));
    this.at = 0;
    this.agents = null; // [{ key, name, program, run }] once known
    this.agentAt = 0;
    this.base = {}; // project path -> the branch its main checkout is on
    this.busy = false;
    this.error = "";
    this.text = pick(ADJ) + "-" + pick(NOUN);
    this.input = InputState.new({ value: this.text, placeholder: "branch name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.create(cx));
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.handle.focus();
    cx.timer.after(80, () => { this.input.focus(); this.input.set_selected_range({ start: 0, end: this.text.length }); });
    // Close when the keyboard goes elsewhere in the window (alt-a, a click on a pane...).
    // Another app (or the folder picker) taking the window's focus doesn't count.
    this.inputFocused = false;
    this.input.on("focus", () => { this.inputFocused = true; });
    this.input.on("blur", () => { this.inputFocused = false; });
    this.born = Date.now();
    cx.timer.every(250, () => this.checkFocus());
    this.sort();
    cx.spawn(async (cx) => {
      // Every repo an open space is in is a project, and the focused one is preselected.
      const ps = panes();
      const f = focused();
      const found = await Promise.all(spaces().map(async (s) => {
        const at = place(s, ps);
        if (!at) return null;
        try { return { repo: await repoOf(at, s.machine), focused: s.id === (props()?.space ?? f?.space) }; } catch { return null; }
      }));
      let preselect = null;
      for (const x of found) {
        if (!x?.repo) continue;
        if (!this.projects.some((p) => same(p, x.repo))) this.projects.push({ ...x.repo, used: 0 });
        if (x.focused) preselect = x.repo;
      }
      this.sort();
      if (!checking()) setShared(PROJECTS, this.projects);
      if (preselect && !props()?.pick) this.at = Math.max(0, this.projects.findIndex((p) => same(p, preselect)));
      this.scroll.scroll_to_item(this.at);
      this.loadBase(cx);
      cx.notify();
      if (props()?.pick && !checking()) this.addProject(cx);
    });
    cx.spawn(async (cx) => {
      let list = [];
      try { list = (await knownAgents()).filter((a) => a.installed); } catch {}
      this.agents = [...list.map((a) => ({ key: a.key, name: a.name, program: a, run: a.run })), { key: "shell", name: "Terminal", program: { icon: I("terminal"), tint: true }, run: null }];
      this.agentAt = Math.max(0, this.agents.findIndex((a) => a.key === shared(AGENT)));
      cx.notify();
    });
  }

  sort() {
    const keep = this.projects[this.at];
    this.projects.sort((a, b) => (b.used ?? 0) - (a.used ?? 0) || a.name.localeCompare(b.name));
    if (keep) this.at = this.projects.indexOf(keep);
  }

  loadBase(cx) {
    const p = this.projects[this.at];
    if (!p || p.path in this.base) return;
    this.base[p.path] = null;
    cx.spawn(async (cx) => {
      try {
        const r = await git(p.path, ["rev-parse", "--abbrev-ref", "HEAD"], p.machine);
        this.base[p.path] = r.ok ? r.out : "";
      } catch { this.base[p.path] = ""; }
      cx.notify();
    });
  }

  addProject(cx) {
    cx.spawn(async (cx) => {
      this.picking = true;
      let folder;
      try { folder = await pickFolder({ prompt: "Add project" }); } finally { this.picking = false; this.born = Date.now(); }
      if (!folder) return;
      const repo = await repoOf(folder, null);
      if (!repo) { this.error = tilde(folder, this.userHome) + " isn't in a git repository."; cx.notify(); return; }
      // The folder becomes a space (a registered directory) unless one is already in that repo's checkout.
      const ps = panes();
      if (!spaces().some((s) => !s.machine && place(s, ps) === repo.path)) run("space.new", { folder: repo.path, machine: "", focus: false });
      let p = this.projects.find((x) => same(x, repo));
      if (!p) { p = { ...repo, used: Date.now() }; this.projects.push(p); }
      else p.used = Date.now();
      this.sort();
      this.at = this.projects.indexOf(p);
      this.scroll.scroll_to_item(this.at);
      setShared(PROJECTS, this.projects);
      this.error = "";
      this.loadBase(cx);
      this.input.focus();
      cx.notify();
    });
  }

  forget(p, cx) {
    this.projects = this.projects.filter((x) => x !== p);
    this.at = Math.min(this.at, Math.max(0, this.projects.length - 1));
    setShared(PROJECTS, this.projects);
    cx.notify();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    closeOverlay(props().overlay);
  }

  checkFocus() {
    if (checking() || this.picking || this.busy || Date.now() - this.born < 600 || !window()?.active) return;
    if (!this.inputFocused && !this.handle.is_focused()) this.close();
  }

  create(cx) {
    if (this.busy) return;
    const p = this.projects[this.at];
    const branch = this.text.trim();
    if (!p) { this.error = "Pick a project, or add one."; return cx.notify(); }
    if (!branch) { this.error = "Type a branch name."; return cx.notify(); }
    const agent = this.agents?.[this.agentAt];
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        let userHome = this.userHome;
        if (p.machine) {
          const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: p.machine });
          if (r.code !== 0 || !r.stdout.trim()) throw new Error("Could not find the home folder on " + p.machine + ".");
          userHome = r.stdout.trim();
        }
        const path = userHome + "/.herdr/worktrees/" + p.name + "/" + slug(branch);
        const exists = (await git(p.path, ["show-ref", "--verify", "--quiet", "refs/heads/" + branch], p.machine)).ok;
        const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"];
        const r = await git(p.path, add, p.machine, 600000);
        if (!r.ok) throw new Error(r.err || "git worktree add failed.");
        p.used = Date.now();
        setShared(PROJECTS, this.projects);
        if (agent) setShared(AGENT, agent.key);
        // Unnamed, so the space follows its checkout; the card's title comes from the agent.
        run("space.new", { folder: path, machine: p.machine ?? "", ...(agent?.run ? { argv: agent.run } : {}) });
        this.close();
      } catch (e) {
        this.error = String(e.message ?? e);
        this.busy = false;
        cx.notify();
      }
    });
  }

  key(e, cx) {
    const k = e.key;
    const n = this.projects.length;
    if (k === "escape") return this.close();
    if ((k === "down" || k === "up") && n) {
      this.at = (this.at + (k === "down" ? 1 : n - 1)) % n;
      this.scroll.scroll_to_item(this.at);
      this.loadBase(cx);
    } else if (k === "tab" && this.agents?.length) {
      const m = this.agents.length;
      this.agentAt = (this.agentAt + (e.modifiers?.shift ? m - 1 : 1)) % m;
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const p = this.projects[this.at];
    const label = (s) => div().flex_none().pt(4).text_size(11).font_medium().text_color(t.dim).child(s);
    const base = p ? this.base[p.path] : null;
    const where = p && this.text.trim() ? tilde(this.userHome + "/.herdr/worktrees/" + p.name + "/" + slug(this.text.trim()), this.userHome) : "";
    const row = (x, i) => {
      const on = i === this.at;
      return h_flex().id("pj-" + i).flex_none().h(34).px(8).gap(9).rounded(7).items_center().cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { this.at = i; this.loadBase(cx); this.input.focus(); cx.notify(); })
        .on_mouse_down("right", (_e, cx) => this.forget(x, cx))
        .child(avatar(x.name, 18))
        .child(div().flex_none().text_color(t.foreground).child(x.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child((x.machine ? x.machine + ":" : "") + tilde(x.path, this.userHome)))
        .when(on, (el) => el.child(svg(I("check")).size(14).flex_none().text_color(t.foreground)));
    };
    return v_flex().id("thread-new").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().p(16).gap(8).bg(t.popover).text_size(13)
      .child(div().flex_none().font_semibold().text_size(14).text_color(t.foreground).child("New thread"))
      .child(h_flex().flex_none().items_center()
        .child(div().flex_1().child(label("PROJECT")))
        .child(h_flex().id("pj-add").flex_none().h(24).px(7).gap(6).rounded(6).items_center().cursor_pointer()
          .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.addProject(cx))
          .child(svg(I("folder-plus")).size(13)).child("Add project…")))
      // As tall as its projects, up to twelve rows; past that it scrolls (the cursor stays in view).
      .child(div().relative().flex_none().h(Math.max(1, Math.min(this.projects.length, 12)) * 35 + 9).rounded(8).border_1().border_color(t.border)
        .child(v_flex().id("pj-list").size_full().p(4).gap(1).overflow_y_scroll().track_scroll(this.scroll)
          .children(this.projects.map(row))
          .when(this.projects.length === 0, (el) => el.child(div().p(8).text_color(t.dim).child("No projects yet. Add one from a folder."))))
        .child(Scrollbar.vertical("pj-list").absolute().inset_0()))
      .child(label("BRANCH"))
      .child(Input.new(this.input).flex_none().h(32).px(10).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground))
      .child(label("AGENT"))
      .child(h_flex().flex_none().gap(6).flex_wrap()
        .when(!this.agents, (el) => el.child(div().text_color(t.dim).child("…")))
        .children((this.agents ?? []).map((a, i) => [a, i]).filter(([a, i]) => i < 6 || i === this.agentAt || a.key === "shell").map(([a, i]) => {
          const on = i === this.agentAt;
          return h_flex().id("ag-" + a.key).h(28).px(9).gap(6).rounded(7).items_center().cursor_pointer().border_1()
            .border_color(on ? t.accent : t.border).when(on, (el) => el.bg(t.selected)).text_color(on ? t.foreground : t.muted)
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.agentAt = i; this.input.focus(); cx.notify(); })
            .children([icon(a.program, 14, on ? t.foreground : t.muted)].filter(Boolean))
            .child(a.name);
        })))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().text_color(t.blocked).child(this.error)))
      .child(h_flex().flex_none().pt(6).gap(8).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(where ? where + (base ? "  ·  from " + base : "") : ""))
        .when(this.busy, (el) => el.child(svg(I("spinner")).size(12).spin(900)))
        .child(h_flex().id("create").flex_none().h(28).px(12).rounded(7).items_center().cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground).font_medium().text_size(12.5)
          .when(this.busy || !p, (el) => el.opacity(0.5))
          .on_click((_e, cx) => this.create(cx))
          .child(this.busy ? "Creating…" : "Create")))
      .child(div().flex_none().text_size(11).text_color(t.dim).child("↑↓ project · tab agent · ↵ create · right-click a project to forget it"));
  }
}
