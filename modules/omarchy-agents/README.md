# omarchy-agents

Extra collectors for the Omarchy agents bar panel (`omarchy.agents`). The
panel displays whatever JSON records land in
`~/.local/state/omarchy/agents/usage/`; each `omarchy-agent-usage-<agent>`
collector here prints one such record.

| Collector | Tab | Source |
|---|---|---|
| `bin/omarchy-agent-usage-cursor` | Cursor | Local chat bubbles in the Cursor app DB (`~/.config/Cursor/User/globalStorage/state.vscdb`): tokens by day, prompts, sessions. No model split and no rate-limit meter — Cursor exposes no usage API. |
| `bin/omarchy-agent-usage-others` | Others | opencode messages and pi/omp sessions on providers the built-in Claude/Codex collectors do not claim (github-copilot, amazon-bedrock, zai, opencode-go, …). Claimed providers are skipped so nothing is double-counted. |

## Install

The panel's refresh only runs collectors found in `$OMARCHY_PATH/bin`
(`/usr/share/omarchy/bin`), so the scripts live here (survive package
upgrades) and get symlinked into place:

```bash
sudo ln -sf ~/dotfiles/modules/omarchy-agents/bin/omarchy-agent-usage-cursor /usr/share/omarchy/bin/
sudo ln -sf ~/dotfiles/modules/omarchy-agents/bin/omarchy-agent-usage-others /usr/share/omarchy/bin/
sudo ln -sf ~/dotfiles/modules/omarchy-agents/assets/cursor.svg /usr/share/omarchy/shell/plugins/agents/assets/
sudo ln -sf ~/dotfiles/modules/omarchy-agents/assets/others.svg /usr/share/omarchy/shell/plugins/agents/assets/
```

Then regenerate once: `omarchy agent usage-update cursor others`. The tabs
appear on the panel's next refresh; hide either one with the usual
`providers` setting (`omarchy bar set omarchy.agents providers '…' --json`).

If Omarchy ever ships its own collector with one of these names, remove the
symlink before upgrading to avoid a pacman file conflict.

## Keeping honest totals

`CLAIMED_OPENCODE_PROVIDERS` and `CLAIMED_PI_PROVIDERS` at the top of the
others collector mirror what `omarchy-agent-usage-claude` and
`omarchy-agent-usage-codex` count for their own subscriptions. If Omarchy
changes those attributions, update the sets here too.
