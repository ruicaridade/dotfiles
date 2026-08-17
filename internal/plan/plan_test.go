package plan_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ruicaridade/dotfiles/internal/manifest"
	"github.com/ruicaridade/dotfiles/internal/plan"
)

// fixture builds a throwaway repo + home pair and returns both paths.
type fixture struct {
	repo string
	home string
	t    *testing.T
}

func newFixture(t *testing.T, dotsToml string) *fixture {
	t.Helper()
	root := t.TempDir()
	f := &fixture{
		repo: filepath.Join(root, "dotfiles"),
		home: filepath.Join(root, "home"),
		t:    t,
	}
	mustMkdirAll(t, f.repo)
	mustMkdirAll(t, f.home)
	f.writeRepo("dots.toml", dotsToml)
	return f
}

func (f *fixture) writeRepo(rel, body string) string {
	f.t.Helper()
	return writeFile(f.t, filepath.Join(f.repo, rel), body)
}

// writeModule writes a file inside a module's tree under modules/.
func (f *fixture) writeModule(rel, body string) string {
	f.t.Helper()
	return writeFile(f.t, filepath.Join(f.repo, "modules", rel), body)
}

func (f *fixture) writeHome(rel, body string) string {
	f.t.Helper()
	return writeFile(f.t, filepath.Join(f.home, rel), body)
}

func (f *fixture) build(goos string, selection ...string) *plan.Plan {
	f.t.Helper()
	m, err := manifest.Load(filepath.Join(f.repo, "dots.toml"))
	if err != nil {
		f.t.Fatalf("manifest.Load: %v", err)
	}
	p, err := plan.Build(plan.Config{
		Repo:      f.repo,
		Home:      f.home,
		GOOS:      goos,
		Stamp:     "STAMP",
		Manifest:  m,
		Selection: selection,
	})
	if err != nil {
		f.t.Fatalf("plan.Build: %v", err)
	}
	return p
}

func writeFile(t *testing.T, path, body string) string {
	t.Helper()
	mustMkdirAll(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

func mustMkdirAll(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
}

// assertSymlink checks that path is a symlink resolving to want.
func assertSymlink(t *testing.T, path, want string) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("lstat %s: %v", path, err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("%s is not a symlink (mode %s)", path, info.Mode())
	}
	got, err := os.Readlink(path)
	if err != nil {
		t.Fatalf("readlink %s: %v", path, err)
	}
	if got != want {
		t.Fatalf("%s points at %s, want %s", path, got, want)
	}
}

func assertContent(t *testing.T, path, want string) {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(body) != want {
		t.Fatalf("%s contains %q, want %q", path, body, want)
	}
}

func assertRealDir(t *testing.T, path string) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("lstat %s: %v", path, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("%s is a symlink, want a real directory", path)
	}
	if !info.IsDir() {
		t.Fatalf("%s is not a directory", path)
	}
}

// Flow 1: selecting a module on a clean machine leaf-links its files and
// leaves the parent directories as real dirs so other tools can coexist.
func TestFreshInstallLeafLinksFiles(t *testing.T) {
	f := newFixture(t, `
[module.foot]
platforms = ["linux"]
pacman    = ["foot"]
`)
	src := f.writeModule("foot/.config/foot/foot.ini", "font=x\n")

	p := f.build("linux", "foot")

	res, err := p.Apply()
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}

	dest := filepath.Join(f.home, ".config/foot/foot.ini")
	assertSymlink(t, dest, src)
	assertRealDir(t, filepath.Join(f.home, ".config/foot"))
	assertRealDir(t, filepath.Join(f.home, ".config"))

	if res.Linked != 1 {
		t.Errorf("Linked = %d, want 1", res.Linked)
	}
	if got := p.Packages.Pacman; len(got) != 1 || got[0] != "foot" {
		t.Errorf("Packages.Pacman = %v, want [foot]", got)
	}
}

