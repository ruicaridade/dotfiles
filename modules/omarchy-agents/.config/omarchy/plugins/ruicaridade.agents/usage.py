#!/usr/bin/env python3
"""Cached Claude and Codex subscription usage, independent of a Herdr session."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent


def state_dir():
    return Path(os.environ.get('OMARCHY_AGENT_USAGE_STATE_DIR') or
                (Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) /
                 'omarchy/agent-limits'))


def read_cache(path):
    try:
        data = json.loads(path.read_text())
        if isinstance(data, dict) and isinstance(data.get('providers'), list):
            return data
    except (OSError, ValueError):
        pass
    return {'providers': [], 'checkedAt': 0}


def fetch(command):
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   start_new_session=True)
        try:
            output, _ = process.communicate(timeout=35)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            return {'limits': [], 'usageStatusText': 'Request timed out'}
        if process.returncode:
            return {'limits': [], 'usageStatusText': 'Collector unavailable'}
        record = json.loads(output)
        if command[0] == 'omarchy-agent-usage-claude' and record.get('limits'):
            # The stock collector may silently reuse its last successful probe.
            # Its cache timestamp is the age of the provider response, unlike the
            # freshly generated transcript record's timestamp.
            cache = Path(os.environ.get('XDG_CACHE_HOME', Path.home()/'.cache')) / 'omarchy/agent-usage/claude-limits.json'
            try:
                fetched = json.loads(cache.read_text()).get('fetchedAtMs', 0) / 1000
                if fetched and time.time() - fetched > 90:
                    record['usageStatusText'] = record.get('usageStatusText') or 'Claude refresh failed; showing saved limits'
            except (OSError, ValueError, TypeError):
                pass
        return record
    except (OSError, ValueError):
        return {'limits': [], 'usageStatusText': 'Collector unavailable'}


def valid_limits(record, now):
    result = []
    for item in record.get('limits') or []:
        if not isinstance(item, dict):
            continue
        used = item.get('percent')
        if not isinstance(used, (int, float)) or not math.isfinite(used):
            continue
        reset = item.get('resetsAt') or ''
        if reset:
            try:
                if datetime.fromisoformat(reset.replace('Z', '+00:00')).timestamp() <= now:
                    continue
            except (ValueError, TypeError):
                reset = ''
        result.append({'label': str(item.get('label') or 'Limit'),
                       'percent': max(0, min(1, used)), 'resetsAt': reset})
    return result


def collect(force=False):
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / 'usage.json'
    with (directory / 'usage.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cached = read_cache(path)
        now = time.time()
        if not force and 0 <= now - cached.get('checkedAt', 0) < 30:
            return cached
        commands = [['omarchy-agent-usage-claude', '--limits-only'],
                    [sys.executable, str(ROOT / 'codex.py')]]
        with ThreadPoolExecutor(max_workers=2) as pool:
            records = list(pool.map(fetch, commands))
        providers = []
        for name, record in zip(('Claude', 'Codex'), records):
            previous = next((p for p in cached['providers'] if p.get('name') == name), {})
            limits = valid_limits(record, now)
            error = str(record.get('usageStatusText') or '')
            if not limits and not error:
                error = 'Limits unavailable'
            stale = bool(error)
            if not limits:
                limits = valid_limits(previous, now)
            providers.append({'name': name, 'limits': limits, 'stale': stale,
                              'error': error,
                              'updatedAt': previous.get('updatedAt', 0) if stale else now})
        result = {'providers': providers, 'checkedAt': now}
        with tempfile.NamedTemporaryFile(mode='w', dir=directory, delete=False) as out:
            json.dump(result, out)
            temporary = out.name
        os.replace(temporary, path)
        return result


if __name__ == '__main__':
    print(json.dumps(collect(force='--force' in sys.argv)))
