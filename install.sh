#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [[ $EUID -eq 0 ]]; then
    error "This script should not be run as root"
    exit 1
fi

# Check if yay is installed
if ! command -v yay &> /dev/null; then
    warn "yay is not installed. Installing yay first..."
    sudo pacman -S --needed --noconfirm git base-devel
    git clone https://aur.archlinux.org/yay.git /tmp/yay
    cd /tmp/yay
    makepkg -si --noconfirm
    cd -
    rm -rf /tmp/yay
    info "yay installed successfully"
fi

# Official packages (pacman)
PACMAN_PACKAGES=(
    # Shell
    zsh

    # Terminal multiplexer
    tmux

    # Editor
    neovim

    # Window manager & desktop
    waybar
    swaylock
    swaybg

    # Audio
    wireplumber
    playerctl
    pavucontrol

    # Screenshot & recording
    grim
    slurp
    wl-clipboard
    wf-recorder

    # System utilities
    brightnessctl
    orca

    # Development tools
    git
    base-devel
    stow
    make
    unzip

    # Fonts (common for waybar/terminal)
    ttf-font-awesome
    ttf-jetbrains-mono-nerd
)

# AUR packages (yay)
AUR_PACKAGES=(
    # Window manager
    niri

    # Terminal emulator
    ghostty

    # Application launcher
    fuzzel

    # Runtime version manager
    mise

    # Oh-my-zsh
    oh-my-zsh-git

    # Tmux plugin manager
    tmux-plugin-manager
)

info "Updating system..."
sudo pacman -Syu --noconfirm

info "Installing official packages..."
sudo pacman -S --needed --noconfirm "${PACMAN_PACKAGES[@]}"

info "Installing AUR packages..."
yay -S --needed --noconfirm "${AUR_PACKAGES[@]}"

# Setup oh-my-zsh if not already configured
if [[ ! -d "$HOME/.oh-my-zsh" ]]; then
    info "Setting up oh-my-zsh..."
    if [[ -d "/usr/share/oh-my-zsh" ]]; then
        cp -r /usr/share/oh-my-zsh "$HOME/.oh-my-zsh"
    fi
fi

# Install tmux plugins
if [[ -d "$HOME/.tmux/plugins/tpm" ]]; then
    info "Tmux Plugin Manager already installed"
else
    info "Installing Tmux Plugin Manager..."
    git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
fi

# Setup mise runtimes
if command -v mise &> /dev/null; then
    info "Installing mise runtimes (bun, node, python)..."
    mise install
fi

# Stow dotfiles
info "Stowing dotfiles..."
make stow

# Change default shell to zsh
if [[ "$SHELL" != *"zsh"* ]]; then
    info "Changing default shell to zsh..."
    chsh -s "$(which zsh)"
    warn "Please log out and back in for shell change to take effect"
fi

echo ""
info "Installation complete!"
info "Next steps:"
echo "  1. Log out and back in (or reboot) for shell changes"
echo "  2. Start tmux and press 'prefix + I' to install tmux plugins"
echo "  3. Open neovim to let lazy.nvim install plugins"
echo "  4. Run 'mise install' if runtimes weren't installed"
