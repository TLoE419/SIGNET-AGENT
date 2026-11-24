"""The model receives typed summaries, never private files or arbitrary diagnostic text.

Projection happens for every request, including restored conversation evidence. The
original records remain available to the manual workspace and are never rewritten.
"""
import json
import math
import re
import secrets
import threading

_OMIT = object()
_STATES = {'ok', 'invalid', 'error', 'failed', 'blocked', 'unavailable', 'prepared', 'created',
           'awaiting_confirmation', 'needs_review', 'needs_choice', 'not_started', 'not_submitted', 'submitting', 'submitted',
           'pending', 'queued', 'running', 'validating', 'completed', 'cancelled', 'cancelling',
           'unknown', 'interrupted', 'skipped', 'passed', 'warning', 'incomplete', 'unchecked',
           'stale', 'missing', 'problem', 'in_progress', 'ready', 'not_ready', 'requires_review'}
_STEPS = {'genotype', 'expression', 'adjust', 'cis', 'network', 'visualize'}
_SETUP = {'workspace', 'signet', 'container'}
_CHECKS = {'connection', 'workspace', 'slurm', 'apptainer', 'signet_source', 'container'}
_CODES = {'exports_incomplete', 'missing_or_unreadable_file', 'missing_file', 'missing_command',
          'scientific_script_failed', 'scientific_runtime_error', 'nonzero_exit', 'missing_outputs',
          'scheduler_state_unknown', 'submission_unconfirmed', 'cancelled', 'unclassified_failure',
          'classification_count_mismatch', 'insufficient_covariate_groups', 'invalid_numeric_values',
          'matrix_shape_mismatch', 'resource_memory_limit', 'clinical_columns', 'clinical_pairing_empty',
          'clinical_coverage', 'clinical_race_choice_required', 'clinical_missing_race',
          'clinical_missing_gender', 'clinical_race_groups', 'clinical_gender_groups',
          'stage_input_review_required', 'absolute_remote_path', 'blocked_by_paths', 'file_count',
          'unreadable_table', 'file_limit', 'time_limit', 'scan_limit', 'file_changed',
          'ped_map_markers', 'duplicate_sample', 'genotype_compatibility', 'expression_scale',
          'duplicate_clinical_patient', 'sample_identifier', 'no_overlap', 'unmatched_samples',
          'ambiguous_patient', 'missing_covariates', 'adjustment_groups', 'clinical_rows',
          'invalid_request', 'not_found', 'conflict', 'not_ready', 'remote_failed', 'privacy_blocked', 'stale_reference'}
_CODES |= {'scheduler_' + state.lower() for state in
           ('OUT_OF_MEMORY', 'TIMEOUT', 'NODE_FAIL', 'PREEMPTED', 'FAILED', 'CANCELLED')}
from agent.runtime.step_report import INPUT_ISSUE_CODES, FAILURE_CODES
_CODES |= INPUT_ISSUE_CODES | FAILURE_CODES | {'unclassified_input_issue'}
_PARAMETERS = {'restrict.tcga.geno', 'restrict.tcga', 'mind', 'geno', 'hwe', 'int', 'alpha.cis',
               'nperms', 'upstream', 'downstream', 'nboots', 'ncis', 'cor', 'ncores', 'memory',
               'walltime', 'freq', 'ntop', 'npc', 'cpus', 'mem_gb', 'hours', 'time'}
_COUNTS = {'rows', 'columns', 'samples', 'markers', 'ped_markers', 'patients', 'matched',
           'matched_patients', 'clinical_matched', 'missing_gender', 'missing_race',
           'unknown_race_count', 'unhandled_race_count', 'needs_choice_count', 'retained', 'excluded',
           'gender_group_count', 'genotype_patients', 'expression_patients', 'unmatched_genotype',
           'unmatched_expression', 'race_groups', 'gender_groups', 'duplicate_sample_ids',
           'duplicate_patients', 'fid_iid_mismatches', 'genes', 'connections', 'subnetworks',
           'displayed', 'snps', 'genes_after_dropping_the_last_5_rows', 'issue_count',
           'missing_output_count', 'error_evidence_count', 'count', 'study_samples', 'study_markers',
           'matched_markers', 'blank', 'rows_with_a_different_field_count'}
_FALLBACK = 'Private details are available only in the workspace review. Use the reported status and fixed diagnostic codes.'
_REFERENCE_PREFIX = 'modelref-'
MAX_REFERENCES = 4096
_REFERENCE_LOCK = threading.RLock()
_REFERENCES = {}
_REFERENCE_NAMES = {}


class StaleModelReference(ValueError):
    """An unknown process-local reference must never become a guessed execution ID."""


