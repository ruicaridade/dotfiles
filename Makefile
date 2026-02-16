PACKAGES := discord fuzzel ghostty mise niri nvim tmux waybar zsh

.PHONY: bootstrap install stow uninstall $(PACKAGES)

bootstrap:
	./install.sh

install: $(PACKAGES)

stow: install

$(PACKAGES):
	stow $@

uninstall:
	stow -D $(PACKAGES)
