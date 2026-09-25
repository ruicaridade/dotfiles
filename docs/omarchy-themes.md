# Omarchy application themes

Omarchy stages the selected theme, resolves `colors.toml` into application
configs, and replaces `~/.local/state/omarchy/current/theme/`. It then reloads
supported applications and runs `~/.config/omarchy/hooks/theme-set.d/` scripts.
The older `~/.config/omarchy/current/` path is not used by this installation.

This integration uses `omarchy-theme-color --all`, the same palette resolver
used by Omarchy's templates. It understands legacy palette names, missing-color
fallbacks, and light/dark mode. No packaged Omarchy files are modified.

## Install on Linux with Omarchy

```sh
cd ~/dotfiles
dots --modules omarchy
omarchy-sync-apps --setup
```

The module is restricted to Linux. Its script also checks for Omarchy's palette
resolver and active palette before changing anything. Python 3 and PyYAML are
the module's package dependencies. The Neovim and tmux integrations are in their
existing modules; both retain their portable themes outside Linux/Omarchy.

`--setup` opts Herdr, k9s and Zed into theming, backs up their previous configs
under `~/.local/state/dotfiles-backups/`, generates the current colors, and
reloads running tmux and Herdr. Run it again after relinking the portable Herdr config.
Open Neovim and k9s once after initial setup to activate their file watchers.

## Applications

- **Neovim:** `mini.base16` uses the resolved palette. A file poll detects theme
  directory replacements within roughly one second and reapplies highlights,
  including lualine's `ColorScheme` refresh, without reopening buffers. The
  editor background remains transparent. Grey syntax colors use bright theme
  variants or Kanagawa-inspired accents so types, functions, keywords and
  strings stay distinguishable. Syntax and comment colors are adjusted to at
  least 4.5:1 contrast against the palette background. Kanagawa remains the
  fallback when Omarchy is unavailable. This uses lazy.nvim, not LazyVim.
- **Herdr:** its `terminal` theme is overlaid with generated `[theme.custom]`
  colors. The navigation selection has a visible background distinct from the
  active worktree. Status colors remain chromatic even on monochrome themes:
  yellow for working, red for blocked/needs input, teal for done, green for
  idle. Undimmed text and status colors have at least 4.5:1 contrast against
  sidebar, active-row and selected-row backgrounds. Branch labels use Herdr's
  per-token dim style to distinguish them from workspace names, while Git
  ahead/behind indicators retain their status colors.
  Because Herdr has no platform-conditional config includes, setup creates a
  local host copy of `config.toml`; the portable source in the Herdr module
  keeps Kanagawa. Other local settings are preserved. The copy is intentional:
  portable config edits need relinking followed by `--setup`. Theme hooks also
  call `herdr server reload-config` to refresh attached clients.
- **k9s:** setup selects `skin: omarchy` and `reactive: true`. The hook renders
  `~/.config/k9s/skins/omarchy.yaml` from the tracked template; k9s watches it for
  live changes. Ordinary rows use the main foreground at 7:1 contrast; status
  colors, headers and secondary text use at least 4.5:1. Status accents remain
  chromatic with monochrome themes. k9s 0.51 uses each row's status color as its
  selected background, so selected text uses the main background color to
  retain contrast through selection changes. An explicit `K9S_SKIN` or
  context-specific skin takes priority.
- **Zed:** the hook writes `~/.config/zed/themes/omarchy.json`, a theme named
  `Omarchy` with the palette's light or dark appearance. Zed watches its themes
  directory and retints open windows without a restart. Setup replaces only the
  `"theme"` entry in `settings.json` with `"Omarchy"`; comments and other
  settings are kept. Syntax colors follow the Neovim mapping (mini.base16's
  groups, the same monochrome fallbacks, 4.5:1 contrast) without italics. The
  built-in terminal uses the palette's ANSI colors unchanged, like Omarchy's
  terminals. Nothing is written on hosts without `~/.config/zed`.
- **tmux:** Omarchy already updates pane colors and terminal palettes. The
  hook adds status bar, border, selection and message colors, retaining the
  existing session/window display. Both tmux config entry points conditionally
  source `~/.local/state/omarchy/apps/tmux.conf` after TPM, so new sessions and
  config reloads also get the current theme.

Templates, the sync script and the theme hook live in `modules/omarchy` and are
linked by `dots`. Generated palettes and host-specific configs stay outside
Git. Neovim is an existing Git submodule: its Lua changes must be committed in
that submodule before updating the parent repository's submodule pointer.

## Verification

```sh
cd modules/nvim/.config/nvim
nvim --headless -u NONE -l tests/omarchy_theme_spec.lua
nvim --headless '+luafile tests/theme_spec.lua' '+qa'
```

The Neovim flow test uses temporary palettes to check repeated dark/light
switches, syntax color contrast, and unsaved buffer preservation. It does not
change the desktop theme and needs Omarchy's stock themes and the installed
`mini.base16` plugin. The startup check verifies the platform colorscheme.

References: [Herdr themes](https://herdr.dev/docs/configuration/#theme),
[k9s skins](https://k9scli.io/topics/skins/),
[mini.base16](https://github.com/nvim-mini/mini.base16).
