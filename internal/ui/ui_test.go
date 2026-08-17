package ui_test

import (
	"reflect"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/ruicaridade/dotfiles/internal/manifest"
	"github.com/ruicaridade/dotfiles/internal/ui"
)

func press(l *ui.List, keys ...string) {
	for _, k := range keys {
		var msg tea.KeyMsg
		switch k {
		case "enter":
			msg = tea.KeyMsg{Type: tea.KeyEnter}
		case "space":
			msg = tea.KeyMsg{Type: tea.KeySpace}
		case "up":
			msg = tea.KeyMsg{Type: tea.KeyUp}
		case "down":
			msg = tea.KeyMsg{Type: tea.KeyDown}
		case "esc":
			msg = tea.KeyMsg{Type: tea.KeyEsc}
		default:
			msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
		}
		l.Update(msg)
	}
}

func modules() []manifest.Module {
	return []manifest.Module{
		{Name: "foot", Pacman: []string{"foot"}},
		{Name: "nvim", Pacman: []string{"neovim"}},
		{Name: "zsh", Pacman: []string{"zsh"}, Post: []string{"omz"}},
	}
}

// The picker opens reflecting what is linked, and confirming without touching
// anything returns exactly that. This is the case where a stray enter must not
// change the machine.
func TestPickerOpensWithCurrentStateAndConfirmsIt(t *testing.T) {
	l := ui.NewModuleList(modules(), map[string]bool{"nvim": true}, "linux")

	press(l, "enter")

	if !l.Confirmed() {
		t.Fatal("enter should confirm")
	}
	if got, want := l.Result(), []string{"nvim"}; !reflect.DeepEqual(got, want) {
		t.Errorf("Result = %v, want %v", got, want)
	}
}

// Space toggles the row under the cursor, in both directions.
func TestSpaceTogglesUnderCursor(t *testing.T) {
	l := ui.NewModuleList(modules(), map[string]bool{"nvim": true}, "linux")

	// Check foot (row 0), move to nvim (row 1) and uncheck it, check zsh.
	press(l, "space", "down", "space", "down", "space", "enter")

	if got, want := l.Result(), []string{"foot", "zsh"}; !reflect.DeepEqual(got, want) {
		t.Errorf("Result = %v, want %v", got, want)
	}
}

func TestAllAndNone(t *testing.T) {
	l := ui.NewModuleList(modules(), nil, "linux")
	press(l, "a", "enter")
	if got, want := l.Result(), []string{"foot", "nvim", "zsh"}; !reflect.DeepEqual(got, want) {
		t.Errorf("after 'a', Result = %v, want %v", got, want)
	}

	l = ui.NewModuleList(modules(), map[string]bool{"foot": true, "nvim": true}, "linux")
	press(l, "n", "enter")
	if got := l.Result(); len(got) != 0 {
		t.Errorf("after 'n', Result = %v, want none", got)
	}
}

// Quitting must be distinguishable from confirming an empty selection: one
// changes nothing, the other would unlink everything.
func TestQuitIsNotAnEmptyConfirmation(t *testing.T) {
	for _, key := range []string{"q", "esc", "ctrl+c"} {
		l := ui.NewModuleList(modules(), map[string]bool{"foot": true}, "linux")
		if key == "ctrl+c" {
			l.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
		} else {
			press(l, key)
		}
		if l.Confirmed() {
			t.Errorf("%q should not confirm", key)
		}
		if !l.Aborted() {
			t.Errorf("%q should abort", key)
		}
	}
}

// The cursor must not run off either end of the list.
func TestCursorStaysInBounds(t *testing.T) {
	l := ui.NewModuleList(modules(), nil, "linux")

	press(l, "up", "up", "up", "space") // still on the first row
	press(l, "G", "down", "down", "space")
	press(l, "enter")

	if got, want := l.Result(), []string{"foot", "zsh"}; !reflect.DeepEqual(got, want) {
		t.Errorf("Result = %v, want %v (first and last)", got, want)
	}
}
