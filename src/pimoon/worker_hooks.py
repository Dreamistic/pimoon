"""Bounded in-worker counters, not a recorder of file contents or source paths."""
import os
from time import perf_counter

counts = {}
cpu_ms = 0.0
stdout_chars = stderr_chars = 0


def begin():
    global counts, cpu_ms, stdout_chars, stderr_chars
    counts = {}
    cpu_ms = 0.0
    stdout_chars = stderr_chars = 0


def audit(event, args):
    global cpu_ms
    if event not in {'open', 'os.remove', 'os.rmdir', 'os.mkdir', 'os.chdir', 'os.rename', 'os.replace', 'os.listdir', 'os.scandir'}:
        return
    start = perf_counter()
    counts[event] = counts.get(event, 0) + 1
    if event == 'open':
        _, mode, flags = args
        writing = (isinstance(mode, str) and any(c in mode for c in 'wax+')) or bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
        key = 'open_write' if writing else 'open_read'
        counts[key] = counts.get(key, 0) + 1
    cpu_ms += (perf_counter() - start) * 1000


class TaggedStream:
    def __init__(self, stream, stderr=False):
        self.stream, self.stderr = stream, stderr
    def write(self, text):
        global stdout_chars, stderr_chars
        if self.stderr: stderr_chars += len(text)
        else: stdout_chars += len(text)
        return self.stream.write(text)
    def flush(self):
        return self.stream.flush()
    def __getattr__(self, name):
        return getattr(self.stream, name)


def snapshot():
    return {'filesystem_metrics_version': 1, 'filesystem_audit_attempts': counts,
            'worker_telemetry_cpu_ms': cpu_ms, 'stdout_chars': stdout_chars, 'stderr_chars': stderr_chars}
