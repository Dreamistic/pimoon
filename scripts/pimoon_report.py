"""本地元数据复盘；不读取会话正文、代码或凭据。"""
from collections import Counter, defaultdict
import json
import math
from pathlib import Path

SCALARS = set('''schema run pid seq at mono_ms type application_run_id session_id agent_run_id model_request_id
 tool_call_id parent_tool_call_id code_call_id bridge_call_id bridge_index batch_id batch_index runtime_id
 reason tool provider model status stop_reason aborted elapsed_ms startup_ms requests cancelled outcome is_error usage_reported
 prewarmed python_pid python_version previous_python_pid state_restored had_state completed_writes_rolled_back
 jobs completed failed peak_concurrency concurrency_limit output_text_chars telemetry_complete
 body_inspected author app_version privacy jev node platform arch output_limit_chars retention_limit_chars
 request_budget code_timeout_ms batch_max_jobs batch_max_concurrency telemetry_enqueue_ms telemetry_pending_bytes'''.split())
METRICS = set('''outcome metrics_complete ok error_type host_ms python_ms compile_ms compile_cache_hit bridge_wait_ms
 observation_ms auto_observations explicit_observations observation_readbacks observation_readback_errors
 observation_input_rows observation_shown_rows python_pid cached_blocks frames broker_service_us native_read_us
 expression_results output_complete output_chars retained_output_chars displayed_output_chars display_truncated model_returned_text_chars
 tool_failure_count internal_tool_calls internal_tool_failures internal_output_text_chars batch_calls
 native_read_calls_observed native_read_trace_complete worker_telemetry_cpu_ms stdout_chars stderr_chars'''.split())
FIELDS = METRICS | set('''status error_code changed input_edit_count input_old_chars input_new_chars input_old_lines input_new_lines
 replacement_count before_size_bytes after_size_bytes input_query_chars input_query_lines input_query_sha256
 input_glob_chars input_glob_sha256 input_mode input_path_count scope_count scope_error_count query_mode truncated
 truncation_reasons total_candidate_count returned_match_count returned_file_count approx_token_count traversed_entry_count
 searched_file_count searched_byte_count scanned_file_count text_hit_count parsed_file_count dropped_text_hit_count
 dropped_related_anchor_count dropped_related_result_count ast_skipped_oversized_file_count skipped_file_count
 returned_verified_candidate_count returned_related_candidate_count ranking_algorithm ranking_candidate_count
 ranking_eligible_candidate_count ranking_selected_candidate_count ranking_head_size ranking_tier_count
 ranking_top_tier_candidate_count ranking_mmr_selected_count ranking_mmr_replacement_count
 ranking_relevance_prefix_file_count ranking_selected_file_count telemetry_input_error telemetry_result_error
 telemetry_input_limited telemetry_result_limited'''.split())


def scalar(value):
    return value is None or isinstance(value, (str, bool, int)) or isinstance(value, float) and math.isfinite(value)


def pick(value, keys):
    if not isinstance(value, dict):
        return {}
    return {key: item if scalar(item) else item[:64] for key, item in value.items()
            if key in keys and (scalar(item) or key in {'sources', 'truncation_reasons'}
                                and isinstance(item, list) and all(isinstance(part, str) for part in item))}


def fingerprint(value):
    if not isinstance(value, dict):
        return None
    return pick(value, {'sha256', 'chars', 'bytes'})


def sanitize(event):
    result = pick(event, SCALARS)
    for key in ('input', 'output', 'output_text', 'payload', 'code', 'error', 'workspace'):
        if isinstance(event.get(key), dict):
            result[key] = fingerprint(event[key])
    if isinstance(event.get('metrics'), dict):
        raw = event['metrics']
        result['metrics'] = pick(raw, METRICS)
        result['metrics']['filesystem_audit_attempts'] = pick(raw.get('filesystem_audit_attempts'),
            {'open', 'os.remove', 'os.rmdir', 'os.mkdir', 'os.chdir', 'os.rename', 'os.replace', 'os.listdir', 'os.scandir'})
        if isinstance(raw.get('native_read_trace'), list):
            result['metrics']['native_read_trace'] = [pick(item, {'index', 'target_sha256', 'ok', 'elapsed_ms', 'result_chars'})
                                                       for item in raw['native_read_trace'][:128]]
    if isinstance(event.get('tool_calls'), list):
        result['tool_calls'] = [pick(item, {'id', 'name'}) for item in event['tool_calls'][:64]]
    if isinstance(event.get('usage'), dict):
        result['usage'] = {key: value for key, value in pick(event['usage'], {'input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'}).items()
                           if isinstance(value, (int, float)) and not isinstance(value, bool)}
    if isinstance(event.get('performance'), dict):
        result['performance'] = pick(event['performance'], {'ttftWithThinkingMs', 'ttftWithoutThinkingMs'})
    return result


