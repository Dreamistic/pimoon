"""复盘报告只使用隔离的合成日志，不读取用户资料。"""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from pimoon_report import build_report, markdown


class ReplayReportTests(unittest.TestCase):
    def setUp(self):
        base = ROOT / '.tmp' / 'tests' / 'pimoon-report'
        base.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=base)
        self.home = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def event(self, kind, seq, **fields):
        return {'schema': 2, 'type': kind, 'run': 'run-a', 'pid': 10, 'seq': seq,
                'at': f'2026-11-03T10:00:{seq:02d}Z', 'session_id': 'session-a', 'agent_run_id': 'turn-a', **fields}

    def write_events(self, records, status=None, suffix=''):
        file = self.home / 'telemetry' / 'run-a' / 'backend-10.jsonl'
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(''.join(json.dumps(item) + '\n' for item in records) + suffix, encoding='utf-8')
        if status is not None:
            Path(str(file) + '.status.json').write_text(json.dumps(status), encoding='utf-8')
        return file

    def test_complete_chain_and_search_facts_join(self):
        events = [
            self.event('backend_start', 1), self.event('agent_begin', 2),
            self.event('model_request', 3, model_request_id='request-1'),
            self.event('transport_start', 4, model_request_id='request-1'),
            self.event('model_end', 5, model_request_id='request-1', usage={'totalTokens': 20}, usage_reported=True),
            self.event('code_start', 6, tool_call_id='code-1'),
            self.event('batch_start', 7, batch_id='batch-1'),
            self.event('tool_start', 8, tool_call_id='code-1/1', parent_tool_call_id='code-1', tool='grep'),
            self.event('tool_end', 9, tool_call_id='code-1/1', parent_tool_call_id='code-1', tool='grep', is_error=False),
            self.event('batch_end', 10, batch_id='batch-1', jobs=2, failed=1, completed=2),
            self.event('code_end', 11, tool_call_id='code-1', elapsed_ms=12, outcome='tool_partial_failure',
                       metrics={'ok': True, 'tool_failure_count': 1, 'internal_output_text_chars': 100, 'model_returned_text_chars': 10}),
            self.event('agent_settled', 12), self.event('backend_end', 13),
        ]
        self.write_events(events, {'complete': True, 'closed': True, 'writtenRecords': 13, 'pendingBytes': 0})
        runs = self.home / 'telemetry' / 'runs'
        runs.mkdir()
        (runs / 'tools.jsonl').write_text(json.dumps({'type': 'call', 'at': events[8]['at'], 'application_run_id': 'run-a',
            'session_id': 'session-a', 'call_id': 'code-1/1', 'run_id': 'harness-1', 'status': 'success', 'duration_ms': 3,
            'fields': {'searched_file_count': 100, 'ranking_algorithm': 'fixture', 'query': 'PRIVATE_QUERY'},
            'targets': [{'kind': 'path', 'value': 'src'}], 'candidates': [{'kind': 'file', 'value': 'src/a.ts', 'rank': 1}]}), encoding='utf-8')
        report = build_report(self.home, timeline=True)
        self.assertEqual(report['coverage'][0]['state'], 'complete')
        self.assertEqual(report['summary']['reported_tokens'], 20)
        self.assertEqual(report['summary']['nested_tool_calls'], 1)
        self.assertEqual(report['summary']['partial_failure_batches'], 1)
        self.assertEqual(report['summary']['python_failures'], 0)
        self.assertEqual(report['summary']['python_outcomes'], {'tool_partial_failure': 1})
        self.assertEqual(report['summary']['requests_without_end'], 0)
        self.assertEqual(report['tool_facts']['joined'], 1)
        self.assertEqual(report['turns'][0]['tools'][0]['tool_facts']['fields']['searched_file_count'], 100)
        self.assertTrue(report['turns'][0]['settled'])
        self.assertEqual(len(report['turns'][0]['timeline']), 13)
        self.assertNotIn('PRIVATE_QUERY', json.dumps(report))

    def test_stop_sequence_keeps_partial_usage_distinct_from_complete_usage(self):
        self.write_events([
            self.event('model_end', 1, stream_stop='stop_sequence', usage_status='unavailable', usage_reported=False, usage={'totalTokens': 0}),
            self.event('model_end', 2, stream_stop='stop_sequence', usage_status='partial', usage_reported=True, usage={'totalTokens': 12}),
            self.event('model_end', 3, usage_status='complete', usage_reported=True, usage={'totalTokens': 20}),
        ])
        summary = build_report(self.home)['summary']
        self.assertEqual(summary['stop_sequence_responses'], 2)
        self.assertEqual(summary['incomplete_usage'], 2)
        self.assertEqual(summary['unreported_usage'], 1)
        self.assertEqual(summary['reported_tokens'], 32)

    def test_missing_ends_and_unknown_outcomes_are_not_success(self):
        records = [self.event('model_request', 1, model_request_id='same', session_id='one'),
                   self.event('model_end', 2, model_request_id='same', session_id='two'),
                   self.event('code_start', 3, tool_call_id='never-ended'),
                   self.event('code_end', 4, tool_call_id='unknown', metrics={}),
                   self.event('code_end', 5, tool_call_id='timeout', outcome='timeout', metrics={'metrics_complete': False}),
                   self.event('code_end', 6, tool_call_id='cancel', cancelled=True),
                   self.event('batch_start', 7, batch_id='unfinished'),
                   self.event('tool_start', 8, tool_call_id='unfinished')]
        self.write_events(records)
        summary = build_report(self.home)['summary']
        self.assertEqual(summary['requests_without_end'], 1)
        self.assertEqual(summary['python_without_end'], 1)
        self.assertEqual(summary['tools_without_end'], 1)
        self.assertEqual(summary['batches_without_end'], 1)
        self.assertEqual(summary['python_unknown_outcomes'], 1)
        self.assertEqual(summary['python_failures'], 2)
        self.assertNotIn('success', summary['python_outcomes'])

    def test_damage_sequence_gap_and_capacity_failure_remain_visible(self):
        self.write_events([self.event('backend_start', 1), self.event('code_end', 3)],
                          {'complete': False, 'failure': 'total_limit', 'closed': True, 'droppedRecords': 7},
                          suffix='{broken\n[]\n')
        report = build_report(self.home)
        coverage = report['coverage'][0]
        self.assertEqual(coverage['state'], 'incomplete')
        self.assertFalse(coverage['sequence_ok'])
        self.assertEqual(coverage['damaged_lines'], 2)
        self.assertEqual(coverage['checkpoint']['droppedRecords'], 7)

    def test_live_and_stale_checkpoints_do_not_claim_complete(self):
        records = [self.event('backend_start', 1)]
        self.write_events(records, {'complete': True, 'closed': False, 'writtenRecords': 1, 'pendingBytes': 0})
        self.assertEqual(build_report(self.home)['coverage'][0]['state'], 'open_or_interrupted')
        self.write_events(records, {'complete': True, 'closed': True, 'writtenRecords': 2, 'pendingBytes': 0})
        self.assertEqual(build_report(self.home)['coverage'][0]['state'], 'checkpoint_mismatch')

    def test_filters_keep_stream_coverage_and_remove_other_sessions(self):
        self.write_events([self.event('agent_begin', 1),
                           self.event('code_end', 2, outcome='success', tool_call_id='one'),
                           self.event('agent_begin', 3, session_id='other', agent_run_id='other-turn'),
                           self.event('code_end', 4, outcome='python_error', session_id='other', agent_run_id='other-turn')])
        report = build_report(self.home, session='session-a', agent='turn-a', timeline=True)
        self.assertEqual(report['summary']['python_calls'], 1)
        self.assertEqual(len(report['turns']), 1)
        self.assertEqual(report['coverage'][0]['records'], 4)
        self.assertEqual(report['coverage'][0]['state'], 'unverified')
        self.assertNotIn('other-turn', json.dumps(report))

    def test_legacy_and_payload_fields_never_become_success_or_exported_content(self):
        self.write_events([self.event('code_end', 1, schema=1, tool_call_id='one', prompt='PRIVATE_PROMPT',
                          code='PRIVATE_CODE', error='PRIVATE_ERROR', metrics={'secret': 'PRIVATE_SECRET', 'ok': True})])
        report = build_report(self.home, timeline=True)
        text = json.dumps(report) + markdown(report)
        self.assertNotIn('PRIVATE_', text)
        self.assertEqual(report['coverage'][0]['state'], 'unverified')
        self.assertEqual(report['summary']['python_outcomes'], {'success': 1})
        self.assertIn('任务成功', text)

    def test_process_budget_cap_keeps_timings_without_exporting_arguments(self):
        self.write_events([self.event('process_timeout_capped', 1, requested_seconds=200,
                          effective_seconds=40, remaining_ms=45000, argv=['PRIVATE_ARG'], code='PRIVATE_CODE')])
        report = build_report(self.home, timeline=True)
        event = report['turns'][0]['timeline'][0]
        self.assertEqual(event['requested_seconds'], 200)
        self.assertEqual(event['effective_seconds'], 40)
        self.assertEqual(event['remaining_ms'], 45000)
        self.assertEqual(report['summary']['process_timeout_caps'], 1)
        self.assertNotIn('PRIVATE_', json.dumps(report))

    def test_empty_home_is_a_valid_empty_report(self):
        report = build_report(self.home)
        self.assertEqual(report['events'], 0)
        self.assertEqual(report['coverage'], [])
        self.assertEqual(report['summary']['python_ms'], {'samples': 0})


if __name__ == '__main__':
    unittest.main()
