"""显式只读并发：普通 Python 不改写，任务参数在派发前全部验证。"""
import json

READ_ONLY = frozenset({"read", "find", "grep", "ls"})
MAX_JOBS = 256


class ParallelError(RuntimeError):
    """已完成、失败及未启动项均保留；捕获异常不代表适合重放。"""
    def __init__(self, results):
        self.results = results
        failed = [str(i) for i, row in enumerate(results) if not row["ok"] and not row.get("skipped")]
        super().__init__("Parallel reads failed at items " + ",".join(failed) + "; inspect exception.results; no automatic retry")


class Parallel:
    def __init__(self, bridge):
        self.bridge = bridge
        self.proxies = {}

    def bind(self, proxies):
        self.proxies = {name: fn for name, fn in proxies.items() if name in READ_ONLY}

    def __call__(self, jobs, *, errors="raise"):
        if errors not in ("raise", "collect"):
            raise ValueError('parallel errors must be "raise" or "collect"')
        if type(jobs) not in (list, tuple) or len(jobs) > MAX_JOBS:
            raise ValueError("parallel requires a list/tuple of at most 256 (function, kwargs) pairs")
        prepared = []
        for index, job in enumerate(jobs):
            if type(job) not in (list, tuple) or len(job) != 2:
                raise TypeError("parallel item " + str(index) + " must be (function, kwargs); do not call the function in jobs")
            fn, args = job
            name = next((name for name, proxy in self.proxies.items() if fn is proxy), None)
            if name is None:
                raise TypeError("parallel accepts current enabled read/find/grep/ls functions only; writes, processes and callbacks stay sequential")
            if type(args) is not dict or any(type(key) is not str for key in args):
                raise TypeError("parallel kwargs must be a dict with string keys")
            prepared.append({"name": name, "args": args})
        # 一次验证整个参数快照；无效后项不导致前项被提前派发。
        json.dumps(prepared, allow_nan=False)
        if not prepared:
            return []
        rows = self.bridge("schedule", jobs=prepared, errors=errors)
        results = [{key: value for key, value in row.items() if key in {"ok", "value", "error", "error_code", "skipped"}} for row in rows]
        if errors == "collect":
            return results
        if any(not row["ok"] for row in results):
            raise ParallelError(results)
        return [row["value"] for row in results]
