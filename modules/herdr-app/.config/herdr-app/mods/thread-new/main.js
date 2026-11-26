// New thread (ctrl-shift-n): pick a project, name a branch, pick an agent; Create makes a
// git worktree of that project in ~/.herdr/worktrees/<repo>/<branch> and a space on it
// with the agent running, on the project's machine. With "Project folder" picked instead of
// "Worktree" (ctrl-w; remembered in shared "threads.worktree"), it runs the agent in a new
// tab of the project's own space (made if there's none), on its checkout as it is. The last
// row, "No project", does that in your home folder on this computer: a space on ~.
// "Add project…" (or props { pick: true })
// adds a repo and registers it as a Herdr space (the parent the worktrees sit under) when no
// space is there yet: from the folder picker on this computer, or, with other machines
// connected, a row to pick the machine and type a path there (Browse… on this computer). Projects are remembered in shared "threads.projects", along
// with every repo an open space is in.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, ScrollHandle } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, focused, exec, home, shared, setShared, pickFolder, knownAgents, checking, window, machines } from "herdr";

const I = (name) => "mods/workspace-chrome/" + name + ".svg";
const PROJECTS = "threads.projects"; // [{ path, name, machine, used }]
const AGENT = "threads.agent"; // the program key last picked ("shell": none)
const WORKTREE = "threads.worktree"; // false: new threads run in the project's own folder

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
const same = (a, b) => !a.home && !b.home && a.path === b.path && (a.machine ?? null) === (b.machine ?? null);
const keyOf = (p) => (p.home ? "~" : "") + (p.machine ?? "") + ":" + (p.path ?? ""); // a project, on its machine
// The "No project" rows: the home folder on each machine. Never saved with the projects.
const homeRow = (machine) => ({ home: true, name: "No project", machine: machine || null, path: null });
// Other machines you can add a project on now (not --temp ones, not offline).
const others = () => machines().filter((m) => m.name && m.layout !== "unavailable").map((m) => m.name);

async function git(cwd, args, on, timeout = 10000) {
  const r = await exec("git", args, { cwd, on, timeout });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

const firstLine = (s) => (s || "").split("\n").find((l) => l.trim())?.replace(/^(fatal|error): /, "") ?? "";

// The repo's default branch: what origin's HEAD points at (asked of origin, since the local
// origin/HEAD is only set at clone time and goes stale; that when offline), else main or
// master, else what the main checkout is on.
async function defaultBranch(p) {
  const remote = await git(p.path, ["ls-remote", "--symref", "origin", "HEAD"], p.machine, 15000).catch(() => ({ ok: false }));
  const m = remote.ok ? remote.out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m) : null;
  if (m) return m[1];
  const sym = await git(p.path, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], p.machine);
  if (sym.ok && sym.out.startsWith("origin/")) return sym.out.slice(7);
  for (const b of ["main", "master"]) if ((await git(p.path, ["show-ref", "--verify", "--quiet", "refs/heads/" + b], p.machine)).ok) return b;
  const h = await git(p.path, ["rev-parse", "--abbrev-ref", "HEAD"], p.machine);
  return h.ok && h.out !== "HEAD" ? h.out : null;
}

