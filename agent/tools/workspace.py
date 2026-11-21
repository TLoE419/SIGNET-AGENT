"""Model tools share the manual workspace reviews; submission is never exposed."""
from agent.runtime import signet_jobs as jobs, workspace_genotype as workspace
from agent.tools import signet
from agent.runtime import step_report

STAGES = ('genotype', 'expression', 'adjust', 'cis', 'network', 'visualize')


def _stage(stage):
    if type(stage) is not int or not 1 <= stage <= 6:
        raise ValueError('stage must be an integer from 1 to 6.')
    return STAGES[stage - 1]


def get_workspace_stage(run_id: str, stage: int, source: str = 'live') -> dict:
    """Read saved settings, prerequisites and current attempt for one live workspace stage. No remote refresh or execution."""
    name = _stage(stage)
    if source != 'live':
        raise ValueError('Archived analyses are read-only; select an explicit live workspace run.')
    run_id = signet._name(run_id)
    root, history = workspace._workspace_run(run_id)
    record = history['jobs'].get(name, {})
    # Only public execution metadata; no matrices or clinical rows.
    public = {key: record[key] for key in ('state', 'attempt', 'job_id', 'settings', 'options', 'resources',
                                          'submitted_at', 'completed_at') if key in record}
    if record.get('step') == name or record.get('job_id'):
        public.setdefault('attempt', 1)
    if record.get('summary'):
        public['summary'] = step_report.safe_summary(name, record, record['summary'])
    public['progress'] = step_report.public_progress(record)
    if record.get('state') in ('failed', 'cancelled', 'unknown'):
        public['failure'] = step_report.failure_summary(record)
    current = signet._settings(root)
    step = jobs.STEPS[name]
    return {'status': 'ok', 'executed': False, 'source': source, 'run_id': run_id,
            'history_id': 'workspace--' + run_id, 'dataset_id': history['dataset_id'], 'stage': stage,
            'step': name, 'attempt': public.get('attempt'), 'job': public,
            'state': record.get('state', 'not_submitted'),
            'settings': {key: current.get(key) for key in step.settings},
            'options': {key: current.get(key, default) for key, (_, default) in step.prompts.items()},
            'requires': list(step.requires), 'resources': step.resources.copy(),
            'limits': {key: list(value) for key, value in step.limits.items()}}


def get_workspace_report(run_id: str, stage: int, source: str = 'live') -> dict:
    """Refresh one explicit live stage and return counts and safe diagnostics. No raw rows, IDs or log text."""
    before = get_workspace_stage(run_id, stage, source)
    result = step_report.report(run_id, _stage(stage))
    after = get_workspace_stage(run_id, stage, source)
    identity = ('source', 'run_id', 'history_id', 'dataset_id', 'attempt')
    if (any(before.get(key) != after.get(key) for key in identity)
            or before['job'].get('job_id') != after['job'].get('job_id')
            or ('state' in after and result['state'] != after['state'])):
        raise ValueError('The stage attempt changed during reporting. Refresh and review again.')
    return {**after, **result}


def _public_review(review):
    # Full manual reviews contain input paths and arbitrary source labels; these stay in the manual form.
    allowed = ('ready', 'settings', 'options', 'resources', 'limits')
    result = {key: review[key] for key in allowed if key in review}
    if review.get('issues'):
        result['issue_count'] = len(review['issues'])
    return result


def _proposal(result):
    from agent.tools.ui import request_workspace_action
    request_workspace_action(result['workspace_action'])
    return result


def propose_workspace_stage(run_id: str, stage: int, source: str = 'live') -> dict:
    """Review the SAME six-stage services as manual controls and propose opening manual review. Never submit, change settings, retry or cancel. Use explicit live run and stage; Stage 1 initial dataset selection stays in the manual form."""
    before = get_workspace_stage(run_id, stage, source)
    record = before['job']
    if stage == 1:
        if not record.get('attempt'):
            return _proposal({**before, 'status': 'needs_review',
                    'workspace_action': {'version': 1, 'action': 'view_stage',
                                         'history_id': before['history_id'], 'stage': stage},
                    'reason': 'Select the dataset and review Stage 1 inputs in the manual form.'})
        review = workspace.review_genotype_retry(run_id, record.get('job_id') or 'none', record['attempt'])
    else:
        review = {2: workspace.review_expression, 3: workspace.review_adjust,
                  4: workspace.review_cis, 5: workspace.review_network,
                  6: workspace.review_visualize}[stage](run_id)
    after = get_workspace_stage(run_id, stage, source)
    if before['job'] != after['job']:
        raise ValueError('The stage attempt changed during review. Refresh and review again.')
    return _proposal({**after, 'status': 'needs_review', 'executed': False, 'review': _public_review(review),
            'reason': 'Review current inputs, settings and prerequisites in the manual form and explicitly confirm there. This proposal is not execution authorization.',
            'workspace_action': {'version': 1, 'action': 'view_stage',
                                 'history_id': after['history_id'], 'stage': stage}})


def propose_workspace_dataset(dataset_id: str) -> dict:
    """Review saved dataset selections for a NEW Stage 1 using the manual review service; never create a run or submit."""
    from agent.runtime.workspace_validation import _saved
    saved = _saved(signet._name(dataset_id))
    review = workspace.review_dataset(dataset_id, saved['inputs'])
    return {'status': 'needs_review', 'executed': False, 'dataset_id': dataset_id,
            'stage': 1, 'review': _public_review(review),
            'reason': 'Open this dataset Stage 1 manual review, choose a new run and explicitly confirm the current inputs, settings and warnings.'}


WORKSPACE_TOOLS = [get_workspace_stage, get_workspace_report, propose_workspace_stage, propose_workspace_dataset]

# Preserve legacy Python entry points while removing scientific execution from the model allow-list.
LEGACY_EXECUTION = {'configure_signet', 'genotype_tcga', 'genotype_gtex', 'expression_tcga',
                    'expression_gtex', 'adjust_tcga', 'adjust_gtex', 'cis_eqtl', 'prepare_network',
                    'submit_network', 'cancel_network', 'prepare_visualization', 'run_visualization',
                    'run_pca', 'plot_pca', 'combine_covariates', 'adjust_expression', 'normalize_expression'}
