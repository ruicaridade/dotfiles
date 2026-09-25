"""Mouse and keyboard worktree picker, hosted by stock Herdr's popup API."""
import curses
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import subprocess
import sys
import time

import session

ROOT = Path(__file__).resolve().parent


def pins_command(*args):
    result = subprocess.run([sys.executable, str(ROOT / 'plugin.py'), *args],
                            text=True, capture_output=True, timeout=3)
    if result.returncode:
        raise RuntimeError(result.stderr.strip().splitlines()[-1] or 'Could not save pins')
    return json.loads(result.stdout)['pins']


def rows_for(data, pins):
    workspaces = data.get('workspaces', [])
    paths = {session.workspace_path(w, data): w for w in workspaces}
    rows = [{'kind': 'header', 'label': 'PINNED'}]
    for index, path in enumerate(pins):
        workspace = paths.get(path)
        label = workspace['label'] if workspace else Path(path).name + ' (closed)'
        rows.append({'kind': 'pin', 'label': label, 'path': path, 'slot': index + 1,
                     'id': workspace['workspace_id'] if workspace else path})
    if not pins:
        rows.append({'kind': 'header', 'label': 'No pinned workspaces'})
        rows.append({'kind': 'header', 'label': 'prefix+Ctrl+P pins the active workspace'})
    return rows


def clean(text):
    return ''.join(c if c.isprintable() else ' ' for c in str(text))