// Flow 2: a destination that already holds a real file is reported as a
// conflict, backed up, then replaced. Toggling an item to Skip leaves the
// original file exactly where it was.
func TestConflictBacksUpThenLinks(t *testing.T) {
	f := newFixture(t, `
[module.foot]
pacman = ["foot"]

[module.zsh]
pacman = ["zsh"]
`)
	footSrc := f.writeModule("foot/.config/foot/foot.ini", "from repo\n")
	f.writeModule("zsh/.zshrc", "from repo\n")
	footDest := f.writeHome(".config/foot/foot.ini", "pre-existing\n")
	zshDest := f.writeHome(".zshrc", "hand written\n")

	p := f.build("linux", "foot", "zsh")

	if got := len(p.Conflicts()); got != 2 {
		t.Fatalf("Conflicts = %d, want 2", got)
	}

	// The review screen shows the backup path before anything is written.
	for _, i := range p.Conflicts() {
		item := p.Items[i]
		if want := item.Dest + ".bak.STAMP"; item.Backup != want {
			t.Errorf("Backup = %q, want %q", item.Backup, want)
		}
		// Keep .zshrc as it is.
		if item.Dest == zshDest {
			p.Items[i].Skip = true
		}
	}

	res, err := p.Apply()
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}

	assertSymlink(t, footDest, footSrc)
	assertContent(t, footDest+".bak.STAMP", "pre-existing\n")

	// The skipped file is untouched: still real, still its own content, and
	// no stray backup left behind.
	assertContent(t, zshDest, "hand written\n")
	if info, err := os.Lstat(zshDest); err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Errorf("%s should still be a real file", zshDest)
	}
	if _, err := os.Lstat(zshDest + ".bak.STAMP"); !os.IsNotExist(err) {
		t.Errorf("skipped item should not leave a backup")
	}

	if res.BackedUp != 1 || res.Linked != 1 || res.Skipped != 1 {
		t.Errorf("Result = %+v, want 1 backed up, 1 linked, 1 skipped", res)
	}
}

// Flow 3: deselecting a linked module removes its symlinks and nothing else.
// A real file or a symlink pointing outside the repo is never ours to delete.
func TestDeselectUnlinksOnlyRepoOwnedSymlinks(t *testing.T) {
	f := newFixture(t, `
[module.discord]
[module.waybar]
`)
	discordSrc := f.writeModule("discord/.config/discord/settings.json", "{}\n")
	f.writeModule("waybar/.config/waybar/style.css", "* {}\n")
	f.writeModule("waybar/.config/waybar/config.jsonc", "{}\n")

	// discord is linked, so deselecting it should remove the link.
	discordDest := filepath.Join(f.home, ".config/discord/settings.json")
	mustMkdirAll(t, filepath.Dir(discordDest))
	if err := os.Symlink(discordSrc, discordDest); err != nil {
		t.Fatal(err)
	}

	// waybar's destinations are not ours: one is a real file, one points at
	// something outside the repo entirely.
	realFile := f.writeHome(".config/waybar/style.css", "hand written\n")
	elsewhere := writeFile(t, filepath.Join(t.TempDir(), "other.jsonc"), "elsewhere\n")
	foreignLink := filepath.Join(f.home, ".config/waybar/config.jsonc")
	if err := os.Symlink(elsewhere, foreignLink); err != nil {
		t.Fatal(err)
	}

	// Select nothing: every module is deselected.
	p := f.build("linux")

	res, err := p.Apply()
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}

	if _, err := os.Lstat(discordDest); !os.IsNotExist(err) {
		t.Errorf("%s should have been unlinked", discordDest)
	}
	assertRealDir(t, filepath.Dir(discordDest))
	assertContent(t, realFile, "hand written\n")
	assertSymlink(t, foreignLink, elsewhere)

	if res.Unlinked != 1 {
		t.Errorf("Unlinked = %d, want 1 (only the repo-owned link)", res.Unlinked)
	}
	if res.Linked != 0 || res.BackedUp != 0 {
		t.Errorf("Result = %+v, want nothing linked or backed up", res)
	}
}

