"""候选：保守调度顶层独立只读赋值与简单字符串推导式。"""
import ast
import copy
import json

SAFE_TOOLS = frozenset({"read", "find", "grep", "ls", "native_read"})
HELPER = "__pimoon_scheduler__"


def candidate(node):
    if not (isinstance(node, ast.Assign) and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)):
        return None
    target = node.targets[0].id
    call = node.value
    if target in SAFE_TOOLS or target == HELPER:
        return None
    if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
            and call.func.id in SAFE_TOOLS):
        return None
    if call.args:
        if call.func.id != "native_read" or len(call.args) != 1 or call.keywords:
            return None
        call = copy.deepcopy(call)
        call.keywords = [ast.keyword(arg="path", value=call.args[0])]
    if (any(keyword.arg is None for keyword in call.keywords)
            or len({keyword.arg for keyword in call.keywords}) != len(call.keywords)):
        return None
    try:
        args = {keyword.arg: ast.literal_eval(keyword.value) for keyword in call.keywords}
        # 与桥接协议相同的 JSON 边界；不提前计算任何用户表达式。
        json.dumps(args, allow_nan=False)
    except (ValueError, TypeError, RecursionError):
        return None
    if call.func.id == "native_read" and (set(args) != {"path"} or type(args["path"]) is not str):
        return None
    return target, call.func.id, args


def transform(tree):
    if any(isinstance(node, ast.Name) and node.id == HELPER for node in ast.walk(tree)):
        return tree
    for node in tree.body:
        if isinstance(node, ast.Assign):
            node.value = comprehension(node.value)
    output = []
    cursor = 0
    group = 0
    while cursor < len(tree.body):
        start = cursor
        jobs = []
        targets = set()
        while cursor < len(tree.body) and len(jobs) < 64:
            item = candidate(tree.body[cursor])
            if item is None or item[0] in targets:
                break
            target, name, args = item
            targets.add(target)
            jobs.append({"name": name, "args": args})
            cursor += 1
        if len(jobs) < 2:
            output.extend(tree.body[start:cursor] or [tree.body[cursor]])
            if cursor == start:
                cursor += 1
            continue
        original = tree.body[start:cursor]
        names = ast.Tuple(elts=[ast.Constant(job["name"]) for job in jobs], ctx=ast.Load())
        test = ast.Call(func=ast.Attribute(value=ast.Name(id=HELPER, ctx=ast.Load()),
                       attr="eligible", ctx=ast.Load()), args=[names], keywords=[])
        scheduled = []
        for index, node in enumerate(original):
            replacement = copy.deepcopy(node)
            replacement.value = ast.Call(func=ast.Attribute(value=ast.Name(id=HELPER, ctx=ast.Load()),
                attr="resolve", ctx=ast.Load()), args=[ast.Constant(group),
                ast.parse(repr(jobs), mode="eval").body if index == 0 else ast.Constant(None),
                ast.Constant(index)], keywords=[])
            scheduled.append(ast.copy_location(replacement, node))
        output.append(ast.copy_location(ast.If(test=test, body=scheduled, orelse=original), original[0]))
        group += 1
    tree.body = output
    return tree


def _lambda(names, body):
    return ast.Lambda(args=ast.arguments(posonlyargs=[], args=[ast.arg(arg=name) for name in names],
        kwonlyargs=[], kw_defaults=[], defaults=[]), body=body)


def _pure_path(node, target):
    if isinstance(node, ast.Constant) and type(node.value) is str:
        return True
    if isinstance(node, ast.Name):
        return node.id == target
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _pure_path(node.left, target) and _pure_path(node.right, target)
    if isinstance(node, ast.JoinedStr):
        return all(isinstance(part, ast.Constant) and type(part.value) is str
                   or isinstance(part, ast.FormattedValue) and part.conversion == -1
                   and part.format_spec is None and _pure_path(part.value, target) for part in node.values)
    try:
        json.dumps(ast.literal_eval(node), allow_nan=False)
        return True
    except (ValueError, TypeError, RecursionError):
        return False


def _string_path(node, target):
    if isinstance(node, ast.Constant):
        return type(node.value) is str
    if isinstance(node, ast.Name):
        return node.id == target
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _string_path(node.left, target) and _string_path(node.right, target)
    return isinstance(node, ast.JoinedStr) and _pure_path(node, target)


def comprehension(node):
    if not isinstance(node, (ast.ListComp, ast.DictComp)) or len(node.generators) != 1:
        return node
    generator = node.generators[0]
    if generator.ifs or generator.is_async or not isinstance(generator.target, ast.Name):
        return node
    target = generator.target.id
    if target in SAFE_TOOLS or target == HELPER or not isinstance(generator.iter, (ast.Name, ast.List, ast.Tuple)):
        return node
    if isinstance(generator.iter, (ast.List, ast.Tuple)) and not all(
            isinstance(item, ast.Constant) and type(item.value) is str for item in generator.iter.elts):
        return node
    if isinstance(node, ast.DictComp) and not (isinstance(node.key, ast.Name) and node.key.id == target):
        return node
    call = node.value if isinstance(node, ast.DictComp) else node.elt
    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.func.id not in SAFE_TOOLS:
        return node
    name = call.func.id
    keywords = call.keywords
    if call.args:
        if name != "native_read" or len(call.args) != 1 or keywords:
            return node
        keywords = [ast.keyword(arg="path", value=call.args[0])]
    if (any(keyword.arg is None or not _pure_path(keyword.value, target) for keyword in keywords)
            or len({keyword.arg for keyword in keywords}) != len(keywords)):
        return node
    if name == "native_read" and (len(keywords) != 1 or keywords[0].arg != "path"
                                  or not _string_path(keywords[0].value, target)):
        return node
    args = ast.Dict(keys=[ast.Constant(keyword.arg) for keyword in keywords],
                    values=[copy.deepcopy(keyword.value) for keyword in keywords])
    return ast.copy_location(ast.Call(func=ast.Attribute(value=ast.Name(id=HELPER, ctx=ast.Load()),
        attr="map_reads", ctx=ast.Load()), args=[ast.Constant(name), copy.deepcopy(generator.iter),
        _lambda([target], args), _lambda([], copy.deepcopy(node)),
        ast.Constant(isinstance(node, ast.DictComp))], keywords=[]), node)


class Scheduler:
    def __init__(self, namespace, proxies, bridge):
        self.namespace = namespace
        self.proxies = proxies
        self.bridge = bridge
        self.results = {}

    def eligible(self, names):
        return all(name in self.proxies and self.namespace.get(name) is self.proxies[name] for name in names)

    def map_reads(self, name, paths, arguments, fallback, as_dict):
        # 只检查精确内置类型；不触发自定义迭代、转换或属性读取。
        if (not self.eligible([name]) or type(paths) not in (list, tuple)
                or not 2 <= len(paths) <= 256 or any(type(path) is not str for path in paths)):
            return fallback()
        values = []
        for start in range(0, len(paths), 64):
            rows = self.bridge("schedule", jobs=[{"name": name, "args": arguments(path)}
                                                 for path in paths[start:start + 64]])
            for row in rows:
                if not row["ok"]:
                    raise RuntimeError(row["error"])
                values.append(row["value"])
        return dict(zip(paths, values)) if as_dict else values

    def resolve(self, group, jobs, index):
        if group not in self.results:
            self.results[group] = self.bridge("schedule", jobs=jobs)
        row = self.results[group][index]
        if not row["ok"]:
            raise RuntimeError(row["error"])
        return row["value"]
