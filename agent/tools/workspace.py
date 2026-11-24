"""Model tools share the manual workspace reviews; submission is never exposed."""
import csv
import json
import re

from agent.runtime import signet_jobs as jobs, workspace_genotype as workspace
from agent.tools import signet
from agent.runtime import step_report, workspace_datasets

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
        summary = record['summary']
        if 'reused_from' in record:
            try:
                from agent.runtime.workspace_projection import resolve_source, verify_source
                _, _, checks = resolve_source(run_id, name)
                verify_source(checks)
                saved = jobs._load(root, name)
                identity = ('run_id', 'step', 'state', 'job_id', 'attempt', 'settings', 'options',
                            'image', 'partition', 'reused_from', 'summary')
                if any(saved.get(key) != record.get(key) for key in identity):
                    raise ValueError('The saved inherited attempt changed during reporting.')
            except (OSError, ValueError, jobs.StepError):
                summary = None
        public['summary'] = step_report.safe_summary(name, record, summary)
    clinical = record.get('clinical')
    if name == 'adjust' and isinstance(clinical, dict) and isinstance(clinical.get('review'), dict):
        public['clinical'] = step_report.safe_clinical_review(clinical['review'])
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


def _public_review(review, stage=None):
    # Full manual reviews contain input paths and arbitrary source labels; these stay in the manual form.
    allowed = ('ready', 'settings', 'options', 'resources', 'limits')
    result = {key: review[key] for key in allowed if key in review}
    if review.get('issues'):
        result['issue_count'] = len(review['issues'])
        result['diagnostics'] = [{'code': 'stage_input_review_required', 'stage': stage,
                                  'severity': 'error'}]
    if stage == 3 and isinstance(review.get('clinical'), dict):
        result['clinical'] = step_report.safe_clinical_review(review['clinical'])
        result['diagnostics'] = result['clinical']['diagnostics'] + result.get('diagnostics', [])
    if isinstance(review.get('validation'), dict):
        result['validation'] = step_report.safe_input_validation(review['validation'])
    return result


def _proposal(result):
    from agent.tools.ui import request_workspace_action
    request_workspace_action(result['workspace_action'])
    return result


def propose_workspace_stage(run_id: str, stage: int, source: str = 'live') -> dict:
    """Review the SAME six-stage services as manual controls and propose opening manual review. Never submit, change settings, retry or cancel. Use explicit live run and stage; Stage 1 initial dataset selection stays in the manual form."""
    before = get_workspace_stage(run_id, stage, source)
    workspace_datasets.ensure_not_deleted(before.get('dataset_id'))
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
    return _proposal({**after, 'status': 'needs_review', 'executed': False, 'review': _public_review(review, stage),
            'reason': 'Review current inputs, settings and prerequisites in the manual form and explicitly confirm there. This proposal is not execution authorization.',
            'workspace_action': {'version': 1, 'action': 'view_stage',
                                 'history_id': after['history_id'], 'stage': stage}})


def propose_workspace_dataset(dataset_id: str) -> dict:
    """Review saved dataset selections for a NEW Stage 1 using the manual review service; never create a run or submit."""
    from agent.runtime.workspace_validation import _saved
    saved = _saved(signet._name(dataset_id))
    review = workspace.review_dataset(dataset_id, saved['inputs'])
    return {'status': 'needs_review', 'executed': False, 'dataset_id': dataset_id,
            'stage': 1, 'review': _public_review(review, 1),
            'reason': 'Open this dataset Stage 1 manual review, choose a new run and explicitly confirm the current inputs, settings and warnings.'}


def get_workspace_validation(dataset_id: str) -> dict:
    """Check selected inputs remotely and return approved statistics, never file contents or paths."""
    from agent.runtime import workspace_validation
    dataset_id = signet._name(dataset_id)
    saved = workspace_validation._saved(dataset_id)
    report = workspace_validation.validate(dataset_id, saved['inputs'])
    return {'status': 'ok', 'executed': False, 'dataset_id': dataset_id,
            'validation': step_report.safe_input_validation(report)}


GENE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,39}')


def _network_files(run_id):
    """The completed Stage 6 gene-level exports already downloaded into this live run."""
    root, history = workspace._workspace_run(signet._name(run_id))
    record = history['jobs'].get('visualize') or {}
    if record.get('state') != 'completed':
        raise jobs.StepError('not_ready', 'Stage 6 has not completed for this run.')
    directory = root / 'work/res/resv'
    label = format(float(record['settings']['freq']), '.15g')
    return directory / 'signet-edges.csv', directory / f'signet_dashboard_freq{label}.json', record


