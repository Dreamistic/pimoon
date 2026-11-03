"""Real persistent CPython behind CA02 framing. Trusted synthetic code only, not a hardened sandbox."""
import builtins
from collections import OrderedDict
import contextlib
import io
import json
import os
from pathlib import Path
import struct
import sys
from time import perf_counter
import traceback
import types
from observations import Observations, PLAIN_PRINT
import worker_hooks as hooks

HEADER = struct.Struct('<4sBIII')
MAX_FRAME = 8 * 1024 * 1024
INPUT, OUTPUT = sys.stdin.buffer, sys.stdout.buffer
ROOT, LIBROOT = Path.cwd().resolve(), Path(sys.base_prefix).resolve()
INIT, EXEC, REPLY, CANCEL, CLOSE, PING, NATIVE = range(1, 8)
READY, DONE, CALL, NATIVE_RESULT, PONG, ERROR = 101, 102, 103, 107, 108, 109
SESSION = REQUEST = 0


def receive():
    header = INPUT.read(HEADER.size)
    if not header:
        return None
    if len(header) != HEADER.size:
        raise EOFError('incomplete header')
    magic, op, session, request, size = HEADER.unpack(header)
    if magic != b'CA02' or size > MAX_FRAME:
        raise ValueError('invalid frame')
    data = INPUT.read(size)
    if len(data) != size:
        raise EOFError('incomplete payload')
    return op, session, request, data


def send(op, value, raw=False):
    data = value if raw else json.dumps(value, ensure_ascii=False).encode('utf-8')
    if len(data) > MAX_FRAME:
        raise ValueError('response too large')
    OUTPUT.write(HEADER.pack(b'CA02', op, SESSION, REQUEST, len(data)))
    OUTPUT.write(data); OUTPUT.flush()


def inside(path, root):
    try:
        Path(path).resolve().relative_to(root)
        return True
    except (ValueError, TypeError, OSError):
        return False


def audit(event, args):
    if event.startswith(('socket.', 'subprocess.', 'ctypes.', 'os.exec', 'os.spawn', 'winreg.')) or event in {
            'os.system', 'os.fork', 'os.forkpty', 'os.symlink', 'os.link'}:
        raise PermissionError('network, subprocess, registry and FFI are disabled')
    if event == 'open':
        target, mode, flags = args
        if isinstance(target, int):
            return
        writing = (isinstance(mode, str) and any(c in mode for c in 'wax+')) or bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
        if not inside(target, ROOT) and not (not writing and inside(target, LIBROOT)):
            raise PermissionError('outside task workspace or read-only Python libraries')
    if event in {'os.remove', 'os.rmdir', 'os.mkdir', 'os.chdir', 'os.chmod', 'os.utime', 'os.listdir', 'os.scandir'}:
        if not inside(args[0], ROOT) and not (event in {'os.listdir', 'os.scandir'} and inside(args[0], LIBROOT)):
            raise PermissionError('directory operation outside workspace')
    if event in {'os.rename', 'os.replace'} and not all(inside(p, ROOT) for p in args[:2]):
        raise PermissionError('rename outside workspace')


failures = []
bridge_ms = 0.0


def bridge(kind, **payload):
    global bridge_ms
    start = perf_counter()
    send(CALL, {'kind': kind, **payload})
    response = receive()
    bridge_ms += (perf_counter() - start) * 1000
    if response is None or response[0] != REPLY or response[1:3] != (SESSION, REQUEST):
        raise RuntimeError('invalid or closed host response')
    reply = json.loads(response[3])
    if not reply['ok']:
        failures.append({'tool': payload.get('name'), 'error': reply.get('error', 'failed')[:600]})
        raise RuntimeError(reply.get('error', 'tool failed'))
    if kind == 'batch':
        failures.extend({'tool': payload.get('name'), 'item': i, 'error': item.get('error', 'failed')[:600]}
                        for i, item in enumerate(reply['value']) if not item.get('ok'))
    return reply.get('value')


def tool(name, keys):
    def call(*args, **kwargs):
        if len(args) == 1 and isinstance(args[0], dict) and not kwargs:
            kwargs = args[0]
        else:
            if len(args) > len(keys):
                raise TypeError('too many arguments')
            for key, value in zip(keys, args):
                if key in kwargs:
                    raise TypeError('multiple values for ' + key)
                kwargs[key] = value
        return bridge('call', name=name, args=kwargs)
    return call