def resolve_model_references(arguments):
    if not isinstance(arguments, dict):
        return arguments
    result = dict(arguments)
    with _REFERENCE_LOCK:
        for key in ('run_id', 'dataset_id', 'history_id'):
            value = result.get(key)
            if isinstance(value, str) and value.startswith(_REFERENCE_PREFIX):
                if value not in _REFERENCES:
                    raise StaleModelReference('Refresh the workspace selection before using this reference.')
                result[key] = _REFERENCES[value]
    return result


def _number(value):
    if type(value) is int:
        return value if 0 <= value < 2 ** 53 else _OMIT
    return value if type(value) is float and math.isfinite(value) and 0 <= value < 2 ** 53 else _OMIT


def _boolean(value):
    return value if type(value) is bool else _OMIT


def _enum(values):
    return lambda value: value if isinstance(value, str) and value in values else _OMIT


def _identity(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}', value):
        return _OMIT
    with _REFERENCE_LOCK:
        if value.startswith(_REFERENCE_PREFIX):
            return value if value in _REFERENCES else _OMIT
        if value in _REFERENCE_NAMES:
            return _REFERENCE_NAMES[value]
        if len(_REFERENCES) >= MAX_REFERENCES:
            return _OMIT
        reference = _REFERENCE_PREFIX + secrets.token_hex(16)
        _REFERENCES[reference] = value
        _REFERENCE_NAMES[value] = reference
        return reference


def _parameter(value):
    if _number(value) is not _OMIT:
        return value
    return value if isinstance(value, str) and re.fullmatch(r'(?:[0-9]{1,9}(?::[0-9]{2}){1,2}|[0-9.eE+-]{1,24})', value) else _OMIT


def _project(value, schema):
    if callable(schema):
        return schema(value)
    if isinstance(schema, list):
        return [clean for item in value[:256] if (clean := _project(item, schema[0])) is not _OMIT] if isinstance(value, list) else _OMIT
    if not isinstance(value, dict):
        return _OMIT
    return {key: clean for key, rule in schema.items() if key in value and
            (clean := _project(value[key], rule)) is not _OMIT}


_NUMBERS = {key: _number for key in _COUNTS}
_PARAMS = {key: _parameter for key in _PARAMETERS}
_DIAGNOSTIC = {'code': _enum(_CODES), 'stage': _number, 'severity': _enum({'error', 'needs_review', 'warning'}),
               'count': _number, 'certainty': _enum({'confirmed', 'requires_review', 'unclassified'})}
_CLINICAL = {**_NUMBERS, 'available': _boolean, 'diagnostics': [_DIAGNOSTIC]}
_PROGRESS = {key: lambda value: value if isinstance(value, str) and re.fullmatch(r'[0-9]{1,12} [0-9]{1,12}', value) else _OMIT
             for key in ('preparation', 'imputation', 'expression_outputs', 'variant_filter', 'low_frequency', 'rare_variants', 'stage1', 'stage2', 'subnetworks')}
_FAILURE = {**_NUMBERS, 'classifications': [_enum(_CODES)], 'exit_code': _parameter,
            'slurm_state': _enum({'OUT_OF_MEMORY', 'TIMEOUT', 'NODE_FAIL', 'PREEMPTED', 'FAILED', 'CANCELLED'}),
            'certainty': _enum({'confirmed', 'requires_review', 'unclassified'}), 'diagnostics': [_DIAGNOSTIC],
            'evidence': _enum({'unclassified', 'recognized_execution_evidence'}),
            'next_action': _enum({'inspect_private_diagnostics'}),
            'accounting': {'state': _enum({'COMPLETED', 'FAILED', 'OUT_OF_MEMORY', 'TIMEOUT', 'NODE_FAIL', 'PREEMPTED',
                                           'CANCELLED', 'BOOT_FAIL', 'DEADLINE'}),
                           'exit_code': lambda value: value if isinstance(value, str) and re.fullmatch(r'[0-9]{1,3}:[0-9]{1,3}', value) else _OMIT,
                           'elapsed': lambda value: value if isinstance(value, str) and re.fullmatch(r'(?:[0-9]{1,3}-)?[0-9]{1,2}(?::[0-9]{2}){1,2}', value) else _OMIT,
                           'max_memory_mb': _number, 'requested_mem_gb': _number,
                           'node': lambda value: value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9-]{1,40}', value) else _OMIT},
            'log_tail': [lambda value: _log_line(value)]}


def _log_line(value):
    # Re-mask here too: a saved record is not trusted to have been masked.
    from agent.runtime.step_report import mask_log_line
    if not isinstance(value, str):
        return _OMIT
    line = mask_log_line(value)
    return line if line and not _TCGA.search(line) else _OMIT


