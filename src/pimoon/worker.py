"""CA02 持久 Python；文件检查用于纵深防御，不是强安全沙箱。"""
import builtins
import collections
import csv
import datetime
import functools
import itertools
import math
import pathlib
import re
import statistics
import time
from collections import OrderedDict
import contextlib
import io
import json
import os
from pathlib import Path
import struct
import sys
from time import perf_counter
from threading import get_ident
import traceback
import types
from observations import Observations
from execution import CAPTURE_NAME, RESULT_NAME, compile_cell, display_result
from feedback import CellFeedback
from parallel import Parallel, ParallelError
import worker_hooks as hooks

HEADER = struct.Struct('<4sBIII')
MAX_FRAME = 8 * 1024 * 1024
INPUT, OUTPUT = sys.stdin.buffer, sys.stdout.buffer
ROOT = Path.cwd().resolve()
# 支持直接导入项目函数；运行时与标准库优先，避免项目文件遮蔽宿主模块。
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))
INIT, EXEC, REPLY, CANCEL, CLOSE, PING = range(1, 7)
READY, DONE, CALL, PONG, ERROR = 101, 102, 103, 108, 109
SESSION = REQUEST = 0
EXECUTION_THREAD = get_ident()


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


def readable(target):
    if isinstance(target, int):
        raise PermissionError('raw file descriptors are disabled')
    raw = os.fsdecode(target)
    if raw.startswith(('\\\\', '//')):
        raise PermissionError('network and device paths require separate approval')
    absolute = Path(raw).absolute()
    canonical = absolute.resolve()
    if any(candidate.is_relative_to(blocked) for candidate in (absolute, canonical) for blocked in protected_paths):
        raise PermissionError('protected credential path')


def writable(target):
    readable(target)
    canonical = Path(os.fsdecode(target)).resolve()
    if any(canonical.is_relative_to(root) for root in system_write_roots):
        raise PermissionError('system writes require an explicitly approved operation')
    # 原生覆盖无法复用宿主的观测版本和原子提交，交回文件工具处理。
    if canonical.exists() and canonical.is_file():
        raise PermissionError('existing files require read then write/edit functions; native overwrite is disabled')


def audit(event, args):
    if event.startswith(('socket.', 'subprocess.', 'ctypes.', 'os.exec', 'os.spawn', 'winreg.')) or event in {
            'os.system', 'os.fork', 'os.forkpty', 'os.symlink', 'os.link'}:
        raise PermissionError('Direct network, process creation, registry and FFI are disabled; use subprocess.run for programs')
    if event == 'open':
        target, mode, flags = args
        readable(target)
        writing = (isinstance(mode, str) and any(c in mode for c in 'wax+')) or bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
        if writing:
            writable(target)
    if event in {'os.listdir', 'os.scandir'}:
        readable(args[0] if args[0] is not None else '.')
    if event in {'os.remove', 'os.rmdir', 'os.chmod', 'os.rename', 'os.replace'}:
        raise PermissionError('destructive native mutation requires an approved subprocess.run operation')
    if event in {'os.mkdir', 'os.utime'}:
        writable(args[0])
    if event == 'os.chdir':
        readable(args[0])


failures = []
bridge_ms = 0.0


class ToolError(RuntimeError):
    """宿主执行失败带稳定代码，未知错误不通过文案猜测分类。"""
    def __init__(self, message, code="TOOL_ERROR"):
        self.code = code
        super().__init__(message)


def bridge(kind, **payload):
    global bridge_ms
    if get_ident() != EXECUTION_THREAD:
        raise RuntimeError("Host functions require synchronous calls on the execution thread")
    start = perf_counter()
    send(CALL, {'kind': kind, **payload})
    response = receive()
    bridge_ms += (perf_counter() - start) * 1000
    if response is None or response[0] != REPLY or response[1:3] != (SESSION, REQUEST):
        raise RuntimeError('invalid or closed host response')
    reply = json.loads(response[3])
    if not reply['ok']:
        failures.append({'tool': 'subprocess.run' if payload.get('name') == 'process_run' else payload.get('name'), 'error': reply.get('error', 'failed')[:600]})
        raise ToolError(reply.get('error', 'tool failed'), reply.get('error_code', 'TOOL_ERROR'))
    if kind == 'schedule':
        failures.extend({'tool': 'subprocess.run' if payload['jobs'][i]['name'] == 'process_run' else payload['jobs'][i]['name'],
                         'item': i, 'error': item.get('error', 'failed')[:600]}
                        for i, item in enumerate(reply['value']) if not item.get('ok') and not item.get('skipped'))
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


class Capture(io.StringIO):
    def __init__(self):
        super().__init__(); self.total = 0
    def write(self, text):
        remaining = max(0, 1024 * 1024 - self.total)
        self.total += len(text)
        super().write(text[:remaining])
        return len(text)


sys.addaudithook(hooks.audit)
first = receive()
if first is None or first[0] != INIT:
    raise RuntimeError('expected INIT')
SESSION, REQUEST = first[1:3]
config = json.loads(first[3])
protected_paths = tuple(candidate for p in config.get('protected_paths', [])
                        for candidate in (Path(p).absolute(), Path(p).resolve()))
