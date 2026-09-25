"""Herdr's public CLI, scoped to the invoking session via its environment."""
import json
import os
from pathlib import Path
import subprocess


def call(*args):
    result = subprocess.run([os.environ.get('HERDR_BIN_PATH', 'herdr'), *args],
                            capture_output=True, text=True, timeout=8)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or 'Herdr command failed')
    return json.loads(result.stdout) if result.stdout.strip() else {}


def snapshot():
    return call('api', 'snapshot')['result']['snapshot']


def workspace_path(workspace, data):
    checkout = (workspace.get('worktree') or {}).get('checkout_path')
    if checkout:
        return checkout
    tab_ids = {tab['tab_id'] for tab in data.get('tabs', []) if tab['workspace_id'] == workspace['workspace_id']}
    for pane in data.get('panes', []):
        if pane.get('tab_id') in tab_ids and pane.get('cwd'):
            return pane['cwd']
    return None


def focus(path):
    data = snapshot()
    workspace = next((w for w in data['workspaces'] if workspace_path(w, data) == path), None)
    if workspace:
        return call('workspace', 'focus', workspace['workspace_id'])
    if not Path(path).is_dir():
        raise RuntimeError('Pinned checkout no longer exists; Ctrl+P removes the pin')
    return call('workspace', 'create', '--cwd', path, '--focus')