def _result_file(value):
    return value if isinstance(value, str) and re.fullmatch(
        r'signet_(?:Genotype\.sampleID|Geno|gexpID|gexp|gene_name|gene_pos|matched\.gexp|new\.Geno(?:\.map|\.maf)?|'
        r'gexp(?:_rmpc)?\.data|geno\.data|all\.eQTL\.data|net\.gexp\.data|net\.genename|net\.genepos|Afreq|CoeffMat0|'
        r'all\.sig\.pValue_[0-9.e-]+|edgelist_[0-9.e-]+\.txt|count_vs_freq\.(?:pdf|eps)|top[0-9]{1,3}_freq[0-9.e-]+(?:\.html|_name\.txt)|'
        r'circular_top[0-9]{1,3}_freq[0-9.e-]+\.pdf)|signet-edges\.csv', value) else _OMIT


_SUMMARY = {**_NUMBERS, 'available': _boolean,
            'outputs': [{'file': _result_file, 'rows': _number, 'columns': _number, 'available': _boolean,
                         'rows_are': _enum({'samples', 'genes', 'SNPs', 'matched samples', 'retained samples', 'significant gene-SNP pairs',
                                            'regulatory edges', 'genes in the subnetwork'}),
                         'columns_are': _enum({'samples', 'genes', 'SNPs', 'genes with cis-eQTL', 'instrument columns'})}],
            'inputs': {key: {**_NUMBERS} for key in ('ped.file', 'map.file', 'gexp.file')},
            'work_units': _PROGRESS,
            'reference_preparation': {**_NUMBERS, 'match_rate': _number, 'chromosome': _parameter}}
_REVIEW = {'ready': _boolean, 'settings': _PARAMS, 'options': _PARAMS, 'resources': _PARAMS,
           'limits': {key: [_number] for key in _PARAMETERS}, 'issue_count': _number,
           'clinical': _CLINICAL, 'diagnostics': [_DIAGNOSTIC]}
_VALIDATION = {'available': _boolean, 'scope': _enum({'preliminary_before_qc'}),
               'status': _enum(_STATES),
               'checks': [{'kind': _enum({'genotype', 'expression', 'clinical'}),
                           'status': _enum(_STATES), 'metrics': _NUMBERS, 'issues': [_DIAGNOSTIC]}],
               'pairing': {**_NUMBERS, 'status': _enum(_STATES), 'issues': [_DIAGNOSTIC]},
               'stage_readiness': {str(i): {'status': _enum(_STATES), 'ready': _boolean,
                    'issues': [_DIAGNOSTIC], 'diagnostics': [_DIAGNOSTIC]} for i in range(1, 7)}}
_REVIEW['validation'] = _VALIDATION
_WORKSPACE = {'status': _enum(_STATES), 'state': _enum(_STATES), 'executed': lambda value: value if type(value) is bool or value == 'unknown' else _OMIT,
              'source': _enum({'live', 'archive', 'recorded'}), 'run_id': _identity, 'history_id': _identity,
              'dataset_id': _identity, 'stage': _number, 'step': _enum(_STEPS | _SETUP), 'attempt': _number,
              'ready': _boolean, 'read_only': _boolean, 'settings': _PARAMS, 'options': _PARAMS,
              'resources': _PARAMS, 'requires': [_enum(_STEPS)], 'limits': {key: [_number] for key in _PARAMETERS},
              'progress': _PROGRESS, 'summary': _SUMMARY, 'failure': _FAILURE, 'review': _REVIEW,
              'clinical': _CLINICAL, 'diagnostics': [_DIAGNOSTIC], 'validation': _VALIDATION,
              'workspace_action': {'version': _number, 'action': _enum({'view_stage', 'select_gene'}),
                                   'history_id': _identity, 'stage': _number},
              'outcome': _enum({'started', 'exists', 'running', 'failed', 'ready'}),
              'diagnostic_status': _enum({'recognized_error', 'no_recognized_error', 'not_available'}),
              'creates_workspace': _boolean,
              'job_id': lambda value: value if isinstance(value, str) and re.fullmatch(r'[0-9]{1,20}', value) else _OMIT}
_WORKSPACE['job'] = {key: _WORKSPACE[key] for key in ('state', 'attempt', 'job_id', 'settings', 'options', 'resources', 'progress', 'summary', 'failure', 'clinical')}


_TCGA = re.compile(r'TCGA-[A-Za-z0-9]{2}-[A-Za-z0-9]{4}', re.IGNORECASE)


