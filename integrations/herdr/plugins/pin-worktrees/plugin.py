#!/usr/bin/env python3
"""Persistent ordered worktree shortcuts for the local Herdr sidebar bridge."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def state_dir():
    return Path(os.environ.get('HERDR_PLUGIN_STATE_DIR') or
                (Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) /
                 'herdr/plugins/rui.pin-worktrees'))


def main():
    args = sys.argv[1:] or ['snapshot']
    if args[0] == 'panel':
        from panel import main as panel_main
        panel_main()
        return
    if args[0] == 'open':
        from session import call
        call('plugin', 'pane', 'open', '--plugin', 'rui.pin-worktrees', '--entrypoint', 'picker')
        return
    if args[0] == 'select':
        from session import focus
        pins = json.loads(subprocess.check_output([sys.executable, __file__, 'snapshot']))['pins']
        index = int(args[1]) - 1
        if 0 <= index < len(pins):
            focus(pins[index])
        return
    if args[0] == 'toggle-current':
        from session import snapshot, workspace_path
        data = snapshot()
        workspace_id = os.environ.get('HERDR_WORKSPACE_ID', data['focused_workspace_id'])
        workspace = next(w for w in data['workspaces'] if w['workspace_id'] == workspace_id)
        checkout = workspace_path(workspace, data)
        if not checkout:
            raise ValueError('Selected workspace has no directory')
        args = ['toggle', checkout]
    if args[0] not in ('snapshot', 'toggle', 'move') or len(args) != {'snapshot': 1, 'toggle': 2, 'move': 3}[args[0]]:
        raise ValueError('Usage: plugin.py snapshot | toggle PATH | move SOURCE TARGET')
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / 'pins.json'
    with (directory / 'pins.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        pins = json.loads(path.read_text())['pins'] if path.exists() else []
        if not isinstance(pins, list) or any(not isinstance(p, str) for p in pins):
            raise ValueError('Invalid saved pins; refusing to overwrite them')
        if args[0] == 'toggle':
            item = str(Path(args[1]).expanduser().resolve())
            if item in pins:
                pins.remove(item)
            else:
                pins.append(item)
        elif args[0] == 'move' and args[1] != args[2]:
            source, target = args[1:]
            if source in pins and target in pins:
                # Moving down inserts after target; moving up inserts before it.
                destination = pins.index(target)
                pins.remove(source)
                pins.insert(destination, source)
        result = json.dumps({'pins': pins}, separators=(',', ':'))
        if args[0] != 'snapshot':
            with tempfile.NamedTemporaryFile(mode='w', dir=directory, delete=False) as out:
                out.write(result + '\n')
                temporary = out.name
            os.replace(temporary, path)
        print(result)


if __name__ == '__main__':
    main()
