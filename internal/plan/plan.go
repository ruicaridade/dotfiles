// Package plan works out what the installer would change, then applies it.
//
// Build never touches the filesystem beyond reading it, so the result can be
// shown for review before anything is written. Apply performs exactly the
// items the plan describes.
package plan

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ruicaridade/dotfiles/internal/manifest"
)

// Action is what the installer intends to do with a single path.
type Action string

const (
	// ActionLink creates a new symlink; nothing exists at the destination.
	ActionLink Action = "link"
	// ActionBackupLink moves an existing real file aside, then links.
	ActionBackupLink Action = "backup+link"
	// ActionUnlink removes a symlink that points into the repo.
	ActionUnlink Action = "unlink"
	// ActionUpToDate means the destination already points where it should.
	ActionUpToDate Action = "up-to-date"
)

// Item is one path the plan intends to change.
type Item struct {
	Module string
	Src    string // absolute path inside the repo
	Dest   string // absolute path under $HOME
	Action Action
	Backup string // absolute path an existing file is moved to
	IsDir  bool   // the link points at a directory, not a file

	// Replace means a stale symlink at Dest is removed before linking.
	Replace bool

	// Skip is toggled by the review screen. Apply honours it.
	Skip bool
}

// Packages is the resolved set of packages to install, deduplicated.
type Packages struct {
	Pacman []string
	AUR    []string
	Brew   []string
	Cask   []string
}

// Empty reports whether there is nothing to install.
func (p Packages) Empty() bool {
	return len(p.Pacman)+len(p.AUR)+len(p.Brew)+len(p.Cask) == 0
}

// Plan is the reviewable set of changes.
type Plan struct {
	Items      []Item
	Packages   Packages
	Posts      []string
	Submodules []string // repo-relative submodule paths that need initialising
}

// ModulesDir is where module trees live inside the repo, keeping the Go
// project at the root and the configs together in one place.
const ModulesDir = "modules"

// Config drives Build.
type Config struct {
	Repo      string
	Home      string
	GOOS      string
	Stamp     string // suffix for backup filenames
	Manifest  *manifest.Manifest
	Selection []string // module names the user wants linked

	// NoUnlink makes the selection additive: modules left out are ignored
	// rather than removed. The picker wants the declarative behaviour, but
	// `--modules foo` must not remove everything it was not told about.
	NoUnlink bool
}

// Result counts what Apply did.
type Result struct {
	Linked   int
	BackedUp int
	Unlinked int
	UpToDate int
	Skipped  int
}

// Build resolves the selection into concrete per-path actions.
func Build(cfg Config) (*Plan, error) {
	if cfg.Repo == "" || cfg.Home == "" {
		return nil, fmt.Errorf("plan: Repo and Home are required")
	}
	selected := map[string]bool{}
	for _, name := range cfg.Selection {
		selected[name] = true
	}

	subs, err := submodulePaths(cfg.Repo)
	if err != nil {
		return nil, err
	}

	p := &Plan{}
	seenPkg := map[string]bool{}

	for _, mod := range cfg.Manifest.For(cfg.GOOS) {
		links, err := moduleLinks(cfg, mod, subs)
		if err != nil {
			return nil, err
		}
		if !selected[mod.Name] {
			if !cfg.NoUnlink {
				p.Items = append(p.Items, unlinkItems(mod, links)...)
			}
			continue
		}
		for _, l := range links {
			item, err := classify(cfg, mod, l)
			if err != nil {
				return nil, err
			}
			p.Items = append(p.Items, item)
		}
		addPackages(&p.Packages, seenPkg, cfg.GOOS, mod)
		p.Posts = append(p.Posts, mod.Post...)
		p.Submodules = append(p.Submodules, neededSubmodules(cfg.Repo, mod, subs)...)
	}
	return p, nil
}

// Linked reports which modules are currently linked in full. A module with
// some files linked and some missing is not linked: the picker must show it
// unchecked so confirming the screen does not quietly remove the rest.
func Linked(cfg Config) (map[string]bool, error) {
	mods := cfg.Manifest.For(cfg.GOOS)
	cfg.Selection = make([]string, 0, len(mods))
	for _, mod := range mods {
		cfg.Selection = append(cfg.Selection, mod.Name)
	}

	p, err := Build(cfg)
	if err != nil {
		return nil, err
	}

	total := map[string]int{}
	current := map[string]int{}
	for _, item := range p.Items {
		total[item.Module]++
		if item.Action == ActionUpToDate {
			current[item.Module]++
		}
	}

	out := map[string]bool{}
	for _, mod := range mods {
		out[mod.Name] = total[mod.Name] > 0 && total[mod.Name] == current[mod.Name]
	}
	return out, nil
}