system_write_roots = tuple(Path(p).resolve() for p in (
    [os.environ.get('SystemRoot', 'C:/Windows'), 'C:/Program Files', 'C:/Program Files (x86)']
    if os.name == 'nt' else ['/etc', '/usr', '/bin', '/sbin', '/System', '/Library', '/var']))
observer = Observations()
agent_print = config.get('observe', False)
# 首次执行前加载轻量标准库；不安装依赖，不改变文件与进程审计。
preloaded = {name: globals()[name] for name in (
    "os", "sys", "json", "re", "pathlib", "Path", "csv", "io", "math", "statistics",
    "datetime", "time", "collections", "itertools", "functools")}
namespace = {'__builtins__': builtins, **preloaded,
             'observe': observer.observe, 'get_observation': observer.get}
function_names = set()
from process_api import install
namespace['subprocess'], prepare_process, finish_process = install(bridge, lambda: 'process_run' in function_names,
    lambda error: failures.append({'tool': 'subprocess.run', 'error': error}))
preloaded['subprocess'] = namespace['subprocess']


def bind_functions(functions):
    global function_names
    proxies = {s['name']: tool(s['name'], list(s['parameters'].get('properties', {}))) for s in functions if s['name'] != 'process_run'}
    for name in (function_names - proxies.keys()) - preloaded.keys():
        namespace.pop(name, None)
    namespace.update({name: proxy for name, proxy in proxies.items() if name not in preloaded})
    namespace['functions'] = types.SimpleNamespace(**proxies)
    function_names = {s['name'] for s in functions}
    return proxies


parallel = Parallel(bridge, namespace['subprocess'].run, prepare_process, finish_process)
bind_functions(config['tools'])
if agent_print:
    builtins.print = observer.print
cache = OrderedDict()
sys.addaudithook(audit)
send(READY, {'pid': os.getpid(), 'python_version': sys.version.split()[0], 'mode': 'observe' if agent_print else 'raw', 'preloaded': list(preloaded)})
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
    failures = []; stream = Capture(); error = None; error_type = None; cache_hit = False; expression_results = 0
    namespace.pop(RESULT_NAME, None)
    feedback = CellFeedback()
    def capture_value(value):
        feedback.capture(value)
        if feedback.values:
            namespace['_results'] = feedback.values
    namespace[CAPTURE_NAME] = capture_value
    value = None
    with contextlib.redirect_stdout(hooks.TaggedStream(stream)), contextlib.redirect_stderr(hooks.TaggedStream(stream, stderr=True)):
        try:
            cell = json.loads(payload)
            proxies = bind_functions(cell['tools'])
            parallel.bind(proxies, 'process_run' in function_names)
            namespace['parallel'] = parallel
            namespace['ParallelError'] = ParallelError
            namespace['ToolError'] = ToolError
            code = cell['code']
            compile_start = perf_counter()
            compiled = cache.get(code)
            cache_hit = compiled is not None
            if compiled is None:
                compiled = compile_cell(code)
                # 只缓存字节码，不缓存结果或副作用。
                if len(code) <= 65536:
                    cache[code] = compiled
                    while len(cache) > 64:
                        cache.popitem(last=False)
            compile_ms = (perf_counter() - compile_start) * 1000
            bytecode, has_result = compiled
            try:
                exec(bytecode, namespace)
                if has_result:
                    value = namespace.pop(RESULT_NAME, None)
                    if value is not None:
                        expression_results = 1
            finally:
                feedback.show(value)
                if feedback.values:
                    namespace['_results'] = feedback.values
                    namespace['_'] = feedback.values[-1]
                if expression_results:
                    display_result(value)
        except BaseException as failure:
            error_type = type(failure).__name__
            if (isinstance(failure, json.JSONDecodeError) and isinstance(failure.doc, str)
                    and failure.doc.startswith('<read ') and failure.doc.rstrip().endswith('</read>')):
                failure.add_note('JSON input looks like a rendered read view, not raw JSON.')
            error = traceback.format_exc(limit=6)
        finally:
            namespace.pop(RESULT_NAME, None)
            namespace.pop(CAPTURE_NAME, None)
    output = stream.getvalue()
    retained_chars = len(output)
    complete = stream.total <= 1024 * 1024
    if len(output) > 40000:
        namespace['_last_output'] = output
        output = output[:20000] + '\n[truncated; retained portion in _last_output; complete=' + str(complete) + ']\n' + output[-20000:]
    send(DONE, {'ok': error is None, 'output': output, 'error': error, 'tool_failures': failures,
                'output_complete': complete, 'output_chars': stream.total,
                'metrics': {**hooks.snapshot(), 'expression_results': expression_results, 'auto_results': feedback.total, 'error_type': error_type, 'compile_cache_hit': cache_hit,
                            'retained_output_chars': retained_chars, 'displayed_output_chars': len(output),
                            'display_truncated': retained_chars > 40000,
                            'observation_input_rows': observer.input_rows, 'observation_shown_rows': observer.shown_rows,
                            'observation_readback_errors': observer.readback_errors,
                            'python_ms': (perf_counter() - start) * 1000, 'compile_ms': compile_ms,
                            'bridge_wait_ms': bridge_ms, 'observation_ms': observer.render_ms,
                            'auto_observations': observer.auto_count, 'explicit_observations': observer.observe_count,
                            'observation_readbacks': observer.readback_count,
                            'python_pid': os.getpid(), 'cached_blocks': len(cache)}})
