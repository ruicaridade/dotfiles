
export ZSH="$HOME/.oh-my-zsh"
export PATH="$HOME/.local/bin:$PATH"

ZSH_THEME="robbyrussell"

plugins=(git)

source $ZSH/oh-my-zsh.sh

alias cc="claude --dangerously-skip-permissions"

eval "$(/usr/sbin/mise activate zsh)"

# Turso
export PATH="$PATH:/home/ruicaridade/.turso"

# opencode
export PATH=/home/ruicaridade/.opencode/bin:$PATH