def get_network_genes(run_id: str, gene: str = '', limit: int = 20, source: str = 'live') -> dict:
    """Gene-level Stage 6 results (no patient data): hub genes by degree, known STRING interactions, enrichment terms, and one gene's regulators and targets when gene is given."""
    if source != 'live':
        raise ValueError('Select an explicit live workspace run.')
    if type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError('limit must be an integer from 1 to 50.')
    if gene and not GENE.fullmatch(gene):
        raise ValueError('gene must be a gene symbol.')
    edges_path, dashboard_path, record = _network_files(run_id)
    edges = []
    with signet._no_links(edges_path).open(newline='') as stream:
        for row in csv.DictReader(stream):
            edges.append((row['source_gene_symbol'].strip(), row['target_gene_symbol'].strip(),
                          float(row['frequency']), float(row['coefficient'])))
    regulates, regulated = {}, {}
    for source_gene, target_gene, _, _ in edges:
        regulates[source_gene] = regulates.get(source_gene, 0) + 1
        regulated[target_gene] = regulated.get(target_gene, 0) + 1
    genes = set(regulates) | set(regulated)
    # igraph::degree in server.R's Top Nodes counts both directions.
    ranked = sorted(genes, key=lambda name: (-(regulates.get(name, 0) + regulated.get(name, 0)), name))
    result = {'status': 'ok', 'executed': False, 'run_id': run_id, 'stage': 6,
              'settings': {key: record['settings'][key] for key in ('freq', 'ntop')},
              'network': {'genes': len(genes), 'connections': len(edges)},
              'hub_genes': [{'gene': name, 'degree': regulates.get(name, 0) + regulated.get(name, 0),
                             'targets': regulates.get(name, 0), 'regulators': regulated.get(name, 0)}
                            for name in ranked[:limit]],
              'meaning': 'An edge means the source gene regulates the target gene. frequency is the share of bootstrap '
                         'networks containing the edge; a positive coefficient is up-regulation, a negative one down-regulation.'}
    if dashboard_path.is_file():
        dashboard = json.loads(signet._no_links(dashboard_path).read_text())
        result['network']['subnetworks'] = dashboard['summary']['subnetworks']
        result['known_string_interactions'] = [
            {'gene_a': row.get('Protein 1'), 'gene_b': row.get('Protein 2'), 'score': row.get('Combined Score')}
            for row in dashboard.get('ppi') or [] if isinstance(row, dict)][:50]
        result['subnetworks'] = [
            {'number': item.get('number'), 'genes': item.get('genes'), 'connections': item.get('edges'),
             'modularity_groups': item.get('modularity_groups'),
             'enrichment_terms': [{'term': row.get('description'), 'p_value': row.get('p_value')}
                                  for row in item.get('pathway') or [] if isinstance(row, dict)][:30]}
            for item in dashboard.get('subnetworks') or [] if isinstance(item, dict)]
    else:
        result['dashboard'] = 'not_exported'
    if gene:
        matches = {name.upper(): name for name in genes}
        name = matches.get(gene.upper())
        result['gene'] = {'gene': name or gene, 'found': name is not None}
        if name:
            order = lambda item: (-item[2], -abs(item[3]))
            result['gene']['regulated_by'] = [{'gene': a, 'frequency': f, 'coefficient': c}
                                              for a, b, f, c in sorted((e for e in edges if e[1] == name), key=order)][:30]
            result['gene']['regulates'] = [{'gene': b, 'frequency': f, 'coefficient': c}
                                           for a, b, f, c in sorted((e for e in edges if e[0] == name), key=order)][:30]
    return result


WORKSPACE_TOOLS = [get_workspace_stage, get_workspace_report, propose_workspace_stage,
                   propose_workspace_dataset, get_workspace_validation, get_network_genes]

# Preserve legacy Python entry points while removing scientific execution from the model allow-list.
LEGACY_EXECUTION = {'genotype_tcga', 'genotype_gtex', 'expression_tcga',
                    'expression_gtex', 'adjust_tcga', 'adjust_gtex', 'cis_eqtl', 'prepare_network',
                    'submit_network', 'cancel_network', 'prepare_visualization', 'run_visualization',
                    'run_pca', 'plot_pca', 'combine_covariates', 'adjust_expression', 'normalize_expression'}