def run(screen):
    curses.curs_set(0)
    curses.use_default_colors()
    curses.init_pair(1, curses.COLOR_BLACK, curses.COLOR_CYAN)
    curses.init_pair(2, curses.COLOR_CYAN, -1)
    curses.mousemask(curses.ALL_MOUSE_EVENTS | curses.REPORT_MOUSE_POSITION)
    curses.mouseinterval(0)
    # Herdr relays mouse events and extended keyboard input into the popup PTY.
    sys.stdout.write('\x1b[?1002h\x1b[>1u')
    sys.stdout.flush()
    screen.timeout(100)
    screen.keypad(True)
    pins = pins_command('snapshot')
    data, rows, selected, offset = {}, [], 0, 0
    message = 'Loading workspaces…'
    pending_drag = None
    last_refresh = 0
    executor = ThreadPoolExecutor(max_workers=1)
    future = None
    try:
        while True:
            if future is None and time.monotonic() - last_refresh > 2:
                future = executor.submit(session.snapshot)
                last_refresh = time.monotonic()
            if future is not None and future.done():
                try:
                    data = future.result()
                    message = ''
                except Exception as error:
                    message = str(error)
                future = None
            old = rows[selected] if rows and selected < len(rows) else None
            rows = rows_for(data, pins)
            candidates = [i for i, row in enumerate(rows) if row['kind'] != 'header']
            if old:
                selected = next((i for i, row in enumerate(rows) if row['kind'] == old['kind'] and row.get('id') == old.get('id')), selected)
            if selected not in candidates:
                selected = next((i for i in candidates if rows[i].get('id') == data.get('focused_workspace_id')), candidates[0] if candidates else 0)
            height, width = screen.getmaxyx()
            screen.erase()
            def draw(y, text, style=0, x=2):
                if 0 <= y < height and width > x + 1:
                    try:
                        screen.addnstr(y, x, clean(text), width-x-1, style)
                    except curses.error:
                        pass
            draw(0, 'Pinned workspaces', curses.A_BOLD)
            available = max(1, height - 5)
            if selected < offset:
                offset = selected
            if selected >= offset + available:
                offset = selected - available + 1
            hit_rows = {}
            for y, index in enumerate(range(offset, min(len(rows), offset+available)), 2):
                row = rows[index]
                if row['kind'] == 'header':
                    draw(y, row['label'], curses.color_pair(2) | curses.A_BOLD)
                    continue
                hit_rows[y] = index
                prefix = f"{row['slot']} · "
                style = curses.color_pair(1) | curses.A_BOLD if index == selected else 0
                draw(y, (prefix + row['label']).ljust(max(0, width-3)), style)
            draw(height-3, message or (rows[selected].get('path') or '') if rows else message, curses.A_DIM)
            draw(height-2, '↑↓/jk move  Enter/l open  Ctrl+P unpin  J/K reorder', curses.A_DIM)
            draw(height-1, 'Drag pins to reorder · 1–9 switch · Esc close', curses.A_DIM)
            screen.refresh()
            try:
                key = screen.get_wch()
            except curses.error:
                continue
            # Parse modified digit reports forwarded by modern terminals.
            if key == '\x1b':
                sequence = ''
                screen.timeout(25)
                try:
                    for _ in range(24):
                        char = screen.get_wch()
                        if not isinstance(char, str):
                            break
                        sequence += char
                        if char in 'u~':
                            break
                except curses.error:
                    pass
                screen.timeout(100)
                match = re.fullmatch(r'\[(\d+)(?:;(\d+)(?::[123])?)?u', sequence)
                if match:
                    code = int(match.group(1))
                    modifiers = int(match.group(2) or 1) - 1
                    if code > 0x10ffff:
                        continue
                    key = chr(code)
                    if modifiers & 4 and key.isascii() and key.isalpha():
                        key = chr(ord(key.lower()) & 31)
                    elif modifiers & 1:
                        key = key.upper()
                    if key == '\x1b':
                        break
                elif not sequence:
                    break
                else:
                    continue
            if key in ('q', '\x03'):
                break
            row = rows[selected] if rows and selected in candidates else None
            try:
                if key in (curses.KEY_UP, 'k', curses.KEY_DOWN, 'j') and candidates:
                    delta = -1 if key in (curses.KEY_UP, 'k') else 1
                    selected = candidates[(candidates.index(selected) + delta) % len(candidates)]
                elif key == '\x10' and row and row.get('path'):
                    pins = pins_command('toggle', row['path'])
                    message = 'Pinned' if row['path'] in pins else 'Unpinned'
                elif key in ('J', 'K') and row and row['kind'] == 'pin':
                    index = pins.index(row['path'])
                    target = index + (1 if key == 'J' else -1)
                    if 0 <= target < len(pins):
                        pins = pins_command('move', row['path'], pins[target])
                elif key in ('h', curses.KEY_LEFT):
                    break
                elif isinstance(key, str) and key in '123456789' and int(key) <= len(pins):
                    session.focus(pins[int(key)-1])
                    break
                elif key in ('\n', '\r', curses.KEY_ENTER, 'l', curses.KEY_RIGHT) and row:
                    if row.get('path'):
                        session.focus(row['path'])
                    else:
                        session.call('workspace', 'focus', row['id'])
                    break
                elif key == curses.KEY_MOUSE:
                    _, _, y, _, buttons = curses.getmouse()
                    target = hit_rows.get(y)
                    if buttons & (curses.BUTTON4_PRESSED | curses.BUTTON5_PRESSED) and candidates:
                        delta = -1 if buttons & curses.BUTTON4_PRESSED else 1
                        selected = candidates[max(0,min(len(candidates)-1,candidates.index(selected)+delta))]
                    elif buttons & curses.BUTTON1_PRESSED and target is not None:
                        selected = target
                        pending_drag = rows[target]
                    elif buttons & curses.BUTTON1_RELEASED and pending_drag:
                        if target is not None:
                            destination = rows[target]
                            if pending_drag['kind'] == destination['kind'] == 'pin' and pending_drag['path'] != destination['path']:
                                pins = pins_command('move', pending_drag['path'], destination['path'])
                                selected = target
                            elif pending_drag.get('id') == destination.get('id'):
                                if destination.get('path'):
                                    session.focus(destination['path'])
                                else:
                                    session.call('workspace','focus',destination['id'])
                                break
                        pending_drag = None
            except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
                message = str(error)
    finally:
        sys.stdout.write('\x1b[<u\x1b[?1002l')
        sys.stdout.flush()
        executor.shutdown(wait=False, cancel_futures=True)


def main():
    curses.wrapper(run)
