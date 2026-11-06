"""统一显式并发：只读工具与受控进程复用同一个组，普通 Python 不改写。"""
import json
import subprocess

READ_ONLY = frozenset({"read", "find", "grep", "ls"})
MAX_JOBS = 256


class ParallelError(RuntimeError):
    """已完成、失败及未启动项均保留；捕获异常不代表适合重放。"""
    def __init__(self, results):
        self.results = results
        failed = [str(i) for i, row in enumerate(results) if not row["ok"] and not row.get("skipped")]
        super().__init__("Parallel jobs failed at items " + ",".join(failed) + "; inspect exception.results; no automatic retry")


class Parallel:
    def __init__(self, bridge, process_run, prepare_process, finish_process):
        self.bridge = bridge
        self.process_run = process_run
        self.prepare_process = prepare_process
        self.finish_process = finish_process
        self.proxies = {}

    def bind(self, proxies, process_enabled):
        self.proxies = {name: fn for name, fn in proxies.items() if name in READ_ONLY}
        if process_enabled:
            self.proxies["process_run"] = self.process_run

    def __call__(self, jobs, *, errors="raise"):
        if errors not in ("raise", "collect"):
            raise ValueError('parallel errors must be "raise" or "collect"')
        if type(jobs) not in (list, tuple) or len(jobs) > MAX_JOBS:
            raise ValueError("parallel requires a list/tuple of at most 256 (function, kwargs) pairs")
        prepared, process_options = [], {}
        for index, job in enumerate(jobs):
            if type(job) not in (list, tuple) or len(job) != 2:
                raise TypeError("parallel item " + str(index) + " must be (function, kwargs); do not call the function in jobs")
            fn, args = job
            name = next((name for name, proxy in self.proxies.items() if fn is proxy), None)
            if name is None:
                raise TypeError("parallel accepts current enabled read/find/grep/ls and subprocess.run only; writes and callbacks stay sequential")
            if type(args) is not dict or any(type(key) is not str for key in args):
                raise TypeError("parallel kwargs must be a dict with string keys")
            if name == "process_run":
                args, options = self.prepare_process(**args)
                process_options[index] = options
                prepared.append({"name": name, "args": args, "check": options["check"]})
            else:
                prepared.append({"name": name, "args": args})
        # 一次验证整个参数快照；无效后项不导致前项被提前派发。
        json.dumps(prepared, allow_nan=False)
        if not prepared:
            return []
        rows = self.bridge("schedule", jobs=prepared, errors=errors)
        results = [{key: value for key, value in row.items() if key in {"ok", "value", "error", "error_code", "skipped"}} for row in rows]
        for index, options in process_options.items():
            row = results[index]
            if "value" not in row:
                continue
            value = row.pop("value")
            try:
                row["value"] = self.finish_process(value, options, report=False)
            except (subprocess.SubprocessError, OSError, RuntimeError):
                # 宿主已登记失败；保留其错误码与诊断，不重复计数。
                if row["ok"]:
                    raise
        if errors == "collect":
            return results
        if any(not row["ok"] for row in results):
            raise ParallelError(results)
        return [row["value"] for row in results]
