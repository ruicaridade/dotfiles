// lazygit in a modal over the window, for the "tabs-keys.lazygit" command: started
// with hc in the focused terminal's folder (a worktree when that's where it is), on
// the space's machine, only when that folder is in a git repo. The command toggles
// it; quitting lazygit (q) ends its terminal, which closes the modal. Switching
// spaces closes it too. When it closes, the pane it was opened from gets the
// keyboard back if it's still on screen.
import { spaces, panes, focused, run, hc, exec, openOverlay, closeOverlay } from "herdr";

// null (closed), { phase: "starting", space, back }, or { phase: "open", space, back, overlay, terminal, seen }.
let state = null;

export function toggleLazygit(cx) {
  if (state?.phase === "starting") return;
  if (state?.phase === "open") { close(); return; }
  const space = spaces().find((s) => s.active), f = focused();
  const cwd = f?.cwd || space?.folder, on = space?.machine ?? null;
  if (!space || !cwd) return;
  state = { phase: "starting", space: space.id, back: f?.pane ?? null };
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
      state = { ...state, phase: "open", overlay, terminal, seen: false };
    } catch {
      state = null;
    }
  });
}

// Called on every render of the tab bar. A new terminal reaches terminals() a moment
// after hc returns, so lazygit only counts as gone once it has been seen live.
export function lazygitEnded(terminals) {
  if (state?.phase !== "open") return;
  if (spaces().find((s) => s.active)?.id !== state.space) { close(); return; }
  const live = terminals.some((x) => x.address === state.terminal && x.state === "live");
  if (live) state.seen = true;
  else if (state.seen) close(false);
}

// `kill`: false when lazygit already quit (killing an ended terminal fails with a toast).
function close(kill = true) {
  const { overlay, terminal, back } = state;
  state = null;
  closeOverlay(overlay);
  if (kill) run("terminal.kill", { terminal });
  // Only a pane of the shown tab: focusing one elsewhere would switch spaces.
  const tab = focused()?.tab;
  if (back && panes().some((p) => p.pane === back && p.tab === tab)) run("pane.focus", { pane: back });
}