// Flow 4: a git submodule is linked as one directory rather than having every
// file inside it leaf-linked, which would scatter links through another repo's
// working tree and its git metadata.
func TestSubmoduleLinksAsDirectory(t *testing.T) {
	f := newFixture(t, `
[module.nvim]
pacman = ["neovim"]
`)
	f.writeRepo(".gitmodules", `[submodule "modules/nvim/.config/nvim"]
	path = modules/nvim/.config/nvim
	url = git@github.com:ruicaridade/nvim.git
`)
	src := filepath.Join(f.repo, "modules/nvim/.config/nvim")
	f.writeModule("nvim/.config/nvim/init.lua", "-- config\n")
	f.writeModule("nvim/.config/nvim/.git", "gitdir: ../../../.git/modules/nvim\n")
	f.writeModule("nvim/.config/nvim/lua/herdr.lua", "-- plugin\n")

	p := f.build("linux", "nvim")

	if len(p.Items) != 1 {
		t.Fatalf("got %d items, want 1 directory link: %+v", len(p.Items), p.Items)
	}
	if !p.Items[0].IsDir {
		t.Errorf("item should be marked as a directory link")
	}
	if len(p.Submodules) != 0 {
		t.Errorf("Submodules = %v, want none (already checked out)", p.Submodules)
	}

	if _, err := p.Apply(); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	assertSymlink(t, filepath.Join(f.home, ".config/nvim"), src)
	// Nothing from inside the submodule was linked individually.
	for _, stray := range []string{".config/nvim/.git", ".config/nvim/lua/herdr.lua"} {
		if _, err := os.Lstat(filepath.Join(f.home, filepath.FromSlash(stray))); err == nil {
			info, _ := os.Lstat(filepath.Join(f.home, filepath.FromSlash(stray)))
			if info.Mode()&os.ModeSymlink != 0 {
				t.Errorf("%s should not be linked individually", stray)
			}
		}
	}
}

// Flow 5: an unchecked-out submodule is reported so the caller can run
// git submodule update before linking an empty directory.
func TestEmptySubmoduleIsReportedForInit(t *testing.T) {
	f := newFixture(t, `
[module.nvim]
`)
	f.writeRepo(".gitmodules", `[submodule "modules/nvim/.config/nvim"]
	path = modules/nvim/.config/nvim
`)
	mustMkdirAll(t, filepath.Join(f.repo, "modules/nvim/.config/nvim"))

	p := f.build("linux", "nvim")

	want := []string{"modules/nvim/.config/nvim"}
	if len(p.Submodules) != 1 || p.Submodules[0] != want[0] {
		t.Errorf("Submodules = %v, want %v", p.Submodules, want)
	}
}

// Flow 6: a module whose target doesn't mirror $HOME uses the links override,
// linux-only modules vanish on darwin, and running twice changes nothing the
// second time.
func TestOverrideTargetAndPlatformFilteringAreIdempotent(t *testing.T) {
	f := newFixture(t, `
[module.pi]
brew  = ["pi-coding-agent"]
links = [{ src = ".", dest = "~/.pi/agent" }]

[module.niri]
platforms = ["linux"]
aur       = ["niri"]

[module.tmux]
brew   = ["tmux"]
pacman = ["tmux"]
`)
	piSrc := filepath.Join(f.repo, "modules/pi")
	f.writeModule("pi/AGENTS.md", "# agents\n")
	f.writeModule("pi/skills/commit/SKILL.md", "# commit\n")
	f.writeModule("niri/.config/niri/config.kdl", "// niri\n")
	f.writeModule("tmux/.tmux.conf", "set -g mouse on\n")
	f.writeModule("tmux/.config/tmux/tmux.conf", "set -g mouse on\n")

	p := f.build("darwin", "pi", "niri", "tmux")

	// niri is linux-only, so it is not even offered on darwin.
	for _, item := range p.Items {
		if item.Module == "niri" {
			t.Fatalf("niri should be excluded on darwin: %+v", item)
		}
	}
	if len(p.Packages.AUR) != 0 {
		t.Errorf("Packages.AUR = %v, want none on darwin", p.Packages.AUR)
	}
	if got := p.Packages.Brew; len(got) != 2 {
		t.Errorf("Packages.Brew = %v, want pi-coding-agent and tmux", got)
	}
	if len(p.Packages.Pacman) != 0 {
		t.Errorf("Packages.Pacman = %v, want none on darwin", p.Packages.Pacman)
	}

	res, err := p.Apply()
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}

	// The override links the whole module directory to a target that does not
	// mirror $HOME, rather than leaf-linking its contents.
	assertSymlink(t, filepath.Join(f.home, ".pi/agent"), piSrc)
	if _, err := os.Lstat(filepath.Join(f.home, "AGENTS.md")); !os.IsNotExist(err) {
		t.Errorf("override module should not leaf-link into $HOME")
	}
	// tmux legitimately wants the same content at two destinations.
	assertSymlink(t, filepath.Join(f.home, ".tmux.conf"), filepath.Join(f.repo, "modules/tmux/.tmux.conf"))
	assertSymlink(t, filepath.Join(f.home, ".config/tmux/tmux.conf"), filepath.Join(f.repo, "modules/tmux/.config/tmux/tmux.conf"))

	if res.Linked != 3 {
		t.Fatalf("Linked = %d, want 3 (pi, .tmux.conf, .config/tmux/tmux.conf)", res.Linked)
	}

	// Second run: everything is already correct, so nothing is a conflict and
	// nothing is rewritten.
	again := f.build("darwin", "pi", "niri", "tmux")
	if got := len(again.Conflicts()); got != 0 {
		t.Errorf("Conflicts on re-run = %d, want 0", got)
	}
	if got := len(again.Changes()); got != 0 {
		t.Errorf("Changes on re-run = %d, want 0", got)
	}
	res2, err := again.Apply()
	if err != nil {
		t.Fatalf("second Apply: %v", err)
	}
	if res2.Linked != 0 || res2.BackedUp != 0 || res2.UpToDate != 3 {
		t.Errorf("second Result = %+v, want 3 up-to-date and nothing written", res2)
	}
}

