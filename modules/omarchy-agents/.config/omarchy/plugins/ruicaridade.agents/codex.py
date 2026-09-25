#!/usr/bin/env python3
"""Read subscription limits through Codex's read-only app-server protocol.

Like Orca's codex-rpc-rate-limit-probe, drain every complete JSON line and ask
for limits directly after initialize. No chat, credentials or account mutation.
"""
from datetime import datetime, timezone
import json
import math
import os
import selectors
import signal
import subprocess
import time


def collect():
    process = subprocess.Popen(['codex', '-s', 'read-only', '-a', 'on-request', 'app-server'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        bufsize=0, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    pending = b''

    def send(method, request_id=None, params=None):
        message = {'jsonrpc': '2.0', 'method': method, 'params': params or {}}
        if request_id is not None:
            message['id'] = request_id
        process.stdin.write((json.dumps(message) + '\n').encode())

    def receive(request_id):
        nonlocal pending
        deadline = time.monotonic() + 15
        while True:
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                try:
                    message = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if message.get('id') == request_id:
                    if 'error' in message:
                        raise RuntimeError('Codex rejected the usage request')
                    return message.get('result') or {}
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise TimeoutError('Codex usage request timed out')
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError('Codex app-server exited before returning usage')
            pending += chunk
            if len(pending) > 1024 * 1024:
                raise RuntimeError('Codex response exceeded the size limit')

    try:
        send('initialize', 1, {'clientInfo': {'name': 'dotfiles-agent-usage', 'version': '1.0'}})
        receive(1)
        send('initialized')
        send('account/rateLimits/read', 2)
        windows = receive(2).get('rateLimits') or {}
        limits = []
        for key in ('primary', 'secondary'):
            window = windows.get(key)
            if not isinstance(window, dict):
                continue
            used = window.get('usedPercent')
            if not isinstance(used, (int, float)) or not math.isfinite(used):
                continue
            minutes = window.get('windowDurationMins')
            label = 'Weekly (7-day)' if minutes == 10080 else f'{minutes // 60}h window' if minutes and minutes % 60 == 0 else 'Limit'
            reset = window.get('resetsAt')
            limits.append({'label': label, 'percent': used / 100,
                'resetsAt': datetime.fromtimestamp(reset, timezone.utc).isoformat() if reset else ''})
        return {'limits': limits, 'usageStatusText': '' if limits else 'Limits unavailable'}
    finally:
        selector.close()
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=2)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        process.stdin.close()
        process.stdout.close()


if __name__ == '__main__':
    try:
        print(json.dumps(collect()))
    except (OSError, RuntimeError, TimeoutError) as error:
        print(json.dumps({'limits': [], 'usageStatusText': str(error)}))