// Bring the default branch up to date with origin (fast-forward only) and return what to
// branch from: the branch itself, or origin's copy when the local one can't fast-forward
// (diverged, or its checkout has changes in the way).
async function freshBase(p, def) {
  if (!(await git(p.path, ["remote", "get-url", "origin"], p.machine)).ok) return def; // no remote: as it is
  const f = await git(p.path, ["fetch", "origin", def], p.machine, 180000);
  if (!f.ok) throw new Error("Couldn't fetch " + def + ": " + firstLine(f.err));
  // Checked out somewhere (usually the main checkout): pull there. Otherwise move the branch.
  const list = await git(p.path, ["worktree", "list", "--porcelain"], p.machine);
  const at = (list.out.split("\n\n").find((b) => b.split("\n").includes("branch refs/heads/" + def)) ?? "").match(/^worktree (.+)$/m)?.[1];
  const up = at
    ? await git(at, ["pull", "--ff-only", "origin", def], p.machine, 180000)
    : await git(p.path, ["fetch", "origin", def + ":" + def], p.machine, 180000);
  return up.ok ? def : "origin/" + def;
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
    this.homes = { "": this.userHome }; // machine ("" here) -> its home folder, once asked
    this.agentsOn = {}; // machine ("" here) -> [{ key, name, program, run }] once known
    this.adding = null; // the Add project row: { machine } while it's open
    this.pathInput = InputState.new({ value: "", placeholder: "/path/to/repo or ~/repo" });
    this.pathInput.on("submit", (_e, cx) => this.addRemote(cx));
    this.pathInput.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    this.pathInput.on("focus", () => { this.inputFocused = true; });
    this.pathInput.on("blur", () => { this.inputFocused = false; });
    this.projects = [...(shared(PROJECTS) ?? []).map((p) => ({ ...p })), homeRow(null), ...others().map(homeRow)];
    this.worktree = shared(WORKTREE) ?? true;
    this.at = 0;
    this.agentAt = 0;
    this.base = {}; // keyOf(project) -> its default branch
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
        const focused = s.id === (props()?.space ?? f?.space);
        if (at === (s.machine ? await this.homeOn(s.machine).catch(() => null) : this.userHome)) return { home: s.machine ?? null, focused };
        try { return { repo: await repoOf(at, s.machine), focused }; } catch { return null; }
      }));
      let preselect = null;
      for (const x of found) {
        if (x && "home" in x && x.focused) preselect = homeRow(x.home);
        if (!x?.repo) continue;
        if (!this.projects.some((p) => same(p, x.repo))) this.projects.push({ ...x.repo, used: 0 });
        if (x.focused) preselect = x.repo;
      }
      this.sort();
      if (!checking()) this.save();
      if (preselect && !props()?.pick) this.at = Math.max(0, this.projects.findIndex((p) => (preselect.home ? p.home && p.machine === preselect.machine : same(p, preselect))));
      this.scroll.scroll_to_item(this.at);
      this.loadBase(cx);
      cx.notify();
      if (props()?.pick && !checking()) this.addProject(cx);
    });
    this.loadBase(cx);
  }

  // The agents installed on the shown project's machine; null while they're asked.
  get agents() {
    return this.agentsOn[this.projects[this.at]?.machine ?? ""] ?? null;
  }

  loadAgents(cx, machine) {
    const m = machine ?? "";
    if (m in this.agentsOn) return;
    this.agentsOn[m] = null;
    const wanted = this.agents?.[this.agentAt]?.key ?? shared(AGENT);
    cx.spawn(async (cx) => {
      let list = [];
      try { list = (await knownAgents({ on: machine ?? null })).filter((a) => a.installed); } catch {}
      this.agentsOn[m] = [...list.map((a) => ({ key: a.key, name: a.name, program: a, run: a.run })), { key: "shell", name: "Terminal", program: { icon: I("terminal"), tint: true }, run: null }];
      this.pickAgent(wanted);
      cx.notify();
    });
  }

  // Keep the same agent picked across machines when the new one has it.
  pickAgent(key) {
    const list = this.agents;
    if (list) this.agentAt = Math.max(0, list.findIndex((a) => a.key === key));
  }

  // A machine's home folder ("" or null: this computer).
  async homeOn(machine) {
    const m = machine ?? "";
    if (this.homes[m]) return this.homes[m];
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: m });
    if (r.code !== 0 || !r.stdout.trim()) throw new Error("Could not find the home folder on " + m + ".");
    return (this.homes[m] = r.stdout.trim());
  }

  // Show a path on its machine with ~ for that machine's home.
  short(path, machine) {
    return tilde(path, this.homes[machine ?? ""]);
  }

  sort() {
    const keep = this.projects[this.at];
    this.projects.sort((a, b) => Number(Boolean(a.home)) - Number(Boolean(b.home)) || (b.used ?? 0) - (a.used ?? 0) || a.name.localeCompare(b.name));
    if (keep) this.at = this.projects.indexOf(keep);
  }

  save() {
    setShared(PROJECTS, this.projects.filter((p) => !p.home));
  }

  // Whether Create makes a worktree: never for "No project".
  get worktreeOn() {
    return this.worktree && !this.projects[this.at]?.home;
  }

  toggleWorktree(cx) {
    this.worktree = !this.worktree;
    if (!checking()) setShared(WORKTREE, this.worktree);
    this.error = "";
    this.refocus();
    cx.notify();
  }

  // The keyboard goes to the branch field while it's shown, else to the dialog itself.
  refocus() {
    if (this.worktreeOn) this.input.focus(); else this.handle.focus();
  }

  // What the shown project needs: its default branch, its machine's agents and home.
  loadBase(cx) {
    const p = this.projects[this.at];
    if (!p) return this.loadAgents(cx, null);
    const was = this.lastMachine;
    this.lastMachine = p.machine ?? "";
    if (was !== undefined && was !== this.lastMachine) this.pickAgent(this.agentsOn[was]?.[this.agentAt]?.key ?? shared(AGENT));
    this.loadAgents(cx, p.machine);
    if (!((p.machine ?? "") in this.homes)) {
      this.homes[p.machine ?? ""] = null;
      cx.spawn(async (cx) => { try { await this.homeOn(p.machine); } catch { delete this.homes[p.machine ?? ""]; } cx.notify(); });
    }
    const k = keyOf(p);
    if (p.home || k in this.base) return;
    this.base[k] = null;
    cx.spawn(async (cx) => {
      try {
        this.base[k] = (await defaultBranch(p)) ?? "";
      } catch { this.base[k] = ""; }
      cx.notify();
    });
  }

  // With other machines connected, opens the Add project row to pick where; else the picker.
  addProject(cx) {
    if (others().length) {
      this.adding = this.adding ? null : { machine: this.projects[this.at]?.machine ?? "" };
      this.error = "";
      if (this.adding) this.pathInput.focus(); else this.refocus();
      return cx.notify();
    }
    this.pickLocal(cx);
  }

  pickLocal(cx) {
    cx.spawn(async (cx) => {
      this.picking = true;
      let folder;
      try { folder = await pickFolder({ prompt: "Add project" }); } finally { this.picking = false; this.born = Date.now(); }
      if (!folder) return;
      const repo = await repoOf(folder, null);
      if (!repo) { this.error = tilde(folder, this.userHome) + " isn't in a git repository."; cx.notify(); return; }
      this.adding = null;
      this.pathInput.set_value("");
      this.adopt(repo, cx);
    });
  }

  // The Add project row's Enter: the typed path on the picked machine ("" here).
  addRemote(cx) {
    if (!this.adding || this.busy) return;
    const machine = this.adding.machine || null;
    const where = machine ?? "this computer";
    const typed = this.pathInput.value().trim();
    if (!typed) { this.error = "Type the repository's path on " + where + "."; return cx.notify(); }
    this.busy = true;
    this.stage = "Checking…";
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const h = await this.homeOn(machine);
        const folder = typed === "~" ? h : typed.startsWith("~/") ? h + typed.slice(1) : typed;
        const repo = await repoOf(folder, machine).catch(() => null);
        if (!repo) throw new Error(typed + " isn't in a git repository on " + where + ".");
        this.adding = null;
        this.pathInput.set_value("");
        this.adopt(repo, cx);
      } catch (e) {
        this.error = String(e.message ?? e);
      }
      this.busy = false;
      this.stage = null;
      cx.notify();
    });
  }

  // Remember a repo as a project and pick it. Its folder becomes a space (a registered
  // directory) unless one is already in that repo's checkout on that machine.
  adopt(repo, cx) {
      const ps = panes();
      if (!spaces().some((s) => (s.machine ?? null) === (repo.machine ?? null) && place(s, ps) === repo.path)) run("space.new", { folder: repo.path, machine: repo.machine ?? "", focus: false });
      let p = this.projects.find((x) => same(x, repo));
      if (!p) { p = { ...repo, used: Date.now() }; this.projects.push(p); }
      else p.used = Date.now();
      this.sort();
      this.at = this.projects.indexOf(p);
      this.scroll.scroll_to_item(this.at);
      this.save();
      this.error = "";
      this.loadBase(cx);
      this.refocus();
      cx.notify();
  }

  forget(p, cx) {
    if (p.home) return;
    this.projects = this.projects.filter((x) => x !== p);
    this.at = Math.min(this.at, Math.max(0, this.projects.length - 1));
    this.save();
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
    const agent = this.agents?.[this.agentAt];
    if (!this.worktreeOn) return this.createHere(p, agent, cx);
    if (!branch) { this.error = "Type a branch name."; return cx.notify(); }
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const userHome = await this.homeOn(p.machine);
        const path = userHome + "/.herdr/worktrees/" + p.name + "/" + slug(branch);
        const exists = (await git(p.path, ["show-ref", "--verify", "--quiet", "refs/heads/" + branch], p.machine)).ok;
        let add = ["worktree", "add", path, branch];
        if (!exists) {
          // A new branch starts from the default branch, pulled first.
          const def = this.base[keyOf(p)] || (await defaultBranch(p));
          if (!def) throw new Error("Couldn't tell this repository's default branch.");
          this.stage = "Pulling " + def + "…";
          cx.notify();
          const from = await freshBase(p, def);
          this.stage = "Creating…";
          cx.notify();
          add = ["worktree", "add", "--no-track", "-b", branch, path, from];
        }
        const r = await git(p.path, add, p.machine, 600000);
        if (!r.ok) throw new Error(r.err || "git worktree add failed.");
        p.used = Date.now();
        this.save();
        if (agent) setShared(AGENT, agent.key);
        // Unnamed, so the space follows its checkout; the card's title comes from the agent.
        run("space.new", { folder: path, machine: p.machine ?? "", ...(agent?.run ? { argv: agent.run } : {}) });
        this.close();
      } catch (e) {
        this.error = String(e.message ?? e);
        this.busy = false;
        this.stage = null;
        cx.notify();
      }
    });
  }

  // A thread in the project's own folder (or ~ for "No project"), no worktree: a new tab in
  // the space already there, else a new space on that folder.
  createHere(p, agent, cx) {
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const folder = p.home ? await this.homeOn(p.machine) : p.path;
        const ps = panes();
        const at = spaces().find((s) => (s.machine ?? null) === (p.machine ?? null) && (place(s, ps) === folder || s.folder === folder));
        const argv = agent?.run ? { argv: agent.run } : {};
        if (at) run("tab.new", { space: at.id, folder, ...argv });
        else run("space.new", { folder, machine: p.machine ?? "", ...argv });
        if (!p.home) { p.used = Date.now(); this.save(); }
        if (agent) setShared(AGENT, agent.key);
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
    if (k === "w" && e.modifiers?.control) {
      cx.stop_propagation();
      return this.toggleWorktree(cx);
    }
    // The branch field submits by itself; without it, Enter creates from here.
    if (k === "enter" && !this.worktreeOn && !this.adding) {
      cx.stop_propagation();
      return this.create(cx);
    }
    const n = this.projects.length;
    if (k === "escape") {
      if (this.adding) { this.adding = null; this.error = ""; this.refocus(); cx.stop_propagation(); return cx.notify(); }
      return this.close();
    }
    if ((k === "down" || k === "up") && n) {
      this.at = (this.at + (k === "down" ? 1 : n - 1)) % n;
      this.scroll.scroll_to_item(this.at);
      this.loadBase(cx);
      this.refocus();
    } else if (k === "tab" && this.agents?.length) {
      const m = this.agents.length;
      this.agentAt = (this.agentAt + (e.modifiers?.shift ? m - 1 : 1)) % m;
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  // Where to add a project from: pick a machine, then type a path there (or Browse… here).
  addRow(t) {
    const chip = (name, label) => {
      const on = this.adding.machine === name;
      return h_flex().id("am-" + (name || "here")).h(26).px(9).gap(6).rounded(7).items_center().cursor_pointer().border_1()
        .border_color(on ? t.accent : t.border).when(on, (el) => el.bg(t.selected)).text_size(12).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.adding = { machine: name }; this.error = ""; this.pathInput.focus(); cx.notify(); })
        .child(svg(I(name ? "server" : "monitor")).size(13)).child(label);
    };
    const button = (id, label, solid, act) => h_flex().id(id).flex_none().h(30).px(10).rounded(6).items_center().cursor_pointer()
      .font_medium().text_size(12)
      .when(solid, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!solid, (el) => el.border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .when(this.busy, (el) => el.opacity(0.5))
      .on_click(act).child(label);
    return v_flex().flex_none().gap(6).p(8).rounded(8).border_1().border_color(t.border)
      .child(h_flex().gap(6).flex_wrap()
        .child(chip("", "This computer"))
        .children(others().map((m) => chip(m, m))))
      .child(h_flex().gap(6).items_center()
        .child(Input.new(this.pathInput).flex_1().h(30).px(10).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground))
        .when(!this.adding.machine, (el) => el.child(button("am-browse", "Browse…", false, (_e, cx) => this.pickLocal(cx))))
        .child(button("am-add", "Add", true, (_e, cx) => this.addRemote(cx))));
  }

  render(cx) {
    const t = theme();
    const p = this.projects[this.at];
    const label = (s) => div().flex_none().pt(4).text_size(11).font_medium().text_color(t.dim).child(s);
    const base = p ? this.base[keyOf(p)] : null; // the default branch
    const ph = p ? this.homes[p.machine ?? ""] : null; // its machine's home, once known
    const wt = this.worktreeOn;
    const where = !p || !ph ? ""
      : !wt ? (p.machine ? p.machine + ":" : "") + (p.home ? "~" : tilde(p.path, ph)) + "  ·  " + (p.home ? "no project" : "as it is, no worktree")
      : this.text.trim() ? (p.machine ? p.machine + ":" : "") + tilde(ph + "/.herdr/worktrees/" + p.name + "/" + slug(this.text.trim()), ph) + (base ? "  ·  from " + base : "") : "";
    // Worktree | Project folder: where the thread runs. "No project" has only its folder.
    const seg = (id, ic, text, on) => h_flex().id(id).h(24).px(8).gap(5).rounded(5).items_center().cursor_pointer()
      .text_size(12).text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected))
      .when(!on && !p?.home, (el) => el.hover((s) => s.text_color(t.foreground)))
      .when(Boolean(p?.home), (el) => el.opacity(0.5))
      .on_click((_e, cx) => { if (!p?.home && on !== true) this.toggleWorktree(cx); })
      .child(svg(I(ic)).size(13)).child(text);
    const row = (x, i) => {
      const on = i === this.at;
      return h_flex().id("pj-" + i).flex_none().h(34).px(8).gap(9).rounded(7).items_center().cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { this.at = i; this.loadBase(cx); this.refocus(); cx.notify(); })
        .on_mouse_down("right", (_e, cx) => this.forget(x, cx))
        .child(x.home ? h_flex().size(18).flex_none().rounded(4).bg(t.hover).items_center().justify_center().text_color(t.muted).child(svg(I("folder")).size(12)) : avatar(x.name, 18))
        .child(div().flex_none().text_color(t.foreground).child(x.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child((x.machine ? x.machine + ":" : "") + (x.home ? "~" : this.short(x.path, x.machine))))
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
      .when(Boolean(this.adding), (el) => el.child(this.addRow(t)))
      // As tall as its projects, up to twelve rows; past that it scrolls (the cursor stays in view).
      .child(div().relative().flex_none().h(Math.max(1, Math.min(this.projects.length, 12)) * 35 + 9).rounded(8).border_1().border_color(t.border)
        .child(v_flex().id("pj-list").size_full().p(4).gap(1).overflow_y_scroll().track_scroll(this.scroll)
          .children(this.projects.map(row))
          .when(this.projects.length === 0, (el) => el.child(div().p(8).text_color(t.dim).child("No projects yet. Add one from a folder."))))
        .child(Scrollbar.vertical("pj-list").absolute().inset_0()))
      .child(h_flex().flex_none().items_center()
        .child(div().flex_1().child(label(wt ? "BRANCH" : "WHERE")))
        .child(h_flex().flex_none().p(2).gap(2).rounded(7).border_1().border_color(t.border)
          .child(seg("wt-on", "git-branch", "Worktree", wt))
          .child(seg("wt-off", "folder", p?.home ? "Home folder" : "Project folder", !wt))))
      .when(wt, (el) => el.child(Input.new(this.input).flex_none().h(32).px(10).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground)))
      .child(label("AGENT"))
      .child(h_flex().flex_none().gap(6).flex_wrap()
        .when(!this.agents, (el) => el.child(div().text_color(t.dim).child("…")))
        .children((this.agents ?? []).map((a, i) => [a, i]).filter(([a, i]) => i < 6 || i === this.agentAt || a.key === "shell").map(([a, i]) => {
          const on = i === this.agentAt;
          return h_flex().id("ag-" + a.key).h(28).px(9).gap(6).rounded(7).items_center().cursor_pointer().border_1()
            .border_color(on ? t.accent : t.border).when(on, (el) => el.bg(t.selected)).text_color(on ? t.foreground : t.muted)
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.agentAt = i; this.refocus(); cx.notify(); })
            .children([icon(a.program, 14, on ? t.foreground : t.muted)].filter(Boolean))
            .child(a.name);
        })))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().text_color(t.blocked).child(this.error)))
      .child(h_flex().flex_none().pt(6).gap(8).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(where))
        .when(this.busy, (el) => el.child(svg(I("spinner")).size(12).spin(900)))
        .child(h_flex().id("create").flex_none().h(28).px(12).rounded(7).items_center().cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground).font_medium().text_size(12.5)
          .when(this.busy || !p, (el) => el.opacity(0.5))
          .on_click((_e, cx) => this.create(cx))
          .child(this.busy ? (this.stage ?? "Creating…") : "Create")))
      .child(div().flex_none().text_size(11).text_color(t.dim).child("↑↓ project · tab agent · ctrl-w worktree or folder · ↵ create · right-click to forget"));
  }
}
