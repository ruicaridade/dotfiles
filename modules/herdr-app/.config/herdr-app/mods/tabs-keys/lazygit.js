// lazygit in a modal over the window, for the "tabs-keys.lazygit" command: started
// with hc in the focused terminal's folder (a worktree when that's where it is), on
// the space's machine, only when that folder is in a git repo. The command toggles
// it; quitting lazygit (q) ends its terminal, which closes the modal. Either way the
// keyboard goes back to where it was.
import { spaces, focused, run, hc, exec, openOverlay, closeOverlay } from "herdr";

// null (closed), { phase: "starting", back }, or { phase: "open", back, overlay, terminal }.
let state = null;

export function toggleLazygit(cx) {
  if (state?.phase === "starting") return;
  if (state?.phase === "open") {
    closeOverlay(state.overlay);
    run("terminal.kill", { terminal: state.terminal });
    restore();
    return;
  }
  const back = focused(), space = spaces().find((s) => s.active);
  const cwd = back?.cwd || space?.folder, on = space?.machine ?? null;
  if (!cwd) return;
  state = { phase: "starting", back };
  cx.spawn(async () => {
    try {
      const git = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, on });
      if (git.code !== 0) { state = null; return; }
      const args = ["run", "--bg", "--json", "--no-parent", "--no-notify", "--rm", "--cwd", cwd];
      if (on) args.push("--on", on);
      const r = await hc([...args, "--", "lazygit"]);
      if (r.code !== 0) { state = null; return; }
      const terminal = JSON.parse(r.stdout).address;
      const overlay = openOverlay({ kind: "dialog", modal: true, width: 0.9, height: 0.9,
        layout: { type: "column", children: [{ type: "block", content: { terminal } }] } });
      state = { phase: "open", back, overlay, terminal };
      run("pane.focus", { terminal });
    } catch {
      state = null;
    }
  });
}

// lazygit quit (the modal closed itself with its terminal): give the keyboard back.
export function lazygitEnded(terminals) {
  if (state?.phase === "open" && !terminals.some((x) => x.address === state.terminal && x.state === "live")) restore();
}

function restore() {
  const back = state?.back;
  state = null;
  if (back?.pane) run("pane.focus", { pane: back.pane });
  else if (back?.terminal) run("pane.focus", { terminal: back.terminal });
}
