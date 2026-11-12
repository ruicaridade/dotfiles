// Launcher for a key (mod.open:worktree-new): opens worktree-dialog (a clone of Herdr's worktree dialog that pre-fills a generated branch name) in "new" mode
// for the focused space, then closes itself. The dialog does the work and asks first.
import { View, div } from "gpui-kit";
import { focused, panes, openOverlay, closeOverlay, props, notify } from "herdr";

const ACTION = "new";

export default class WorktreeLauncher extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      const own = props()?.overlay;
      if (own) closeOverlay(own);
      const f = focused();
      if (!f?.space) return notify({ title: "No space is open", level: "warning" });
      const args = { space: f.space, action: ACTION };
      // New starts from the focused terminal's folder, as the + menu does; remove acts on the space's checkout, as the space menu does.
      if (ACTION === "new") {
        const cwd = f.pane ? panes().find((p) => p.pane === f.pane)?.cwd : f.cwd;
        if (cwd) args.folder = cwd;
      }
      openOverlay({ mod: "worktree-dialog", kind: "dialog", width: 440, height: 260, props: args });
    });
  }

  render() {
    return div();
  }
}
