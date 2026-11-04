"""未使用的调用返回值自动预览；完整值留在有限的单元格结果列表中。"""
import builtins
import json
from itertools import islice

PLAIN_PRINT = builtins.print
MAX_RESULTS = 8
MAX_PREVIEW = 600


def _preview(value, depth=0):
    kind = type(value)
    if kind is str:
        return value[:MAX_PREVIEW] + ("..." if len(value) > MAX_PREVIEW else "")
    if value is None or kind in (bool, float):
        return value
    if kind is int:
        return value if value.bit_length() < 1024 else "<large int>"
    if kind not in (dict, list, tuple):
        return "<" + kind.__name__ + ">"
    if depth >= 2:
        return "<" + kind.__name__ + " len=" + str(len(value)) + ">"
    if kind is dict:
        if type(value.get("type")) is str and value["type"] == "image" and "data" in value:
            return {"type": "image", "mimeType": value.get("mimeType")}
        items = list(islice(value.items(), 4))
        result = {str(key)[:80] if type(key) in (str, int, bool) else "<key>": _preview(item, depth + 1)
                  for key, item in items}
        if len(value) > 4:
            result["..."] = len(value) - 4
        return result
    items = [_preview(item, depth + 1) for item in value[:4]]
    if len(value) > 4:
        items.append("<" + str(len(value) - 4) + " more>")
    return items


class CellFeedback:
    def __init__(self):
        self.values = []
        self.previews = []
        self.total = 0

    def retain(self, value):
        self.values.append(value)
        if len(self.values) > MAX_RESULTS:
            self.values.pop(0)

    def capture(self, value):
        if value is None:
            return
        self.total += 1
        self.retain(value)
        try:
            preview = _preview(value)
            text = preview if type(preview) is str else json.dumps(preview, ensure_ascii=False, separators=(",", ":"))
        except (ValueError, TypeError, RecursionError):
            text = "<preview unavailable; inspect _results>"
        if len(text) > MAX_PREVIEW:
            marker = "...[preview]"
            text = text[:MAX_PREVIEW - len(marker)] + marker
        self.previews.append(text)
        if len(self.previews) > MAX_RESULTS:
            self.previews.pop(0)

    def show(self, final_value=None):
        if final_value is not None:
            self.retain(final_value)
        if not self.previews:
            return
        # 最多八项短预览；赋值、print 的 None 和全部局部变量不回灌。
        offset = max(0, len(self.previews) + int(final_value is not None) - MAX_RESULTS)
        shown = self.previews[offset:]
        omitted = self.total - len(shown)
        PLAIN_PRINT("results (preview; full=_results):" + (" omitted=" + str(omitted) if omitted else ""))
        for index, text in enumerate(shown):
            PLAIN_PRINT(str(index) + ": " + text)