def _gene(value):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,39}', value) and not _TCGA.search(value) else _OMIT


def _signed(value):
    return value if type(value) in (int, float) and math.isfinite(value) and abs(value) < 2 ** 53 else _OMIT


def _term(value):
    """A STRING/GO enrichment term: public vocabulary, bounded plain text."""
    return value if (isinstance(value, str) and 0 < len(value) <= 300 and value.isprintable()
                     and not _TCGA.search(value) and '/' not in value) else _OMIT


_EDGE = {'gene': _gene, 'frequency': _number, 'coefficient': _signed}
_NETWORK_GENES = {
    'network': {'genes': _number, 'connections': _number, 'subnetworks': _number},
    'hub_genes': [{'gene': _gene, 'degree': _number, 'targets': _number, 'regulators': _number}],
    'known_string_interactions': [{'gene_a': _gene, 'gene_b': _gene, 'score': _number}],
    'subnetworks': [{'number': _number, 'genes': _number, 'connections': _number, 'modularity_groups': _number,
                     'enrichment_terms': [{'term': _term, 'p_value': _number}]}],
    'dashboard': _enum({'not_exported'}),
    'gene': {'gene': _gene, 'found': _boolean, 'regulated_by': [_EDGE], 'regulates': [_EDGE]},
}
NETWORK_MEANING = ('An edge means the source gene regulates the target gene. frequency is the share of bootstrap '
                   'networks containing the edge; a positive coefficient is up-regulation, a negative one down-regulation.')


def safe_tool_result(name, value):
    """Construct model evidence from named fields and typed values; unknown shapes fail closed."""
    if not isinstance(value, dict):
        return {'status': 'invalid', 'executed': False, 'error_code': 'privacy_blocked', 'reason': _FALLBACK}
    result = _project(value, _WORKSPACE)
    if name == 'signet_catalog':
        from agent.tools.signet import signet_catalog
        result = signet_catalog()  # Audited program documentation, never a historical response's free text.
        for key in ('analysis_tools', 'signet_tools', 'analysis_script_files', 'source_entries', 'internal_scripts', 'development_files', 'all_tools_including_list_files'):
            if key in value and _number(value[key]) is not _OMIT:
                result[key] = value[key]
        if value.get('status') in _STATES:
            result['status'] = value['status']
    elif name == 'list_files':
        result.setdefault('status', 'ok')
        result['file_count'] = len(value['files']) if isinstance(value.get('files'), list) else value.get('file_count', 0)
        if _number(result['file_count']) is _OMIT:
            result['file_count'] = 0
    elif name == 'summarize_table':
        from agent.runtime.jobs.table_summary import _PUBLIC_COLUMNS, _PUBLIC_VALUES
        column = lambda text: text if isinstance(text, str) and (text in _PUBLIC_COLUMNS or re.fullmatch(r'column_[0-9]{1,5}', text)) else _OMIT
        result.update(_project(value, {**_NUMBERS, 'columns': [column], 'windows_line_endings': _boolean,
            'delimiter': _enum({'tab', 'comma', 'whitespace'})}))
        result['per_column'] = {}
        for key, entry in value.get('per_column', {}).items() if isinstance(value.get('per_column'), dict) else ():
            if column(key) is _OMIT or not isinstance(entry, dict):
                continue
            clean = _project(entry, {'blank': _number, 'distinct': lambda item: item if _number(item) is not _OMIT or item == 'more than 20' else _OMIT})
            if key in _PUBLIC_VALUES and isinstance(entry.get('values'), dict):
                clean['values'] = {label: count for label, count in entry['values'].items()
                                   if label in _PUBLIC_VALUES[key] and _number(count) is not _OMIT}
            result['per_column'][key] = clean
    elif name == 'check_hpc_environment':
        checks = _project(value.get('checks', []), [{'item': _enum(_CHECKS), 'status': _enum(_STATES)}])
        result['checks'] = [check for check in checks if set(check) == {'item', 'status'}] if checks is not _OMIT else []
        if {check['item'] for check in result['checks']} == _CHECKS:
            result['ready'] = all(check['status'] == 'ok' for check in result['checks'])
    elif name == 'read_hpc_setup_log':
        from agent.runtime.step_report import failure_summary
        if 'lines' in value:
            failure = failure_summary({'state': 'failed', 'failure_hints': value.get('lines', [])})
            if failure['classifications'] != ['unclassified_failure']:
                result['failure'] = _project(failure, _FAILURE)
                result['diagnostic_status'] = 'recognized_error'
            else:
                result['diagnostic_status'] = 'no_recognized_error'
        elif 'failure' not in result and 'diagnostic_status' not in result:
            result['diagnostic_status'] = 'not_available'
    elif name == 'get_network_genes':
        # Gene-level Stage 6 results are not personal data; everything else still fails closed.
        result.update(_project(value, _NETWORK_GENES))
        if 'hub_genes' in result:
            result['meaning'] = NETWORK_MEANING
    elif name == 'get_workspace_validation':
        if 'validation' not in value:
            result.update(_project(value, _VALIDATION))
    if isinstance(value.get('error_code'), str) and value['error_code'] in _CODES:
        result['error_code'] = value['error_code']
    if 'error' in value or 'reason' in value or 'lines' in value or not result:
        result.setdefault('status', 'invalid' if 'error' in value else 'unknown')
        result['reason'] = _FALLBACK
    return result


