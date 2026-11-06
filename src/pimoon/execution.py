"""单元格末尾表达式只执行一次；展示不回灌全部中间变量。"""
import ast
import builtins
import json
import sys
import subprocess

RESULT_NAME = "__pimoon_cell_result__"
CAPTURE_NAME = "__pimoon_capture_result__"
PLAIN_PRINT = builtins.print


class _CaptureCalls(ast.NodeTransformer):
    # 函数内部表达式属于函数实现，不当成单元格的反馈。
    def visit_FunctionDef(self, node):
        return node

    visit_AsyncFunctionDef = visit_ClassDef = visit_FunctionDef

    def visit_Expr(self, node):
        if isinstance(node.value, ast.Call):
            return ast.copy_location(ast.Expr(value=ast.Call(
                func=ast.Name(id=CAPTURE_NAME, ctx=ast.Load()), args=[node.value], keywords=[])), node)
        return node


def compile_cell(source):
    tree = ast.parse(source, filename="<agent>", mode="exec")
    has_result = bool(tree.body and isinstance(tree.body[-1], ast.Expr))
    if has_result:
        expression = tree.body[-1]
        tree.body[-1] = ast.copy_location(ast.Assign(
            targets=[ast.Name(id=RESULT_NAME, ctx=ast.Store())], value=expression.value), expression)
    tree = _CaptureCalls().visit(tree)
    ast.fix_missing_locations(tree)
    return compile(tree, "<agent>", "exec"), has_result


def display_data(value, active):
    if type(value) is subprocess.CompletedProcess:
        return display_data({key: item for key, item in {"returncode": value.returncode,
            "stdout": value.stdout, "stderr": value.stderr}.items() if item is not None}, active)
    kind = type(value)
    if kind not in (dict, list, tuple):
        if value is None or kind in (str, bool, int, float):
            return value
        return f"<{kind.__name__}; inspect _>"
    if id(value) in active:
        return "<cycle; inspect _>"
    if kind is dict and type(value.get("type")) is str and value["type"] == "image" and "data" in value and "mimeType" in value:
        # 宿主另行传递原始图片块；自动展示不重复灌入 Base64。
        return {key: value[key] for key in ("type", "mimeType", "note") if key in value}
    active.add(id(value))
    try:
        if kind is dict:
            if all(type(key) is str for key in value):
                return {key: display_data(item, active) for key, item in value.items()}
            # JSON 对象无法区分 1 与 "1"；条目列表保留所有键值，不静默覆盖。
            return {"dict_entries": [[display_data(key, active), display_data(item, active)]
                                     for key, item in value.items()]}
        return [display_data(item, active) for item in value]
    finally:
        active.remove(id(value))


def display_result(value):
    if type(value) is str:
        PLAIN_PRINT(value)
        return
    try:
        visible = display_data(value, set())
        # 紧凑 JSON 减少模型 token；合并小片段，避免每个标点都经过捕获与计数。
        chunks = []
        size = 0
        for chunk in json.JSONEncoder(ensure_ascii=False, separators=(",", ":")).iterencode(visible):
            chunks.append(chunk)
            size += len(chunk)
            if size >= 8192:
                sys.stdout.write("".join(chunks))
                chunks.clear()
                size = 0
        chunks.append("\n")
        sys.stdout.write("".join(chunks))
    except (ValueError, TypeError, RecursionError):
        # 计算已完成；展示失败不能诱导重放副作用，完整对象仍保留在 _。
        PLAIN_PRINT("\n[result display incomplete; inspect _]")