def read_lines(file):
    records, invalid = [], 0
    with file.open(encoding='utf-8', errors='replace') as stream:
        for line in stream:
            if not line.strip():
                continue
            try:
                if len(line) > 1_000_000:
                    raise ValueError('oversized line')
                value = json.loads(line)
                if not isinstance(value, dict) or not isinstance(value.get('type'), str) or not isinstance(value.get('at'), str):
                    raise ValueError('invalid record')
                records.append(value)
            except (ValueError, RecursionError):
                invalid += 1
    return records, invalid


def file_coverage(file, records, invalid):
    status = None
    try:
        value = json.loads(Path(str(file) + '.status.json').read_text(encoding='utf-8'))
        if isinstance(value, dict):
            status = pick(value, {'schema', 'at', 'complete', 'failure', 'closed', 'pendingBytes', 'acceptedBytes',
                                 'writtenBytes', 'acceptedRecords', 'writtenRecords', 'droppedRecords', 'writes', 'ioMs', 'checkpointMs'})
    except (OSError, ValueError, RecursionError):
        pass
    sequences = [item.get('seq') for item in records]
    sequence_ok = sequences == list(range(1, len(records) + 1))
    state = 'unverified'
    if invalid or not sequence_ok or status and (status.get('complete') is False or status.get('droppedRecords', 0) > 0):
        state = 'incomplete'
    elif status:
        if status.get('writtenRecords') != len(records) or status.get('pendingBytes', 0) != 0:
            state = 'checkpoint_mismatch'
        elif status.get('complete') is True and status.get('closed') is True and any(item.get('type') == 'backend_end' for item in records):
            state = 'complete'
        else:
            state = 'open_or_interrupted'
    return {'file': str(file), 'state': state, 'records': len(records), 'damaged_lines': invalid,
            'sequence_ok': sequence_ok, 'checkpoint': status}


def distribution(values):
    values = sorted(value for value in values if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value))
    if not values:
        return {'samples': 0}
    return {'samples': len(values), 'mean': sum(values) / len(values), 'p50': values[math.ceil(len(values) * .5) - 1],
            'p95': values[math.ceil(len(values) * .95) - 1]}


def event_key(event, identity):
    return event.get('run'), event.get('pid'), event.get('session_id'), event.get(identity)


def missing_ends(events, start, end, identity):
    ends = {event_key(item, identity) for item in events if item['type'] == end and item.get(identity) is not None}
    return sum(item.get(identity) is None or event_key(item, identity) not in ends for item in events if item['type'] == start)


def resource(value):
    return pick(value, {'kind', 'value', 'rank', 'group', 'sources', 'start_line', 'end_line', 'relevance_rank', 'ranking_tier', 'ranking_score', 'selection'})


def join_tool_facts(home, events):
    """只使用完整关联键；不凭相同工具名或相近时间猜测会话。"""
    indexed = defaultdict(list)
    for item in events:
        if item['type'] == 'tool_end':
            indexed[(item.get('run'), item.get('session_id'), item.get('tool_call_id'))].append(item)
    joined, invalid = 0, 0
    scopes = {(item.get('run'), item.get('session_id')) for item in events}
    for file in sorted((home / 'telemetry' / 'runs').glob('*.jsonl')):
        records, damaged = read_lines(file)
        invalid += damaged
        headers = {item.get('run_id'): item for item in records if item['type'] == 'run'}
        for record in records:
            if record['type'] != 'call':
                continue
            key = record.get('application_run_id'), record.get('session_id'), record.get('call_id')
            if key[:2] not in scopes:
                continue
            matches = indexed.get(key, []) if all(key) else []
            if len(matches) != 1:
                continue
            result = matches[0]
            result['tool_facts'] = {'run_id': record.get('run_id'), 'status': record.get('status'),
                                    'duration_ms': record.get('duration_ms'), 'truncated': record.get('truncated', False),
                                    'definition_hash': record.get('definition_hash'),
                                    'revision': pick(headers.get(record.get('run_id'), {}).get('git'), {'commit', 'dirty', 'dirty_diff_hash'}),
                                    'fields': pick(record.get('fields'), FIELDS),
                                    'targets': [resource(item) for item in record.get('targets', []) if isinstance(item, dict)],
                                    'candidates': [resource(item) for item in record.get('candidates', []) if isinstance(item, dict)]}
            joined += 1
    return {'joined': joined, 'unmatched': sum('tool_facts' not in item for values in indexed.values() for item in values),
            'damaged_lines': invalid}


