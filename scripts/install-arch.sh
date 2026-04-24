#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

if [[ $EUID -eq 0 ]]; then
    error "This script should not be run as root"
    exit 1
fi

if ! command -v pacman >/dev/null 2>&1; then
    error "Arch install requires pacman"
    exit 1
fi

if ! command -v yay >/dev/null 2>&1; then
    warn "yay is not installed. Installing yay first..."
    sudo pacman -S --needed --noconfirm git base-devel
    git clone https://aur.archlinux.org/yay.git /tmp/yay
    pushd /tmp/yay >/dev/null
    makepkg -si --noconfirm
    popd >/dev/null
    rm -rf /tmp/yay
    info "yay installed successfully"
fi

PACMAN_PACKAGES=(
    zsh
    tmux
    neovim
    waybar
    swaylock
    swaybg
    pipewire
    wireplumber
    playerctl
    pavucontrol
    pulsemixer
    grim
    slurp
    wl-clipboard
    wf-recorder
    loupe
    mpv
    xdg-utils
    iwd
    xdg-desktop-portal-gnome
    brightnessctl
    orca
    git
    base-devel
    stow
    make
    unzip
    ttf-font-awesome
    ttf-jetbrains-mono-nerd
)

AUR_PACKAGES=(
    niri
    ghostty
    fuzzel
    google-chrome
    bluetui
    impala
    mise
)

info "Updating system..."
sudo pacman -Syu --noconfirm

info "Installing official packages..."
sudo pacman -S --needed --noconfirm "${PACMAN_PACKAGES[@]}"

info "Installing AUR packages..."
yay -S --needed --noconfirm "${AUR_PACKAGES[@]}"

info "Setting default image and video handlers..."
bash "$SCRIPT_DIR/set-default-apps.sh"

if [[ ! -d "$HOME/.oh-my-zsh" ]]; then
    info "Installing oh-my-zsh..."
    git clone https://github.com/ohmyzsh/ohmyzsh.git "$HOME/.oh-my-zsh"
fi

if [[ -d "$HOME/.tmux/plugins/tpm" ]]; then
    info "Tmux Plugin Manager already installed"
else
    info "Installing Tmux Plugin Manager..."
    git clone https://github.com/tmux-plugins/tpm "$HOME/.tmux/plugins/tpm"
fi

if command -v mise >/dev/null 2>&1; then
    info "Installing mise runtimes (bun, node, python)..."
    mise install
fi

info "Enabling iwd service..."
sudo systemctl enable --now iwd

info "Stowing Linux dotfiles..."
make -C "$ROOT_DIR" stow

if [[ "$SHELL" != *"zsh"* ]]; then
    target_shell="$(command -v zsh)"
    if grep -qx "$target_shell" /etc/shells; then
        info "Changing default shell to zsh..."
        chsh -s "$target_shell"
        warn "Please log out and back in for shell change to take effect"
    else
        warn "Skipping shell change because $target_shell is not in /etc/shells"
    fi
fi

echo ""
info "Arch installation complete!"
info "Next steps:"
echo "  1. Log out and back in (or reboot) for shell changes"
echo "  2. Start tmux and press 'prefix + I' to install tmux plugins"
echo "  3. Open neovim to let lazy.nvim install plugins"
echo "  4. Run 'mise install' if runtimes weren't installed"
