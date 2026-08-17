// Package ui holds the two interactive screens: pick your modules, then look
// over what that would change before anything is written.
//
// Building a screen and running it are separate steps, so the keyboard
// behaviour can be exercised without a terminal.
package ui

import (
	"fmt"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/ruicaridade/dotfiles/internal/manifest"
	"github.com/ruicaridade/dotfiles/internal/plan"
)

// ErrAborted is returned when the user quits without confirming.
var ErrAborted = fmt.Errorf("aborted")

var (
	titleStyle  = lipgloss.NewStyle().Bold(true)
	dimStyle    = lipgloss.NewStyle().Faint(true)
	cursorStyle = lipgloss.NewStyle().Bold(true)
	addStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	warnStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("3"))
	delStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
)

// row is one line in either list.
type row struct {
	key     string // what Result reports when this row is checked
	label   string
	detail  string
	checked bool
	group   string
}

// List is a checkbox list. Both screens are one of these.
type List struct {
	title  string
	footer string
	rows   []row
	cursor int

	confirmed bool
	aborted   bool
}

// Confirmed reports whether the user pressed enter.
func (l *List) Confirmed() bool { return l.confirmed }

// Aborted reports whether the user quit without confirming.
func (l *List) Aborted() bool { return l.aborted }

// Result returns the keys of the checked rows, in display order.
func (l *List) Result() []string {
	var out []string
	for _, r := range l.rows {
		if r.checked {
			out = append(out, r.key)
		}
	}
	return out
}

// Checked reports the checked state of every row, in display order.
func (l *List) Checked() []bool {
	out := make([]bool, len(l.rows))
	for i, r := range l.rows {
		out[i] = r.checked
	}
	return out
}

func (l *List) Init() tea.Cmd { return nil }

func (l *List) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	key, ok := msg.(tea.KeyMsg)
	if !ok {
		return l, nil
	}
	switch key.String() {
	case "ctrl+c", "q", "esc":
		l.aborted = true
		return l, tea.Quit
	case "up", "k":
		if l.cursor > 0 {
			l.cursor--
		}
	case "down", "j":
		if l.cursor < len(l.rows)-1 {
			l.cursor++
		}
	case "g", "home":
		l.cursor = 0
	case "G", "end":
		l.cursor = len(l.rows) - 1
	case " ", "x":
		if len(l.rows) > 0 {
			l.rows[l.cursor].checked = !l.rows[l.cursor].checked
		}
	case "a":
		l.setAll(true)
	case "n":
		l.setAll(false)
	case "enter":
		l.confirmed = true
		return l, tea.Quit
	}
	return l, nil
}

func (l *List) setAll(v bool) {
	for i := range l.rows {
		l.rows[i].checked = v
	}
}

