import copy
import json
import unittest

from google.genai import types

import main
from context_budget import compact_evidence, input_tokens, MAX_INPUT_TOKENS
from groq_provider import groq_messages, tool_schema
from signet_tools import get_signet_settings, INVENTORY
from tools import PROJECT


class ContextBudgetTest(unittest.TestCase):
    def test_three_copied_source_runs_and_settings_fit_in_evidence_only_mode(self):
        # Live runs grow indefinitely; keep this compression regression reproducible.
        files = sorted(f'runs/{run}/work/{item["path"]}'
                       for run in ('cis_toy_01', 'tcga_geno_qc_01', 'cis_simulated_validation_20261020_02')
                       for item in INVENTORY['scripts'])
        messages = [types.Content(role='user', parts=[types.Part(text='查看資料檔案及已有工作的記錄，不執行分析。')])]
        for index, (name, args, result) in enumerate([
            ('list_files', {'folder': str(PROJECT)}, {'files': files}),
            ('get_signet_settings', {'run_id': 'cis_toy_01'}, get_signet_settings('cis_toy_01')),
        ]):
            messages.extend([
                types.Content(role='model', parts=[types.Part(function_call=types.FunctionCall(id=str(index), name=name, args=args))]),
                types.Content(role='user', parts=[types.Part(function_response=types.FunctionResponse(id=str(index), name=name, response=result))]),
            ])
        body = {'messages': groq_messages(messages, main.config.system_instruction),
                'tools': [tool_schema(fn) for fn in main.config.tools]}
        body.pop('tools')
        self.assertLess(input_tokens(body, 'qwen/qwen3.8-27b'), MAX_INPUT_TOKENS)

    def test_compaction_is_lossless_including_failures_parameters_and_paths(self):
        work = str(PROJECT / 'runs/demo/work')
        original = {'status': 'failed', 'executed': 'unknown', 'returncode': 2,
                    'settings': {f'input{i}': work + f'/missing/input{i}' for i in range(30)},
                    'operations': [{'status': 'prepared', 'executed': False}],
                    'error': 'Missing dependency; do not replay',
                    'files': sorted([f'runs/demo/work/script/phase2/file{i}.R' for i in range(60)] +
                                    ['runs/demo/work/script/phase2/a', 'runs/demo/work/script/phase2/a/z.R'])}
        snapshot = copy.deepcopy(original)
        compact = compact_evidence(original)
        self.assertLess(len(json.dumps(compact)), len(json.dumps(original)))
        prefixes = compact.pop('_path_prefixes', {})
        def restore(value):
            if isinstance(value, str):
                for alias, prefix in prefixes.items():
                    if value.startswith(alias + '/'):
                        return prefix + value[len(alias):]
            if isinstance(value, list):
                return [restore(item) for item in value]
            if isinstance(value, dict):
                if value.get('_encoding') == 'files_by_directory':
                    directories = value['directories']
                    return sorted(directory + '/' + name if directory else name
                                  for directory, names in directories.items()
                                  for name in (directories[names['same_files_as']] if isinstance(names, dict) else names))
                return {key: restore(item) for key, item in value.items()}
            return value
        self.assertEqual(restore(compact), original)
        self.assertEqual(original, snapshot)

    def test_duplicate_copied_source_directories_are_referenced_without_dropping_paths(self):
        files = sorted(f'runs/{run}/work/script/phase2/file{i}.R'
                       for run in ('demo1', 'demo2') for i in range(60))
        compact = compact_evidence({'files': files})
        directories = compact['files']['directories']
        self.assertEqual(directories['runs/demo2/work/script/phase2'],
                         {'same_files_as': 'runs/demo1/work/script/phase2'})
        self.assertEqual(len(directories['runs/demo1/work/script/phase2']), 60)

    def test_token_counter_handles_chinese_and_rejects_unsupported_models_conservatively(self):
        self.assertGreater(input_tokens({'messages': ['資料' * 100]}, 'qwen/qwen3.8-27b'), 100)
        self.assertGreaterEqual(input_tokens({'messages': ['資料' * 100]}, 'other-model'), 600)


if __name__ == '__main__':
    unittest.main()