def code_outcome(event):
    if isinstance(event.get('outcome'), str):
        return event['outcome']
    metrics = event.get('metrics', {})
    if isinstance(metrics.get('outcome'), str):
        return metrics['outcome']
    if event.get('cancelled'):
        return 'cancelled'
    if metrics.get('ok') is False:
        return 'python_error'
    if metrics.get('ok') is True:
        return 'tool_partial_failure' if metrics.get('tool_failure_count', 0) else 'success'
    return 'unknown'


def summarize(events):
    by_type = defaultdict(list)
    for event in events:
        by_type[event['type']].append(event)
    ends, codes, tools = by_type['model_end'], by_type['code_end'], by_type['tool_end']
    outcomes = Counter(code_outcome(item) for item in codes)
    direct = [item for item in tools if not item.get('parent_tool_call_id')]
    nested = [item for item in tools if item.get('parent_tool_call_id')]
    repeated = Counter((item.get('run'), item.get('pid'), item.get('session_id'), item.get('agent_run_id'), item.get('tool'), item.get('input', {}).get('sha256'))
                       for item in by_type['tool_start'] if item.get('input', {}).get('sha256'))
    return {
        'model_requests_prepared': len(by_type['model_request']), 'transport_attempts': len(by_type['transport_start']),
        'requests_without_end': missing_ends(events, 'model_request', 'model_end', 'model_request_id'),
        'tools_without_end': missing_ends(events, 'tool_start', 'tool_end', 'tool_call_id'),
        'python_without_end': missing_ends(events, 'code_start', 'code_end', 'tool_call_id'),
        'batches_without_end': missing_ends(events, 'batch_start', 'batch_end', 'batch_id'),
        'reported_tokens': sum(item.get('usage', {}).get('totalTokens', 0) for item in ends if item.get('usage_reported')),
        'unreported_usage': sum(not item.get('usage_reported') for item in ends),
        'provider_errors': sum(item.get('stop_reason') == 'error' for item in ends),
        'direct_tool_calls': len(direct), 'nested_tool_calls': len(nested),
        'tool_errors': sum(bool(item.get('is_error')) or item.get('tool_facts', {}).get('status') == 'error' for item in tools),
        'projection_limited_calls': sum(any(item.get('tool_facts', {}).get('fields', {}).get(key) is True
                                           for key in ('telemetry_input_limited', 'telemetry_result_limited')) for item in tools),
        'repeated_input_calls': sum(count - 1 for count in repeated.values()),
        'python_calls': len(codes), 'python_outcomes': dict(outcomes),
        'python_metrics_samples': sum(item.get('metrics', {}).get('metrics_complete') is True for item in codes),
        'python_failures': sum(count for name, count in outcomes.items() if name not in {'success', 'tool_partial_failure', 'unknown'}),
        'python_unknown_outcomes': outcomes['unknown'],
        'python_ms': distribution(item.get('elapsed_ms') for item in codes),
        'model_ms': distribution(item.get('elapsed_ms') for item in ends),
        'model_first_event_ms': distribution(item.get('elapsed_ms') for item in by_type['model_first_event']),
        'first_text_ms': distribution(item.get('performance', {}).get('ttftWithoutThinkingMs') for item in ends),
        'tool_wall_ms': distribution(item.get('elapsed_ms') for item in tools),
        'tool_execute_ms': distribution(item.get('tool_facts', {}).get('duration_ms') for item in tools),
        'compile_ms': distribution(item.get('metrics', {}).get('compile_ms') for item in codes),
        'bridge_wait_ms': distribution(item.get('metrics', {}).get('bridge_wait_ms') for item in codes),
        'batch_ms': distribution(item.get('elapsed_ms') for item in by_type['batch_end']),
        'runtime_startup_ms': distribution(item.get('startup_ms') for item in by_type['runtime_ready'] + by_type['runtime_reinitialized']),
        'transport_denials': dict(Counter(item.get('reason', 'unknown') for item in by_type['transport_denied'])),
        'tool_blocks': dict(Counter(item.get('reason', 'unknown') for item in by_type['tool_blocked'])),
        'tool_failure_count': sum(item.get('metrics', {}).get('tool_failure_count', 0) for item in codes),
        'display_truncated_calls': sum(item.get('metrics', {}).get('display_truncated') is True for item in codes),
        'retention_incomplete_calls': sum(item.get('metrics', {}).get('output_complete') is False for item in codes),
        'internal_output_chars': sum(item.get('metrics', {}).get('internal_output_text_chars', 0) for item in codes),
        'model_returned_chars': sum(item.get('metrics', {}).get('model_returned_text_chars', 0) for item in codes),
        'batch_calls': len(by_type['batch_end']),
        'partial_failure_batches': sum(0 < item.get('failed', 0) < item.get('jobs', 0) for item in by_type['batch_end']),
        'state_losses': len(by_type['runtime_state_lost']), 'state_reinitializations': len(by_type['runtime_reinitialized']),
    }