def _safe_call(call, names):
    from google.genai import types
    name = call.name if call.name in names else 'unavailable_tool'
    arguments = call.args or {}
    allowed = {'run_id': _identity, 'dataset_id': _identity, 'history_id': _identity, 'stage': _number,
               'source': _enum({'live', 'archive', 'recorded'}), 'action': _enum({'view_stage', 'select_gene'}),
               'panel': _enum({'workflow', 'visualization'}), 'visible': _boolean,
               'file': _enum({'ref', 'gmap', 'gtf', 'clinical'}), 'step': _enum(_STEPS | _SETUP),
               'frequency': _parameter, 'top_networks': _number, 'gene': _gene, 'limit': _number}
    clean = _project(arguments, allowed)
    if name == call.name and clean == arguments:
        return call
    return types.FunctionCall(id=call.id, name=name, args=clean)


def _withheld_text(original, projected):
    text = json.dumps(projected, ensure_ascii=False)
    def removed(value):
        if isinstance(value, dict):
            return any(str(key) not in text or removed(item) for key, item in value.items())
        if isinstance(value, list):
            return any(removed(item) for item in value)
        return isinstance(value, str) and value not in text
    return removed(original)


def model_contents(contents):
    """Return a request-only projection; never mutate the saved conversation."""
    from google.genai import types
    from agent.tools.registry import ALL_TOOLS
    names = {fn.__name__ for fn in ALL_TOOLS}
    projected, withheld = [], False
    for content in contents:
        parts = []
        tool_message = any(part.function_response for part in content.parts or [])
        for part in content.parts or []:
            if part.function_response:
                response = part.function_response
                clean = safe_tool_result(response.name, response.response)
                withheld |= _withheld_text(response.response, clean)
                parts.append(types.Part(function_response=types.FunctionResponse(
                    id=response.id, name=response.name if response.name in names else 'unavailable_tool', response=clean)))
            elif part.function_call:
                call = _safe_call(part.function_call, names)
                withheld |= call != part.function_call
                extras = set(part.model_dump(exclude_none=True)) - {'function_call', 'thought_signature'}
                withheld |= bool(extras)
                parts.append(part if call is part.function_call and not extras else
                             types.Part(function_call=call, thought_signature=part.thought_signature))
            elif part.text and not part.thought and not tool_message and content.role in ('user', 'model'):
                extras = set(part.model_dump(exclude_none=True)) - {'text'}
                withheld |= bool(extras)
                parts.append(types.Part.from_text(text=part.text) if extras else part)
            # Image/audio/file parts cannot cross the data boundary.
            else:
                withheld = True
        projected.append((content, parts))
    result = []
    for original, parts in projected:
        # Old assistant prose may repeat evidence that was private. Preserve user intent,
        # while retaining the complete original transcript only in the manual interface.
        if withheld and original.role == 'model':
            parts = [part for part in parts if part.function_call or part.function_response]
        if parts:
            result.append(original if parts == original.parts else types.Content(role=original.role, parts=parts))
    return result


def model_workspace_context(value):
    """Selection metadata is navigation context, never permission to share selected rows."""
    if not isinstance(value, dict):
        return None
    return _project(value, {key: _WORKSPACE[key] for key in
        ('dataset_id', 'history_id', 'run_id', 'source', 'stage')})


def model_analysis_context(value):
    """Keep linked-analysis ordering without exposing run names or arbitrary change text."""
    if not isinstance(value, list):
        return []
    result = []
    for row in value[:MAX_REFERENCES]:
        if not isinstance(row, dict):
            continue
        item = model_workspace_context({'run_id': row.get('run_id')})
        if not item:
            continue
        if type(row.get('number')) is int and row['number'] >= 0:
            item['number'] = row['number']
        item['latest'] = row.get('latest') is True
        if row.get('from_step') in _STEPS:
            item['from_step'] = row['from_step']
        result.append(item)
    return result
