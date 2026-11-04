"""模型请求计量；缺失终态或估算时保留未知，不混合不同来源的 token。"""
import math

ESTIMATE_KEYS = set('input visible_output tool_definitions tool_calls tool_results images encrypted_items elapsed_ms'.split())


def token_estimate(value):
    if not isinstance(value, dict) or value.get('method') != 'o200k_base':
        return None
    return {'method': 'o200k_base', **{key: number for key, number in value.items() if key in ESTIMATE_KEYS
            and isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number) and number >= 0}}


def summarize_tokens(events, start_type, end_type):
    def identity(event):
        return tuple(event.get(key) for key in ('run', 'pid', 'session_id', 'model_request_id'))
    starts, ends = {}, {}
    duplicates = set()
    for index, event in enumerate(events):
        if event['type'] not in {start_type, end_type}:
            continue
        key = identity(event)
        if any(part is None for part in key):
            key = ('unbound', index)
        target = starts if event['type'] == start_type else ends
        if key in target:
            duplicates.add(key)
            if target[key].get('usage', {}).get('totalTokens', 0) > event.get('usage', {}).get('totalTokens', 0):
                continue
        target[key] = event
    keys = starts.keys() | ends.keys()
    records = [(starts.get(key, {}), {**ends.get(key, {}), **({'usage_status': 'partial'} if key in duplicates else {})}) for key in keys]
    def status(end):
        if end.get('usage', {}).get('totalTokens', 0) <= 0:
            return 'unavailable'
        return end.get('usage_status', 'complete' if end.get('usage_reported') else 'unavailable')
    complete = sum(status(end) == 'complete' for _, end in records)
    paired = sum('input' in start.get('token_estimate', {}) and 'visible_output' in end.get('token_estimate', {})
                 for start, end in records)
    def total(key, side):
        return sum((start if side == 'input' else end).get('token_estimate', {}).get(key, 0) for start, end in records)
    reported = sum(end.get('usage', {}).get('totalTokens', 0) for _, end in records)
    input_tokens, output_tokens = total('input', 'input'), total('visible_output', 'output')
    definitions, calls_in = total('tool_definitions', 'input'), total('tool_calls', 'input')
    results, calls_out = total('tool_results', 'input'), total('tool_calls', 'output')
    return {'requests': len(records), 'ambiguous_requests': len(duplicates), 'complete_usage_requests': complete,
            'partial_usage_requests': sum(status(end) == 'partial' for _, end in records),
            'unknown_usage_requests': sum(status(end) == 'unavailable' for _, end in records),
            'provider_reported_tokens': reported,
            'provider_total_tokens': reported if records and len(starts) == len(ends) == complete == len(records) else None,
            'estimate': {'method': 'o200k_base', 'measured_requests': paired,
                         'visible_total_tokens': input_tokens + output_tokens if records and paired == len(records) else None,
                         'input_tokens': input_tokens, 'visible_output_tokens': output_tokens,
                         'tool_definition_input_tokens': definitions, 'tool_call_input_tokens': calls_in,
                         'tool_result_input_tokens': results, 'tool_call_output_tokens': calls_out,
                         'tool_tokens': definitions + calls_in + results + calls_out if records and paired == len(records) else None,
                         'images': total('images', 'input'), 'encrypted_items': total('encrypted_items', 'input'),
                         'accounting_ms': total('elapsed_ms', 'input') + total('elapsed_ms', 'output')}}
