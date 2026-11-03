"""Bounded, deterministic observation rendering. No LLM summarization or arbitrary repr calls."""
import builtins
from collections import OrderedDict
import json
import sys

PLAIN_PRINT = builtins.print


def preview(value, depth=0, seen=None):
    seen = set() if seen is None else seen
    if value is None or type(value) in (bool, int, float):
        return value, False
    if type(value) is str:
        return (value, False) if len(value) <= 160 else (value[:100] + f"…[{len(value)} chars]", True)
    if depth >= 3:
        return {"type": type(value).__name__}, True
    if type(value) not in (list, tuple, dict):
        return {"type": type(value).__name__}, True
    if id(value) in seen:
        return {"cycle": True}, True
    seen = seen | {id(value)}
    truncated = len(value) > (12 if type(value) is dict else 4)
    if type(value) is dict:
        result = {}
        for i, (key, item) in enumerate(value.items()):
            if i >= 12:
                break
            # Never call user-defined __str__/__repr__ on keys.
            key = key if type(key) is str else str(key) if type(key) in (int, float, bool) else '<non-string-key>'
            item, cut = preview(item, depth + 1, seen)
            result[key] = item; truncated |= cut
        return result, truncated
    result = []
    for item in value[:4]:
        item, cut = preview(item, depth + 1, seen)
        result.append(item); truncated |= cut
    return result, truncated


def small_builtin(value):
    """Bounded size check: do not wrap a five-number list in a costly observation envelope."""
    remaining = [1800, 128]
    def visit(item, depth=0):
        remaining[1] -= 1
        if remaining[1] < 0 or remaining[0] < 0 or depth > 5:
            return False
        if type(item) is str:
            remaining[0] -= len(item) + 3
        elif item is None or type(item) in (bool, int, float):
            if type(item) is int and item.bit_length() > 256:
                return False
            remaining[0] -= 24
        elif type(item) in (list, tuple):
            if len(item) > 16:
                return False
            return all(visit(child, depth + 1) for child in item) and remaining[0] >= 0
        elif type(item) is dict:
            if len(item) > 16:
                return False
            return all(visit(key, depth + 1) and visit(child, depth + 1) for key, child in item.items()) and remaining[0] >= 0
        else:
            return False
        return remaining[0] >= 0
    return visit(value)


class Observations:
    def __init__(self):
        self.items = OrderedDict()
        self.counter = 0
        self.snapshot_chars = 0
        self.render_ms = 0.0
        self.auto_count = self.observe_count = self.readback_count = 0
        self.input_rows = self.shown_rows = self.readback_errors = 0

    def keep(self, value, kind):
        chars = len(value) if type(value) is str else 0
        if chars > 1024 * 1024:
            return None
        while self.items and (len(self.items) >= 32 or self.snapshot_chars + chars > 1024 * 1024):
            _, (old, _) = self.items.popitem(last=False)
            self.snapshot_chars -= len(old) if type(old) is str else 0
        self.counter += 1
        ref = f"@o{self.counter}"
        self.items[ref] = (value, kind)
        self.snapshot_chars += chars
        return ref

    def get(self, ref):
        self.readback_count += 1
        if ref not in self.items:
            self.readback_errors += 1
            raise LookupError('Observation expired or unknown; do not replay writes: ' + str(ref))
        value, kind = self.items[ref]
        # A JSON text snapshot stays immutable even when callers mutate a decoded copy.
        return json.loads(value) if kind == 'json_snapshot' else value

    def render(self, value):
        if type(value) is not str and small_builtin(value):
            return None
        original = value
        kind = 'live_object'
        if type(value) is str:
            if len(value) <= 1800:
                return value
            kind = 'text_snapshot'
            if len(value) <= 1024 * 1024 and value.lstrip().startswith(('{', '[')):
                try:
                    value = json.loads(value)
                    kind = 'json_snapshot'
                except (ValueError, RecursionError):
                    pass
        sample, cut = preview(value)
        if not cut:
            return None  # Use normal print semantics for small values.
        self.auto_count += 1
        ref = self.keep(original, kind)
        record = {'observation': ref, 'reference': kind, 'type': type(value).__name__,
                  'preview': sample, 'preview_complete': False,
                  'available': ref is not None}
        if type(value) in (str, list, tuple, dict):
            record['count'] = len(value)
        if ref is None:
            record['reason'] = 'reference_quota; value is not fully retained'
        return json.dumps(record, ensure_ascii=False)

    def print(self, *values, sep=' ', end='\n', file=None, flush=False):
        # Keep the frequent scalar/short-text path out of object traversal and instrumentation.
        if len(values) == 1:
            value = values[0]
            if value is None or type(value) in (bool, int, float) or (type(value) is str and len(value) <= 1800):
                return PLAIN_PRINT(*values, sep=sep, end=end, file=file, flush=flush)
        if file is not None and file is not sys.stdout:
            return PLAIN_PRINT(*values, sep=sep, end=end, file=file, flush=flush)
        if sep is not None and not isinstance(sep, str):
            raise TypeError('sep must be None or a string')
        if end is not None and not isinstance(end, str):
            raise TypeError('end must be None or a string')
        from time import perf_counter
        start = perf_counter()
        rendered = []
        for value in values:
            replacement = self.render(value)
            rendered.append(value if replacement is None else replacement)
        self.render_ms += (perf_counter() - start) * 1000
        return PLAIN_PRINT(*rendered, sep=sep, end=end, file=file, flush=flush)

    def observe(self, value, fields=None, limit=8):
        self.observe_count += 1
        if type(value) is str and value.startswith('@o'):
            value = self.get(value)
        if type(limit) is not int or not 0 <= limit <= 100:
            raise ValueError('limit must be 0..100')
        rows = value if isinstance(value, list) else [value]
        selected = rows[:limit]
        self.input_rows += len(rows)
        self.shown_rows += len(selected)
        if fields is not None:
            selected = [{key: row.get(key) for key in fields} for row in selected]
        PLAIN_PRINT(json.dumps({'count': len(rows), 'shown': len(selected), 'items': selected}, ensure_ascii=False))