def native_read(path):
    global bridge_ms
    start = perf_counter()
    send(NATIVE, os.fspath(path).encode('utf-8'), raw=True)
    response = receive()
    bridge_ms += (perf_counter() - start) * 1000
    if response is None or response[0] != NATIVE_RESULT or response[1:3] != (SESSION, REQUEST):
        raise RuntimeError('invalid native response')
    payload = response[3]
    text = payload[1:].decode('utf-8')
    if payload[:1] != b'\x01':
        failures.append({'tool': 'native_read', 'error': text[:600]})
        raise RuntimeError(text)
    return text


class Capture(io.StringIO):
    def __init__(self):
        super().__init__(); self.total = 0
    def write(self, text):
        remaining = max(0, 1024 * 1024 - self.total)
        self.total += len(text)
        super().write(text[:remaining])
        return len(text)


native_read = hooks.wrap_native(native_read)
sys.addaudithook(hooks.audit)
first = receive()
if first is None or first[0] != INIT:
    raise RuntimeError('expected INIT')
SESSION, REQUEST = first[1:3]
config = json.loads(first[3])
observer = Observations()
agent_print = config.get('observe', False)
namespace = {'__builtins__': builtins, 'json': json, 'native_read': native_read,
             'batch': lambda name, jobs, limit=6: bridge('batch', name=name, jobs=jobs, limit=limit),
             'observe': observer.observe, 'get_observation': observer.get}
proxies = {s['name']: tool(s['name'], list(s['parameters'].get('properties', {}))) for s in config['tools']}
namespace.update(proxies); namespace['tools'] = types.SimpleNamespace(**proxies)
if agent_print:
    builtins.print = observer.print
cache = OrderedDict()
sys.addaudithook(audit)
send(READY, {'pid': os.getpid(), 'python_version': sys.version.split()[0], 'mode': 'observe' if agent_print else 'raw'})
while True:
    message = receive()
    if message is None or message[0] == CLOSE:
        break
    op, SESSION, REQUEST, payload = message
    if op == PING:
        send(PONG, payload, raw=True); continue
    if op != EXEC:
        send(ERROR, b'invalid opcode', raw=True); continue
    start = perf_counter(); compile_ms = 0.0; bridge_ms = 0.0; observer.render_ms = 0.0
    observer.auto_count = observer.observe_count = observer.readback_count = 0
    observer.input_rows = observer.shown_rows = observer.readback_errors = 0
    hooks.begin()
    failures = []; stream = Capture(); error = None; error_type = None; cache_hit = False
    with contextlib.redirect_stdout(hooks.TaggedStream(stream)), contextlib.redirect_stderr(hooks.TaggedStream(stream, stderr=True)):
        try:
            code = payload.decode('utf-8')
            compile_start = perf_counter()
            compiled = cache.get(code)
            cache_hit = compiled is not None
            if compiled is None:
                compiled = compile(code, '<agent>', 'exec')
                # Only cache bytecode, never results or side effects.
                if len(code) <= 65536:
                    cache[code] = compiled
                    while len(cache) > 64:
                        cache.popitem(last=False)
            compile_ms = (perf_counter() - compile_start) * 1000
            exec(compiled, namespace)
        except BaseException as failure:
            error_type = type(failure).__name__
            error = traceback.format_exc(limit=6)
    output = stream.getvalue()
    retained_chars = len(output)
    complete = stream.total <= 1024 * 1024
    if len(output) > 40000:
        namespace['_last_output'] = output
        output = output[:20000] + '\n[truncated; retained portion in _last_output; complete=' + str(complete) + ']\n' + output[-20000:]
    send(DONE, {'ok': error is None, 'output': output, 'error': error, 'tool_failures': failures,
                'output_complete': complete, 'output_chars': stream.total,
                'metrics': {**hooks.snapshot(), 'error_type': error_type, 'compile_cache_hit': cache_hit,
                            'retained_output_chars': retained_chars, 'displayed_output_chars': len(output),
                            'display_truncated': retained_chars > 40000,
                            'observation_input_rows': observer.input_rows, 'observation_shown_rows': observer.shown_rows,
                            'observation_readback_errors': observer.readback_errors,
                            'python_ms': (perf_counter() - start) * 1000, 'compile_ms': compile_ms,
                            'bridge_wait_ms': bridge_ms, 'observation_ms': observer.render_ms,
                            'auto_observations': observer.auto_count, 'explicit_observations': observer.observe_count,
                            'observation_readbacks': observer.readback_count,
                            'python_pid': os.getpid(), 'cached_blocks': len(cache)}})
