"""Bounded in-worker counters, not a recorder of file contents or source paths."""
import hashlib
import os
from time import perf_counter

counts = {}
native_events = []
native_count = native_failures = native_result_chars = 0
native_ms = 0.0
cpu_ms = 0.0
stdout_chars = stderr_chars = 0


def begin():
    global counts, native_events, native_count, native_failures, native_result_chars, native_ms, cpu_ms, stdout_chars, stderr_chars
    counts = {}; native_events = []; native_count = native_failures = native_result_chars = 0
    native_ms = cpu_ms = 0.0
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


def record_native(target, ok, result, elapsed):
    global native_count, native_failures, native_result_chars, native_ms, cpu_ms
    start = perf_counter()
    native_count += 1
    native_ms += elapsed
    if ok:
        native_result_chars += len(result)
    else:
        native_failures += 1
    if len(native_events) < 128:
        try:
            target_hash = hashlib.sha256(os.fsencode(target)).hexdigest()
        except Exception:
            target_hash = None
        native_events.append({'index': native_count, 'target_sha256': target_hash, 'ok': ok,
                              'elapsed_ms': elapsed, 'result_chars': len(result) if ok else None})
    cpu_ms += (perf_counter() - start) * 1000


def wrap_native(function):
    def run(target):
        global native_count, native_failures, native_result_chars, native_ms, cpu_ms
        start = perf_counter(); ok = False; result = None
        try:
            result = function(target); ok = True; return result
        finally:
            elapsed = (perf_counter() - start) * 1000
            record_native(target, ok, result, elapsed)
    return run


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
    return {'filesystem_metrics_version': 1, 'filesystem_audit_attempts': counts, 'native_read_calls_observed': native_count,
            'native_read_failures': native_failures, 'native_read_result_chars': native_result_chars, 'native_read_ms': native_ms,
            'native_read_trace': native_events, 'native_read_trace_complete': native_count == len(native_events),
            'worker_telemetry_cpu_ms': cpu_ms, 'stdout_chars': stdout_chars, 'stderr_chars': stderr_chars}
