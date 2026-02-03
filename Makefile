PACKAGES := fuzzel ghostty mise niri nvim tmux waybar zsh

.PHONY: install uninstall $(PACKAGES)

install: $(PACKAGES)

$(PACKAGES):
	stow $@

uninstall:
	stow -D $(PACKAGES)