// Flow 7: a stale link the installer made itself (the repo file moved) is
// replaced outright. Backing it up would preserve nothing and leave litter.
// A link pointing somewhere outside the repo is not ours, so it is backed up.
func TestStaleRepoLinkIsReplacedNotBackedUp(t *testing.T) {
	f := newFixture(t, `
[module.foot]
[module.hunk]
`)
	footSrc := f.writeModule("foot/.config/foot/foot.ini", "current\n")
	hunkSrc := f.writeModule("hunk/.config/hunk/config.toml", "current\n")

	// A link this installer created for a file that has since been renamed.
	footDest := filepath.Join(f.home, ".config/foot/foot.ini")
	mustMkdirAll(t, filepath.Dir(footDest))
	if err := os.Symlink(filepath.Join(f.repo, "modules/foot/.config/foot/old-name.ini"), footDest); err != nil {
		t.Fatal(err)
	}

	// A link pointing outside the repo, which the user must have made.
	foreign := writeFile(t, filepath.Join(t.TempDir(), "elsewhere.toml"), "theirs\n")
	hunkDest := filepath.Join(f.home, ".config/hunk/config.toml")
	mustMkdirAll(t, filepath.Dir(hunkDest))
	if err := os.Symlink(foreign, hunkDest); err != nil {
		t.Fatal(err)
	}

	p := f.build("linux", "foot", "hunk")

	byDest := map[string]plan.Item{}
	for _, item := range p.Items {
		byDest[item.Dest] = item
	}

	if got := byDest[footDest]; got.Action != plan.ActionLink || got.Backup != "" {
		t.Errorf("stale repo link: Action = %q Backup = %q, want %q and no backup",
			got.Action, got.Backup, plan.ActionLink)
	}
	if got := byDest[hunkDest]; got.Action != plan.ActionBackupLink || got.Backup == "" {
		t.Errorf("foreign link: Action = %q Backup = %q, want %q with a backup",
			got.Action, got.Backup, plan.ActionBackupLink)
	}

	res, err := p.Apply()
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}

	assertSymlink(t, footDest, footSrc)
	if _, err := os.Lstat(footDest + ".bak.STAMP"); !os.IsNotExist(err) {
		t.Errorf("replacing our own stale link should not leave a backup")
	}
	assertSymlink(t, hunkDest, hunkSrc)
	assertSymlink(t, hunkDest+".bak.STAMP", foreign)

	if res.Linked != 2 || res.BackedUp != 1 {
		t.Errorf("Result = %+v, want 2 linked and 1 backed up", res)
	}
}