// link is a resolved source/destination pair before classification.
type link struct {
	src   string
	dest  string
	isDir bool
}

// moduleLinks resolves a module to source/destination pairs, either from an
// explicit links override or from the directory tree.
func moduleLinks(cfg Config, mod manifest.Module, subs map[string]bool) ([]link, error) {
	root := moduleRoot(cfg.Repo, mod.Name)

	if len(mod.Links) > 0 {
		var out []link
		for _, spec := range mod.Links {
			src := filepath.Join(root, filepath.Clean(spec.Src))
			info, err := os.Stat(src)
			if err != nil {
				return nil, fmt.Errorf("module %s: %w", mod.Name, err)
			}
			out = append(out, link{
				src:   src,
				dest:  expandDest(cfg.Home, spec.Dest),
				isDir: info.IsDir(),
			})
		}
		return out, nil
	}

	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var out []link
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// Two relative paths are needed: one from the repo root, because
		// .gitmodules records submodules that way, and one from the module
		// root, which is what maps onto $HOME.
		fromRepo, relErr := filepath.Rel(cfg.Repo, path)
		if relErr != nil {
			return relErr
		}
		fromModule, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		dest := filepath.Join(cfg.Home, fromModule)

		if d.IsDir() {
			if path == root {
				return nil
			}
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			// A submodule is linked as a whole directory: leaf-linking it
			// would scatter links through another repo's working tree and
			// its git metadata.
			if subs[filepath.ToSlash(fromRepo)] {
				out = append(out, link{src: path, dest: dest, isDir: true})
				return filepath.SkipDir
			}
			return nil
		}
		if d.Name() == ".git" {
			return nil
		}
		out = append(out, link{src: path, dest: dest})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("module %s: %w", mod.Name, err)
	}
	return out, nil
}

// moduleRoot is where a module's tree lives on disk.
func moduleRoot(repo, name string) string {
	return filepath.Join(repo, ModulesDir, name)
}

// expandDest resolves a manifest dest, which may start with ~/.
func expandDest(home, dest string) string {
	dest = filepath.ToSlash(dest)
	switch {
	case dest == "~":
		return home
	case strings.HasPrefix(dest, "~/"):
		dest = strings.TrimPrefix(dest, "~/")
	}
	return filepath.Join(home, filepath.FromSlash(dest))
}

// classify decides what to do with a single destination path.
func classify(cfg Config, mod manifest.Module, l link) (Item, error) {
	item := Item{Module: mod.Name, Src: l.src, Dest: l.dest, IsDir: l.isDir}

	info, err := os.Lstat(l.dest)
	if err != nil {
		if os.IsNotExist(err) {
			item.Action = ActionLink
			return item, nil
		}
		return item, err
	}

	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(l.dest)
		if err != nil {
			return item, err
		}
		if target == l.src {
			item.Action = ActionUpToDate
			return item, nil
		}
		// A link we own that points at the wrong path (the repo file moved or
		// was renamed) gets replaced. A symlink carries no content, so backing
		// it up would preserve nothing and leave litter behind.
		if under(cfg.Repo, target) {
			item.Action = ActionLink
			item.Replace = true
			return item, nil
		}
	}

	item.Action = ActionBackupLink
	item.Backup = fmt.Sprintf("%s.bak.%s", l.dest, cfg.Stamp)
	return item, nil
}