func (l *List) View() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render(l.title) + "\n\n")

	group := ""
	for i, r := range l.rows {
		if r.group != group {
			group = r.group
			b.WriteString("  " + dimStyle.Render(group) + "\n")
		}

		cursor := "  "
		if i == l.cursor {
			cursor = cursorStyle.Render("❯ ")
		}
		box := "[ ]"
		if r.checked {
			box = "[✓]"
		}
		label := r.label
		if !r.checked {
			label = dimStyle.Render(label)
		}
		b.WriteString(fmt.Sprintf("%s%s %s", cursor, box, label))
		if r.detail != "" {
			b.WriteString("  " + dimStyle.Render(r.detail))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n" + dimStyle.Render(l.footer) + "\n")
	return b.String()
}

// Run shows the list and blocks until the user confirms or quits.
func Run(l *List) error {
	if len(l.rows) == 0 {
		l.confirmed = true
		return nil
	}
	if _, err := tea.NewProgram(l).Run(); err != nil {
		return err
	}
	if !l.confirmed {
		return ErrAborted
	}
	return nil
}

// NewModuleList builds the module picker. Boxes start checked for whatever is
// linked right now, so the screen doubles as a status view.
func NewModuleList(mods []manifest.Module, linked map[string]bool, goos string) *List {
	l := &List{
		title:  fmt.Sprintf("dots — modules for %s", goos),
		footer: "↑/↓ move · space toggle · a all · n none · enter continue · q cancel",
	}
	for _, mod := range mods {
		l.rows = append(l.rows, row{
			key:     mod.Name,
			label:   mod.Name,
			detail:  moduleDetail(mod, goos),
			checked: linked[mod.Name],
		})
	}
	return l
}

// SelectModules asks which modules should be linked.
func SelectModules(mods []manifest.Module, linked map[string]bool, goos string) ([]string, error) {
	l := NewModuleList(mods, linked, goos)
	if err := Run(l); err != nil {
		return nil, err
	}
	return l.Result(), nil
}

func moduleDetail(mod manifest.Module, goos string) string {
	var parts []string
	if mod.Description != "" {
		parts = append(parts, mod.Description)
	}

	var pkgs []string
	if goos == "darwin" {
		pkgs = append(pkgs, mod.Brew...)
		pkgs = append(pkgs, mod.Cask...)
	} else {
		pkgs = append(pkgs, mod.Pacman...)
		pkgs = append(pkgs, mod.AUR...)
	}
	if len(pkgs) > 0 {
		parts = append(parts, strings.Join(pkgs, " "))
	}
	if len(mod.Post) > 0 {
		parts = append(parts, "+"+strings.Join(mod.Post, ","))
	}
	return strings.Join(parts, " · ")
}

// NewReviewList builds the change-review screen. It returns the list and the
// plan item index behind each row.
func NewReviewList(p *plan.Plan, home string) (*List, []int) {
	changes := p.Changes()
	l := &List{
		title:  fmt.Sprintf("dots — %s", summarise(p, changes)),
		footer: "↑/↓ move · space skip · a keep all · n skip all · enter apply · q cancel",
	}
	for _, i := range changes {
		item := p.Items[i]
		l.rows = append(l.rows, row{
			key:     item.Dest,
			label:   actionLabel(item, home),
			detail:  changeDetail(item),
			checked: true,
			group:   item.Module,
		})
	}
	return l, changes
}

// ReviewChanges shows every pending change and lets individual ones be
// skipped, writing the outcome back into the plan's Skip flags. A plan that
// changes nothing needs no review.
func ReviewChanges(p *plan.Plan, home string) error {
	l, changes := NewReviewList(p, home)
	if len(changes) == 0 {
		return nil
	}
	if err := Run(l); err != nil {
		return err
	}
	for n, keep := range l.Checked() {
		p.Items[changes[n]].Skip = !keep
	}
	return nil
}

func actionLabel(item plan.Item, home string) string {
	dest := shorten(item.Dest, home)
	switch item.Action {
	case plan.ActionBackupLink:
		return warnStyle.Render("backup+link") + " " + dest
	case plan.ActionUnlink:
		return delStyle.Render("unlink     ") + " " + dest
	default:
		if item.Replace {
			return addStyle.Render("relink     ") + " " + dest
		}
		return addStyle.Render("link       ") + " " + dest
	}
}

func changeDetail(item plan.Item) string {
	switch item.Action {
	case plan.ActionBackupLink:
		return "→ " + filepath.Base(item.Backup)
	case plan.ActionUnlink:
		return "was linked"
	default:
		if item.IsDir {
			return "directory"
		}
		return ""
	}
}

func summarise(p *plan.Plan, changes []int) string {
	var link, backup, unlink int
	for _, i := range changes {
		switch p.Items[i].Action {
		case plan.ActionBackupLink:
			backup++
		case plan.ActionUnlink:
			unlink++
		default:
			link++
		}
	}
	var parts []string
	if link > 0 {
		parts = append(parts, fmt.Sprintf("%d to link", link))
	}
	if backup > 0 {
		parts = append(parts, fmt.Sprintf("%d to back up", backup))
	}
	if unlink > 0 {
		parts = append(parts, fmt.Sprintf("%d to unlink", unlink))
	}
	if len(parts) == 0 {
		return "nothing to change"
	}
	return strings.Join(parts, ", ")
}

// shorten renders a path under home as ~/... for readability.
func shorten(path, home string) string {
	if home == "" {
		return path
	}
	rel, err := filepath.Rel(home, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		return path
	}
	return "~/" + filepath.ToSlash(rel)
}
