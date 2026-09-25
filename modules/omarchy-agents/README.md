# Claude and Codex usage in Omarchy

The user-owned `ruicaridade.agents` widget shows provider logos and remaining
subscription percentages in the top bar. Claude's short/weekly windows appear
in that order; Codex shows whichever windows the account actually reports.
Hover for labels and reset times, or click for meters and details, including
Claude's model-specific limits. Right-click or press `R` in the panel to refresh.

```sh
python3 ~/dotfiles/modules/omarchy-agents/install.py
```

Installation requires Linux with Omarchy. The installer links the plugin from
this repo, selects it in `~/.config/omarchy/shell.json`, and restarts the shell.
Previous local files are backed up in `~/.local/state/dotfiles-backups/`.
`dots --modules omarchy-agents` can also link the plugin; the installer handles
selecting it in the bar. No packaged Omarchy files are modified.

Usage polls every 30 seconds, including while the panel is closed. Reset
countdowns update every second. The providers are polled concurrently, with
bounded timeouts and a shared cache to avoid duplicate requests on multiple
monitors. This is polling, not a provider push feed.

A failed refresh retains unexpired last-known limits and marks them with `*`
in the bar and **stale** in the panel. A provider with no usable result shows
`—`, never a made-up zero. Expired windows show a pending refresh. The popup
indicator spans the full logos-and-percentages label.

Claude uses Omarchy's existing OAuth usage collector and its successful-probe
timestamp. Codex uses the CLI's read-only app-server protocol directly. Its
reader drains complete JSON lines before waiting for more data, preventing
notification/reply batches from causing the intermittent timeout in the stock
collector's buffered `readline`/`select` loop. No credentials are copied into
this repository. Cache data lives in `~/.local/state/omarchy/agent-limits/`.

The Codex request sequence was checked against Orca's
[`codex-rpc-rate-limit-probe.ts`](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/codex-rpc-rate-limit-probe.ts).
The provider SVGs are the logos bundled with Omarchy's agents plugin, with light
and dark variants for Codex. Theme colors come from Omarchy's shell at runtime.

```sh
cd ~/dotfiles
python3 -m unittest discover -s integrations/herdr/tests -v
node integrations/herdr/tests/usage-model.test.cjs
```

`bin/omarchy-agent-usage-cursor`, `bin/omarchy-agent-usage-others`, and their
assets are retained from the older transcript-statistics integration. They
are not used by this Claude/Codex quota widget.
