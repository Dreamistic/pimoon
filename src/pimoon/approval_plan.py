"""只解析字面量和局部常量，不读取持久 namespace，也不执行待审 Python。"""
import ast
import json

UNKNOWN = object()
TOOLS = {"read", "write", "edit", "find", "grep", "ls", "http", "webfetch", "websearch"}
POSITIONAL = {"read": ["path"], "write": ["path", "content"], "edit": ["path", "edits"],
              "find": ["query"], "grep": ["query"], "ls": ["path"], "http": ["url"], "webfetch": ["url"], "websearch": ["query"]}


def inspect(code):
    calls, unresolved = [], set()
    budget = [4096]

    def value(node, env):
        budget[0] -= 1
        if budget[0] < 0:
            return UNKNOWN
        if isinstance(node, ast.Constant) and isinstance(node.value, (str, int, float, bool, type(None))):
            return node.value
        if isinstance(node, ast.Name):
            return env.get(node.id, {"__tool__": node.id} if node.id in TOOLS else UNKNOWN)
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "subprocess" and node.attr == "run":
            return {"__tool__": "process_run"}
        if isinstance(node, ast.ListComp) and len(node.generators) == 1:
            gen = node.generators[0]
            items = value(gen.iter, env)
            if isinstance(gen.target, ast.Name) and not gen.ifs and isinstance(items, list) and len(items) <= 128:
                rows = []
                for item in items:
                    branch = dict(env); branch[gen.target.id] = item
                    rows.append(value(node.elt, branch))
                return UNKNOWN if any(row is UNKNOWN for row in rows) else rows
        if isinstance(node, (ast.List, ast.Tuple)):
            values = [value(item, env) for item in node.elts]
            return UNKNOWN if any(item is UNKNOWN for item in values) else values
        if isinstance(node, ast.Dict) and all(key is not None for key in node.keys):
            keys, values = [value(key, env) for key in node.keys], [value(item, env) for item in node.values]
            if any(item is UNKNOWN for item in keys + values) or not all(isinstance(key, str) for key in keys):
                return UNKNOWN
            return dict(zip(keys, values))
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left, right = value(node.left, env), value(node.right, env)
            if type(left) is type(right) and type(left) in (str, list) and len(left) + len(right) < 64000:
                return left + right
        if isinstance(node, ast.JoinedStr):
            parts = []
            for item in node.values:
                result = value(item.value, env) if isinstance(item, ast.FormattedValue) and item.format_spec is None and item.conversion == -1 else value(item, env)
                if result is UNKNOWN or type(result) not in (str, int, float, bool):
                    return UNKNOWN
                parts.append(str(result))
            return "".join(parts)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
            if node.func.value.id == "json" and node.func.attr == "loads" and len(node.args) == 1 and not node.keywords:
                text = value(node.args[0], env)
                if isinstance(text, str) and len(text) < 64000:
                    try:
                        return json.loads(text)
                    except (ValueError, TypeError):
                        pass
        return UNKNOWN

    def name(node):
        if isinstance(node, ast.Name) and node.id in TOOLS:
            return node.id
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "subprocess" and node.attr == "run":
            return "process_run"
        return None

    def add(tool, kwargs, line):
        if len(calls) >= 128 or len(json.dumps(kwargs, ensure_ascii=False)) > 64000:
            unresolved.add(line)
        else:
            calls.append({"tool": tool, "input": kwargs, "line": line})

    def scan(node, env):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id == "parallel" and node.args:
                jobs = value(node.args[0], env)
                if not isinstance(jobs, list):
                    unresolved.add(node.lineno)
                else:
                    for job in jobs:
                        if not isinstance(job, list) or len(job) != 2 or not isinstance(job[0], dict) or not isinstance(job[1], dict) or "__tool__" not in job[0]:
                            unresolved.add(node.lineno); continue
                        tool = job[0]["__tool__"]; kwargs = dict(job[1])
                        if tool == "process_run":
                            if "args" in kwargs:
                                kwargs["argv"] = kwargs.pop("args")
                            kwargs = {key: item for key, item in kwargs.items() if key in ("argv", "cwd", "env")}
                            if "env" in kwargs:
                                kwargs["inherit_env"] = False
                        add(tool, kwargs, node.lineno)
            tool = name(node.func)
            if tool:
                params = ["argv"] if tool == "process_run" else POSITIONAL[tool]
                kwargs = {key: value(item, env) for key, item in zip(params, node.args)}
                for item in node.keywords:
                    if item.arg is None:
                        kwargs["**"] = UNKNOWN
                    else:
                        kwargs[item.arg] = value(item.value, env)
                if len(node.args) > len(params) or any(item is UNKNOWN for item in kwargs.values()):
                    unresolved.add(node.lineno)
                else:
                    if tool == "process_run":
                        kwargs = {key: item for key, item in kwargs.items() if key in ("argv", "cwd", "env")}
                        if "env" in kwargs:
                            kwargs["inherit_env"] = False
                    add(tool, kwargs, node.lineno)
        for child in ast.iter_child_nodes(node):
            scan(child, env)

    def statements(nodes, env):
        for node in nodes:
            if budget[0] < 0:
                unresolved.add(getattr(node, "lineno", 0))
                return
            if isinstance(node, ast.Assign):
                scan(node.value, env)
                result = value(node.value, env)
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        env[target.id] = result
            elif isinstance(node, ast.For) and isinstance(node.target, ast.Name):
                items = value(node.iter, env)
                if isinstance(items, list) and len(items) <= 128:
                    for item in items:
                        branch = dict(env); branch[node.target.id] = item
                        statements(node.body, branch)
                else:
                    unresolved.add(node.lineno)
                env[node.target.id] = UNKNOWN
                statements(node.orelse, dict(env))
            elif isinstance(node, ast.If):
                scan(node.test, env)
                statements(node.body, dict(env)); statements(node.orelse, dict(env))
                for child in ast.walk(node):
                    if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
                        env[child.id] = UNKNOWN
            elif isinstance(node, ast.Try):
                statements(node.body, dict(env))
                for handler in node.handlers:
                    statements(handler.body, dict(env))
                statements(node.orelse, dict(env)); statements(node.finalbody, dict(env))
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.While, ast.With)):
                unresolved.add(node.lineno)
            else:
                scan(node, env)
                for child in ast.walk(node):
                    if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
                        env[child.id] = UNKNOWN
    try:
        statements(ast.parse(code).body, {})
    except (SyntaxError, ValueError, RecursionError, MemoryError, TypeError):
        unresolved.add(0)
    return {"calls": calls, "unresolvedLines": sorted(unresolved), "complete": not unresolved}


if __name__ == "__main__":
    import sys
    code = sys.stdin.read(1024 * 1024 + 1)
    result = inspect(code) if len(code) <= 1024 * 1024 else {"calls": [], "unresolvedLines": [0], "complete": False}
    print(json.dumps(result, ensure_ascii=False))
