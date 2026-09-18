#!/usr/bin/env python3
"""Manage one local development process group without killing unrelated servers."""

import errno
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = Path(__file__).resolve()
STATE = ROOT / '.berdloop'
PID_FILE = STATE / 'dev.json'
LOG_FILE = STATE / 'dev.log'
LOCK = STATE / 'command.lock'


def managed_pid():
    try:
        pid = json.loads(PID_FILE.read_text())['pid']
        if not isinstance(pid, int) or pid <= 1:
            return None
        command = subprocess.run(
            ['ps', '-p', str(pid), '-o', 'command='],
            capture_output=True, text=True, check=False,
        ).stdout
        if str(SCRIPT) in command and 'serve' in command and os.getpgid(pid) == pid:
            return pid
    except (FileNotFoundError, ProcessLookupError, ValueError, KeyError, json.JSONDecodeError):
        pass
    return None


def serve():
    children = []

    def finish(*_):
        # All children inherit this dedicated process group. Never kill by port or name.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        os.killpg(os.getpid(), signal.SIGTERM)
        deadline = time.monotonic() + 5
        while any(child.poll() is None for child in children) and time.monotonic() < deadline:
            time.sleep(0.1)
        PID_FILE.unlink(missing_ok=True)
        print('Development processes stopped.', flush=True)
        # Reap grandchildren even if their direct parent exited before them.
        os.killpg(os.getpid(), signal.SIGKILL)

    signal.signal(signal.SIGTERM, finish)
    signal.signal(signal.SIGINT, finish)
    PID_FILE.write_text(json.dumps({'pid': os.getpid()}))
    print(f'\n--- Berdloop development: {time.strftime("%Y-%m-%d %H:%M:%S")} ---', flush=True)
    try:
        for command in ('dev:web', 'dev:desktop'):
            children.append(subprocess.Popen(['bun', 'run', command], cwd=ROOT))
        while all(child.poll() is None for child in children):
            time.sleep(0.25)
        print('A development process exited. Stopping the remaining processes.', flush=True)
    finally:
        finish()


def up():
    pid = managed_pid()
    if pid:
        print(f'Berdloop is already running (supervisor {pid}). Use make logs.')
        return
    for executable in ('bun', 'cargo'):
        if not shutil.which(executable):
            raise RuntimeError(f'{executable} is required. See README.md.')
    if not (ROOT / 'node_modules').is_dir():
        raise RuntimeError('Run bun install --frozen-lockfile first.')
    for port in (5173, 1420):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(('127.0.0.1', port))
            except OSError as error:
                if error.errno == errno.EADDRINUSE:
                    raise RuntimeError(f'Port {port} is in use. Stop the existing server before make up.') from None
                raise RuntimeError(f'Cannot use port {port}: {error}') from None
    PID_FILE.unlink(missing_ok=True)
    with LOG_FILE.open('a') as log:
        process = subprocess.Popen(
            [sys.executable, str(SCRIPT), 'serve'], cwd=ROOT,
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    for _ in range(30):
        time.sleep(0.1)
        if process.poll() is not None:
            raise RuntimeError('Startup failed. Run make logs for details.')
    if managed_pid() != process.pid:
        raise RuntimeError('Supervisor did not start. Run make logs for details.')
    print('Website: http://127.0.0.1:5173')
    print('Desktop UI: http://127.0.0.1:1420')
    print('The native app opens after Rust compilation. Use make logs for progress.')


def down():
    pid = managed_pid()
    if not pid:
        PID_FILE.unlink(missing_ok=True)
        print('No managed development processes are running.')
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(80):
        time.sleep(0.1)
        if managed_pid() != pid:
            print('Berdloop development stopped.')
            return
    # Verify ownership again before forced shutdown.
    if managed_pid() == pid:
        os.killpg(pid, signal.SIGKILL)
    PID_FILE.unlink(missing_ok=True)
    print('Berdloop development stopped.')


def main():
    if os.name != 'posix':
        raise RuntimeError('Make commands require macOS or Linux. Use the Bun commands on Windows.')
    STATE.mkdir(exist_ok=True)
    action = sys.argv[1] if len(sys.argv) == 2 else ''
    if action == 'serve':
        serve()
    elif action == 'logs':
        LOG_FILE.touch(exist_ok=True)
        os.execvp('tail', ['tail', '-n', '100', '-F', str(LOG_FILE)])
    elif action in ('up', 'down'):
        try:
            LOCK.mkdir()
        except FileExistsError:
            raise RuntimeError('Another make up/down command is active. Try again after it completes.') from None
        try:
            (up if action == 'up' else down)()
        finally:
            LOCK.rmdir()
    else:
        raise RuntimeError('Use make up, make down, make test, or make logs.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError) as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