// under reports whether path sits inside dir.
func under(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// unlinkItems lists the destinations of a deselected module that currently
// point into the repo. Anything else is left alone.
func unlinkItems(mod manifest.Module, links []link) []Item {
	var out []Item
	for _, l := range links {
		info, err := os.Lstat(l.dest)
		if err != nil || info.Mode()&os.ModeSymlink == 0 {
			continue
		}
		target, err := os.Readlink(l.dest)
		if err != nil || target != l.src {
			continue
		}
		out = append(out, Item{
			Module: mod.Name,
			Src:    l.src,
			Dest:   l.dest,
			Action: ActionUnlink,
			IsDir:  l.isDir,
		})
	}
	return out
}

func addPackages(p *Packages, seen map[string]bool, goos string, mod manifest.Module) {
	add := func(kind string, list *[]string, names []string) {
		for _, n := range names {
			key := kind + "\x00" + n
			if seen[key] {
				continue
			}
			seen[key] = true
			*list = append(*list, n)
		}
	}
	switch goos {
	case "darwin":
		add("brew", &p.Brew, mod.Brew)
		add("cask", &p.Cask, mod.Cask)
	default:
		add("pacman", &p.Pacman, mod.Pacman)
		add("aur", &p.AUR, mod.AUR)
	}
}

// Conflicts returns the items that would move an existing file aside.
func (p *Plan) Conflicts() []int {
	var out []int
	for i, item := range p.Items {
		if item.Action == ActionBackupLink {
			out = append(out, i)
		}
	}
	return out
}

// Changes returns the indexes of items that would alter the filesystem.
func (p *Plan) Changes() []int {
	var out []int
	for i, item := range p.Items {
		if item.Action != ActionUpToDate {
			out = append(out, i)
		}
	}
	return out
}

// Apply carries out the plan, honouring per-item Skip flags.
func (p *Plan) Apply() (Result, error) {
	return p.run(false)
}

// Preview counts what Apply would do without touching the filesystem.
func (p *Plan) Preview() (Result, error) {
	return p.run(true)
}

func (p *Plan) run(dry bool) (Result, error) {
	var res Result
	for _, item := range p.Items {
		if item.Skip {
			res.Skipped++
			continue
		}
		switch item.Action {
		case ActionUpToDate:
			res.UpToDate++
		case ActionUnlink:
			if !dry {
				if err := os.Remove(item.Dest); err != nil {
					return res, fmt.Errorf("unlink %s: %w", item.Dest, err)
				}
			}
			res.Unlinked++
		case ActionBackupLink:
			if !dry {
				if err := os.Rename(item.Dest, item.Backup); err != nil {
					return res, fmt.Errorf("back up %s: %w", item.Dest, err)
				}
			}
			res.BackedUp++
			if !dry {
				if err := symlink(item); err != nil {
					return res, err
				}
			}
			res.Linked++
		case ActionLink:
			if !dry {
				if err := symlink(item); err != nil {
					return res, err
				}
			}
			res.Linked++
		default:
			return res, fmt.Errorf("unknown action %q for %s", item.Action, item.Dest)
		}
	}
	return res, nil
}

func symlink(item Item) error {
	if err := os.MkdirAll(filepath.Dir(item.Dest), 0o755); err != nil {
		return fmt.Errorf("mkdir for %s: %w", item.Dest, err)
	}
	if item.Replace {
		if err := os.Remove(item.Dest); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("replace %s: %w", item.Dest, err)
		}
	}
	if err := os.Symlink(item.Src, item.Dest); err != nil {
		return fmt.Errorf("link %s: %w", item.Dest, err)
	}
	return nil
}

// submodulePaths reads .gitmodules and returns the declared paths as a set of
// slash-separated, repo-relative paths.
func submodulePaths(repo string) (map[string]bool, error) {
	body, err := os.ReadFile(filepath.Join(repo, ".gitmodules"))
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]bool{}, nil
		}
		return nil, fmt.Errorf("read .gitmodules: %w", err)
	}
	out := map[string]bool{}
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		rest, ok := strings.CutPrefix(line, "path")
		if !ok {
			continue
		}
		rest = strings.TrimSpace(rest)
		if rest, ok = strings.CutPrefix(rest, "="); !ok {
			continue
		}
		if p := strings.TrimSpace(rest); p != "" {
			out[filepath.ToSlash(filepath.Clean(p))] = true
		}
	}
	return out, nil
}

// neededSubmodules lists this module's submodules whose working tree is still
// empty, meaning git has not checked them out yet.
func neededSubmodules(repo string, mod manifest.Module, subs map[string]bool) []string {
	prefix := filepath.ToSlash(filepath.Join(ModulesDir, mod.Name))
	var out []string
	for path := range subs {
		if path != prefix && !strings.HasPrefix(path, prefix+"/") {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(repo, filepath.FromSlash(path)))
		if err != nil || len(entries) == 0 {
			out = append(out, path)
		}
	}
	sort.Strings(out)
	return out
}
