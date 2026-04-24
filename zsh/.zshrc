
export ZSH="$HOME/.oh-my-zsh"
export PATH="$HOME/.local/bin:$PATH"

ZSH_THEME="robbyrussell"

plugins=(git)

if [[ -f "$ZSH/oh-my-zsh.sh" ]]; then
  source "$ZSH/oh-my-zsh.sh"
fi

alias cc="claude --dangerously-skip-permissions"
alias openclaw-gateway="ssh -N -L 18789:127.0.0.1:18789 openclaw"

if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate zsh)"
fi

# Turso
export PATH="$PATH:$HOME/.turso"

# opencode
export PATH="$HOME/.opencode/bin:$PATH"

# Auto-start tmux for local interactive Ghostty shells.
if [[ $- == *i* ]] && [[ -z "$TMUX" ]] && [[ -z "$SSH_CONNECTION" ]] && [[ "$TERM_PROGRAM" == "ghostty" ]] && command -v tmux >/dev/null 2>&1; then
  exec tmux new-session -A -s main
fi
