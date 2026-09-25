# Pinned worktrees (stock Herdr 0.9)

```sh
python3 ~/dotfiles/integrations/herdr/install.py
```

The installer is restricted to Linux with Omarchy. It registers the local plugin,
backs up your Herdr configuration and updates the host copy, preserving the
portable config and all other settings.

| Shortcut | Action |
|---|---|
| `prefix+w` | Herdr's normal sidebar navigation |
| `prefix+Ctrl+P` | Pin/unpin the **active** workspace |
| `prefix+p` | Open the pinned-workspaces popup |
| `Ctrl+1` … `Ctrl+9` | Switch directly to the corresponding pin |
| `prefix+Alt+p` | Previous tab (moved from `prefix+p`) |

Inside the popup: arrows or `j/k` move, Enter/`l` or a click opens a pin,
`Ctrl+P` unpins it, and `Esc`/`q`/`h` closes. Drag pins to reorder them, or use
`J/K`. Plain `1` … `9` and `Ctrl+1` … `Ctrl+9` switch to a pin. The first nine
shortcuts follow the saved order; additional pins remain accessible by scrolling.

Herdr's plugin context exposes the active workspace, **not** the sidebar's
unconfirmed preview. Press Enter to activate a sidebar selection before pinning
it. In sidebar navigation, `Ctrl+P` invokes the same active-workspace action;
it cannot pin a different highlighted row without changes to Herdr itself.

Pins use checkout paths, not transient workspace IDs. They survive restarts and
are shared across local Herdr sessions. A closed workspace stays in the list and
is reopened when selected if its directory exists. A deleted checkout remains
removable with `Ctrl+P`. Reordering pins never changes Spaces ordering.
State lives under `$XDG_STATE_HOME/herdr/plugins/rui.pin-worktrees/` (normally
`~/.local/state/herdr/plugins/rui.pin-worktrees/`), outside Git.

No custom Herdr build is required. Popup mouse/keyboard tests run against a
real PTY; Herdr CLI calls and provider responses are the mocked boundaries.

```sh
cd ~/dotfiles
python3 -m unittest discover -s integrations/herdr/tests -v
node integrations/herdr/tests/usage-model.test.cjs
```

The test suite also covers the [Omarchy usage widget](../../modules/omarchy-agents/README.md).