// Flow 8: a preview reports exactly what a real run would do and touches
// nothing, so --dry-run can be trusted before a first install.
func TestPreviewReportsWithoutTouchingAnything(t *testing.T) {
	f := newFixture(t, `
[module.foot]
[module.discord]
`)
	f.writeModule("foot/.config/foot/foot.ini", "from repo\n")
	discordSrc := f.writeModule("discord/.config/discord/settings.json", "{}\n")
	existing := f.writeHome(".config/foot/foot.ini", "pre-existing\n")

	// discord is linked but deselected below, so it is due to be unlinked.
	discordDest := filepath.Join(f.home, ".config/discord/settings.json")
	mustMkdirAll(t, filepath.Dir(discordDest))
	if err := os.Symlink(discordSrc, discordDest); err != nil {
		t.Fatal(err)
	}

	p := f.build("linux", "foot")

	res, err := p.Preview()
	if err != nil {
		t.Fatalf("Preview: %v", err)
	}
	if res.Linked != 1 || res.BackedUp != 1 || res.Unlinked != 1 {
		t.Errorf("Preview = %+v, want 1 linked, 1 backed up, 1 unlinked", res)
	}

	// Nothing moved.
	assertContent(t, existing, "pre-existing\n")
	if info, err := os.Lstat(existing); err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Errorf("%s should still be a real file after a preview", existing)
	}
	if _, err := os.Lstat(existing + ".bak.STAMP"); !os.IsNotExist(err) {
		t.Errorf("preview should not create a backup")
	}
	assertSymlink(t, discordDest, discordSrc)

	// A real run afterwards still does the work.
	real, err := p.Apply()
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if real != res {
		t.Errorf("Apply = %+v, want it to match the preview %+v", real, res)
	}
}

// Flow 9: the picker opens with boxes reflecting reality, so a module counts as
// linked only when every one of its files is in place. A half-linked module
// must not read as done, or confirming the screen would silently unlink it.
func TestLinkedReportsFullyLinkedModulesOnly(t *testing.T) {
	f := newFixture(t, `
[module.foot]
[module.waybar]
[module.discord]
`)
	f.writeModule("foot/.config/foot/foot.ini", "x\n")
	f.writeModule("waybar/.config/waybar/style.css", "x\n")
	f.writeModule("waybar/.config/waybar/config.jsonc", "x\n")
	f.writeModule("discord/.config/discord/settings.json", "x\n")

	// foot: fully linked. waybar: only one of two files linked.
	for _, pair := range [][2]string{
		{"foot/.config/foot/foot.ini", ".config/foot/foot.ini"},
		{"waybar/.config/waybar/style.css", ".config/waybar/style.css"},
	} {
		dest := filepath.Join(f.home, pair[1])
		mustMkdirAll(t, filepath.Dir(dest))
		if err := os.Symlink(filepath.Join(f.repo, "modules", pair[0]), dest); err != nil {
			t.Fatal(err)
		}
	}

	m, err := manifest.Load(filepath.Join(f.repo, "dots.toml"))
	if err != nil {
		t.Fatal(err)
	}
	linked, err := plan.Linked(plan.Config{
		Repo: f.repo, Home: f.home, GOOS: "linux", Stamp: "STAMP", Manifest: m,
	})
	if err != nil {
		t.Fatalf("Linked: %v", err)
	}

	if !linked["foot"] {
		t.Errorf("foot should read as linked")
	}
	if linked["waybar"] {
		t.Errorf("waybar is only half linked, it must not read as linked")
	}
	if linked["discord"] {
		t.Errorf("discord is not linked at all")
	}
}

// Flow 10: naming modules explicitly is additive. Unchecking a box in the
// picker means "remove this", but `--modules foot` must not be read as
// "remove everything except foot" — a non-interactive flag that deletes what
// it was never told about is a footgun.
func TestNoUnlinkKeepsUnnamedModulesAlone(t *testing.T) {
	f := newFixture(t, `
[module.foot]
[module.pi]
links = [{ src = ".", dest = "~/.pi/agent" }]
`)
	f.writeModule("foot/.config/foot/foot.ini", "x\n")
	piSrc := filepath.Join(f.repo, "modules/pi")
	f.writeModule("pi/AGENTS.md", "x\n")

	// pi is linked already and is not named in the selection below.
	piDest := filepath.Join(f.home, ".pi/agent")
	mustMkdirAll(t, filepath.Dir(piDest))
	if err := os.Symlink(piSrc, piDest); err != nil {
		t.Fatal(err)
	}

	m, err := manifest.Load(filepath.Join(f.repo, "dots.toml"))
	if err != nil {
		t.Fatal(err)
	}
	p, err := plan.Build(plan.Config{
		Repo: f.repo, Home: f.home, GOOS: "linux", Stamp: "STAMP",
		Manifest: m, Selection: []string{"foot"}, NoUnlink: true,
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}

	for _, item := range p.Items {
		if item.Action == plan.ActionUnlink {
			t.Errorf("NoUnlink should suppress removals, got %+v", item)
		}
	}

	res, err := p.Apply()
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if res.Unlinked != 0 {
		t.Errorf("Unlinked = %d, want 0", res.Unlinked)
	}
	assertSymlink(t, piDest, piSrc)
}
