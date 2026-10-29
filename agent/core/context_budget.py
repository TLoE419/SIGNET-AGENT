"""Lossless wire encodings and a conservative preflight for Groq requests."""
from functools import lru_cache
import json
from pathlib import Path
import re

from agent.paths import PROJECT_ROOT
from agent.tools.general import PROJECT

# Leave room below the observed 7,000 ITPM cap for service templates and reservations.
MAX_INPUT_TOKENS = 5200


class ContextBudgetError(ValueError):
    pass


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def compact_evidence(evidence):
    """Factor repeated paths without discarding values, states, files or parameters."""
    original = _json(evidence)
    roots = {str(PROJECT)}
    roots.update(re.findall(re.escape(str(PROJECT)) + r'/runs/[^/"\\]+/work', original))
    prefixes = {}
    for index, root in enumerate(sorted(roots, key=lambda root: (-len(root), root))):
        alias = f'@p{index}'
        while alias in original:
            alias = '@' + alias
        prefixes[alias] = root

    used = {}
    def encode(value, key=None):
        if isinstance(value, str):
            for alias, root in prefixes.items():
                if value.startswith(root + '/'):
                    used[alias] = root
                    return alias + value[len(root):]
            return value
        if isinstance(value, list):
            # A sorted list is reconstructed by sorting directory/name pairs globally.
            if key in ('files', 'output_files') and value and all(isinstance(v, str) for v in value) and value == sorted(value):
                groups = {}
                for path in value:
                    directory, _, name = path.rpartition('/')
                    groups.setdefault(directory, []).append(name)
                seen = {}
                for directory, names in list(groups.items()):
                    signature = tuple(names)
                    if signature in seen:
                        reference = {'same_files_as': seen[signature]}
                        if len(_json(reference)) < len(_json(names)):
                            groups[directory] = reference
                    else:
                        seen[signature] = directory
                grouped = {'_encoding': 'files_by_directory', 'order': 'sorted', 'directories': groups}
                if len(_json(grouped)) < len(_json(value)):
                    return grouped
            return [encode(item) for item in value]
        if isinstance(value, dict):
            return {name: encode(item, name) for name, item in value.items()}
        return value

    compact = encode(evidence)
    if used and isinstance(compact, dict) and '_path_prefixes' not in compact:
        compact['_path_prefixes'] = used
    elif used:
        return evidence
    return compact if len(_json(compact)) < len(original) else evidence


@lru_cache(maxsize=1)
def _qwen_tokenizer():
    from tokenizers import Tokenizer
    return Tokenizer.from_file(str(PROJECT_ROOT / 'assets/tokenizers/qwen3.8-27b.json'))


def input_tokens(body, model):
    # Count the whole JSON, including tool declarations, with extra template overhead.
    serialized = _json({key: body[key] for key in ('messages', 'tools') if key in body})
    if model == 'qwen/qwen3.8-27b':
        try:
            return len(_qwen_tokenizer().encode(serialized, add_special_tokens=False).ids) + 256
        except (ImportError, OSError, ValueError):
            pass
    # Unknown/missing tokenizer: bytes are deliberately conservative; never guess chars/4.
    return len(serialized.encode('utf-8')) + 256


def check_budget(body, model):
    count = input_tokens(body, model)
    if count > MAX_INPUT_TOKENS:
        raise ContextBudgetError(
            f'精簡後輸入估算為 {count} 詞元，超過安全預算 {MAX_INPUT_TOKENS}；'
            '為保留原始條件與完整工具證據，這次未送出模型請求。請縮小問題範圍，'
            '或在新對話提供必要條件；完整紀錄仍保留，不會重跑工具。')
    return count