def build_report(home, run=None, session=None, agent=None, timeline=False):
    events, coverage, environments = [], [], []
    for file in sorted((home / 'telemetry').glob('*/backend-*.jsonl')):
        records, invalid = read_lines(file)
        if run and not any(item.get('run') == run for item in records):
            continue
        if session and not any(item.get('session_id') == session for item in records):
            continue
        if agent and not any(item.get('agent_run_id') == agent for item in records):
            continue
        coverage.append(file_coverage(file, records, invalid))
        environments.extend(sanitize(item) for item in records if item['type'] == 'backend_start')
        events.extend(sanitize(item) for item in records if (not run or item.get('run') == run)
                      and (not session or item.get('session_id') == session) and (not agent or item.get('agent_run_id') == agent))
    events.sort(key=lambda item: (str(item.get('at', '')), str(item.get('run', '')), item.get('pid', 0), item.get('seq', 0)))
    facts = join_tool_facts(home, events)
    turns = defaultdict(list)
    for event in events:
        if event.get('agent_run_id'):
            turns[(event.get('run'), event.get('session_id'), event['agent_run_id'])].append(event)
    turn_reports = []
    for (run_id, session_id, agent_id), items in turns.items():
        item = {'run': run_id, 'session_id': session_id, 'agent_run_id': agent_id,
                'settled': any(event['type'] == 'agent_settled' for event in items), 'summary': summarize(items),
                'model_requests': [event for event in items if event['type'] in {'model_request', 'model_end', 'transport_error', 'transport_denied'}],
                'executions': [event for event in items if event['type'] == 'code_end'],
                'batches': [event for event in items if event['type'] == 'batch_end'],
                'tools': [event for event in items if event['type'] == 'tool_end']}
        if timeline:
            item['timeline'] = items
        turn_reports.append(item)
    result = {'app': 'pimoon', 'report_schema': 2, 'events': len(events), 'summary': summarize(events),
              'coverage': coverage, 'environments': environments, 'tool_facts': facts, 'turns': turn_reports,
              'notes': ['订阅 Token 是额度用量，不是美元成本；未知用量不计为免费。',
                        'settled 只表示本轮结束，不代表任务成功或经过验证。',
                        'open_or_interrupted 无法区分仍在运行与异常退出；缺失结束事件不推断成功。',
                        '内部工具输出不等于模型曝光；返回字符是交给宿主的工具文本，不保证下一请求实际纳入；字符比不代表省下的 Token 或模型调用。',
                        'Python 输出字符为 Unicode 码点，宿主文本字符为 UTF-16 单元；耗时为墙钟时间，嵌套耗时不可相加。',
                        '重复参数不代表冗余操作；audit 只记录文件操作尝试，不证明成功。',
                        '工具事实保留本地项目路径；报告不含提示词、代码、文件正文或请求头。']}
    if timeline:
        result['unassigned_timeline'] = [event for event in events if not event.get('agent_run_id')]
    return result


def markdown(report):
    lines = ['# pimoon 本地复盘', '', '## 采集完整性', '']
    for file in report['coverage']:
        lines.append(f"- {Path(file['file']).parent.name}/{Path(file['file']).name}: {file['state']}; records={file['records']}; damaged={file['damaged_lines']}")
    for turn in report['turns']:
        lines.extend(['', f"## {turn['session_id']} / {turn['agent_run_id']}", '',
                      f"轮次已结束: {turn['settled']}", '```json', json.dumps(turn['summary'], ensure_ascii=False, indent=2), '```'])
        if 'timeline' in turn:
            lines.extend(['', '### 事件时间线', '```jsonl'])
            lines.extend(json.dumps(event, ensure_ascii=False) for event in turn['timeline'])
            lines.append('```')
    lines.extend(['', '## 口径', *('- ' + note for note in report['notes'])])
    return '\n'.join(lines) + '\n'
