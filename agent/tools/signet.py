"""Fixed SIGNET entry points; source is read-only and each run owns its files."""
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import re
import shutil

from agent.paths import PROJECT_ROOT

PROJECT = PROJECT_ROOT
SOURCE = PROJECT / '.dependencies/official-signet'
INVENTORY = json.loads((PROJECT / 'signet_inventory.json').read_text())


def source_path():
    value = os.environ.get('SIGNET_SOURCE')
    path = Path(value).expanduser() if value else SOURCE
    return (PROJECT / path).resolve()


def _name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', value):
        raise ValueError('Use 1-64 letters, digits, underscores or hyphens, starting with a letter/digit.')
    return value


def _number(value, low, high, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('Expected a finite number.')
    if integer and not isinstance(value, int):
        raise ValueError('Expected an integer.')
    if not low <= value <= high:
        raise ValueError(f'Expected a value between {low} and {high}.')
    return str(value)


def _no_links(path):
    if any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError('Symbolic links are not accepted.')
    return path


def _run(run_id):
    root = _no_links(PROJECT / 'runs' / _name(run_id))
    if not (root / 'manifest.json').is_file():
        raise ValueError('Run configure_signet first with a new run_id.')
    _no_links(root / 'manifest.json')
    for folder in ('work', 'work/script', 'work/tmp', 'work/data', 'work/res', 'logs', 'home'):
        _no_links(root / folder)
    if any(p.is_symlink() for p in root.rglob('*')):
        raise ValueError('Run contains a symbolic link.')
    return root


def _verify_source(root=None):
    source = source_path()
    root = source if root is None else root
    if not source.is_dir() and root == source:
        raise ValueError('Official source unavailable. Run python scripts/setup_source.py or set SIGNET_SOURCE; see docs/INSTALL.md.')
    items = INVENTORY['scripts'] + (INVENTORY['support_files'] if root == source else [])
    for item in items:
        if root != source and re.fullmatch(r'script/adj/genosum_chr[0-9]+[.]R', item['path']):
            continue
        path = _no_links(root / item['path'])
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError(f'Source does not match audited revision: {item["path"]}')


def _settings(root):
    result = {}
    for line in (root / 'work/config.ini').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            result[key.strip()] = value.strip()
    return result


def _update(root, values):
    config = root / 'work/config.ini'
    lines = config.read_text().splitlines()
    for key, value in values.items():
        found = False
        for i, line in enumerate(lines):
            if '=' in line and line.split('=', 1)[0].strip() == key:
                lines[i] = f'{key} = {value}'
                found = True
        if not found:
            raise ValueError(f'Unknown setting: {key}')
    config.write_text('\n'.join(lines) + '\n')


# Facts the assistant states about this app. Keep them in step with agent/runtime/hpc.py,
# agent/runtime/signet_jobs.py and the official SIGNET scripts they cite.
HPC3_SETUP = [
    {'step': 'Check the environment', 'tool': 'check_hpc_environment', 'button': 'Check environment (HPC3 settings)',
     'what': 'Read-only check that HPC3 is ready: installation folder, Slurm, the container runtime, the pinned SIGNET '
             'source and example data, the container, the four reference files and the imputation conversion.'},
    {'step': 'Install SIGNET', 'tool': 'install_signet_source', 'button': '安裝',
     'what': 'Installs the official SIGNET source at the pinned commit, with its example data, on the HPC3 '
             'login node. Files are kept only if every hash matches; an existing installation is never replaced.'},
    {'step': 'Download the container', 'tool': 'download_signet_container', 'button': '下載',
     'what': 'Slurm job that downloads the SIGNET container provided by Prof. Zhang (about 6 GB) and keeps it only '
             'if its size and checksum match.'},
    {'step': 'Download reference files', 'tool': 'download_reference_file', 'button': '下載',
     'what': 'One Slurm job per file: ref (1000 Genomes GRCh38 chromosome 1 genotypes), gmap (SHAPEIT4 GRCh38 '
             'genetic map), gtf (GENCODE v22, collapsed to one record per gene for signet -t) and clinical '
             '(TCGA-LUAD case IDs, race and sex at birth from GDC, saved as submitter_id, race and gender).'},
    {'step': 'Choose your own reference file', 'tool': None, 'button': '選擇 HPC 檔案 (Workflow panel)',
     'what': 'The researcher may choose a file on HPC3 instead of a download. The app checks its format and that '
             'compute nodes can read it. Only the researcher can choose; the assistant never sees the path.'},
    {'step': 'Convert ref and gmap for imputation', 'tool': 'prepare_imputation_reference', 'button': '轉檔',
     'what': 'Slurm job that turns ref and gmap into IMPUTE2 inputs for the example study (chromosome 1): keeps '
             'only study markers whose position and alleles match the reference, and reports a counts-only '
             'summary with the match rate. Runs again when ref, gmap or the study change.'},
    {'step': 'Read a setup log', 'tool': 'read_hpc_setup_log', 'button': None,
     'what': 'Shows the last lines of one setup step\'s log, to explain a failure. Logs hold counts and messages, '
             'no research data.'},
]
_HOW_TO_RUN = ('From the confirmation card in chat. The researcher reviews the inputs, settings and resources, '
               'then confirms; the job runs on HPC3 through Slurm. The assistant cannot confirm a card.')
# What each card setting controls, quoted from SIGNET's own README.md (pinned commit). The card
# may show the app's starting value instead of SIGNET's default; choosing values is the researcher's.
_README = 'SIGNET README.md'
_RESTRICT = ('specifing chromosome(s) of interest, which may be dash separated, e.g. 1-22; comma separated, '
             'e.g. 1,2,3; or simply a number, e.g. 1.')
STAGE_PARAMETERS = {
    'genotype': {
        'restrict.tcga.geno': _RESTRICT,
        'mind': 'missing rate cutoff for individuals, a value in [0, 1]. By default 0.1',
        'geno': 'missing rate cutoff for SNPs, a value in [0, 1]. By default 0.1',
        'hwe': 'Hardy-Weinberg equilibrium cutoff, a value in (0, 1]. By default 10^-4',
        'int': 'a positive number specifying the interval length for imputation. By default 5 * 10^6',
    },
    'expression': {'restrict.tcga': _RESTRICT},
    'adjust': {
        'npc': 'Number of genotype PCs for population structure (script/adj/adj.sh asks "Enter the number of PCs '
               'for population structures"); expression is adjusted for these top PCs, race and gender.',
    },
    'cis': {
        'alpha.cis': 'specifying a value in (0, 1) as the significance level for identifying instrumental '
                     'variables. By default 0.05',
        'nperms': 'specifying the number of permutations. By default 100',
        'upstream': 'specifying the number of base pairs upstream each genetic region. By default 1000 (base pairs, so 1000 = 1 kb)',
        'downstream': 'specifying the number of base pairs downstream each genetic region. By default 1000 (base pairs, so 1000 = 1 kb)',
    },
    'network': {
        'nboots': 'an integer as the number of bootstrapping data sets taken in calculation. By deault 100',
        'ncis': 'an integer as the maximum number of biomarkers associated with each gene. By default 3',
        'cor': 'a value in [-1, 1] specifying the maximum correlation between biomarkers. By default 0.6 '
               '(the README; SIGNET\'s config.ini.default, which the card starts from, sets 0.3)',
        'ncores': 'number of cores for each node. By default 128 (this app allows 1-64 per job on HPC3)',
        'memory': 'memory of each node, in GB. By default 256 (this app allows 1-128 GB per job on HPC3)',
        'walltime': 'maximum wall time for cluster. By default 4:00:00',
    },
    'visualize': {
        'freq': 'specifying the bootstrap frequency cutoff as a value in [0, 1]. By default 1',
        'ntop': 'specifying the number of top subnetworks to visualize. By default 1',
    },
}
RESOURCE_NOTE = ('cpus, mem_gb and hours on each card are the Slurm resources requested for that step\'s job on '
                 'HPC3, not SIGNET parameters. For -n, ncores, memory and walltime size the jobs SIGNET submits itself.')
_STAGE_KEYS = ('genotype', 'expression', 'adjust', 'cis', 'network', 'visualize')


ANALYSIS_STAGES = [
    {'stage': 1, 'flag': '-g', 'name': 'Genotype preprocessing',
     'purpose': 'Quality control with PLINK (removes samples and SNPs with too many missing calls, and SNPs that '
                'fail Hardy-Weinberg equilibrium, using the mind, geno and hwe settings), then IMPUTE2 fills in '
                'missing genotypes at the study\'s own SNPs. SIGNET runs IMPUTE2 with -include_snps empty '
                '(script/geno_prep/imputation.sh), so no new SNPs are added.',
     'inputs': 'Study genotypes (PED and MAP), the imputation reference (.gen) and genetic map (IMPUTE2 format). '
               'The conversion setup step prepares the last two for the example study.',
     'how_to_run': 'The assistant prepares the first card with propose_hpc3_genotype. ' + _HOW_TO_RUN},
    {'stage': 2, 'flag': '-t', 'name': 'Expression preprocessing',
     'purpose': 'Removes samples with fewer than 2.5 million total reads and genes with very low counts, applies '
                'the DESeq2 variance-stabilizing transformation, and uses the GTF to keep protein-coding genes '
                'and record each gene\'s position.',
     'inputs': 'TCGA expression matrix, collapsed GENCODE v22 GTF.',
     'how_to_run': _HOW_TO_RUN},
    {'stage': 3, 'flag': '-a', 'name': 'Sample matching and covariate adjustment',
     'purpose': 'Matches expression and genotype samples, keeps SNPs with a minor allele count of at least 5, '
                'computes genotype principal components for population structure, and removes the effects of '
                'race, gender and the chosen number of components from expression by regression. SIGNET\'s own '
                'script treats race "not reported" as white and removes "american indian or alaska native".',
     'inputs': 'Clinical table with submitter_id, race and gender columns; results of stages 1 and 2.',
     'how_to_run': _HOW_TO_RUN},
    {'stage': 4, 'flag': '-c', 'name': 'cis-eQTL mapping',
     'purpose': 'For each gene, tests the SNPs within the upstream and downstream distance for association with '
                'its expression. Common, low-frequency and rare variants are tested separately, the last two by '
                'permutation (nperms). Gene-SNP pairs significant at alpha.cis become instruments for stage 5.',
     'inputs': 'Results of stages 2 and 3.',
     'how_to_run': _HOW_TO_RUN},
    {'stage': 5, 'flag': '-n', 'name': 'Network construction',
     'purpose': 'Builds the gene regulatory network with two-stage penalized least squares (2SPLS) on nboots '
                'bootstrap data sets. How often an edge appears across bootstraps measures its robustness. '
                'SIGNET submits its own Slurm jobs; this stage follows them.',
     'inputs': 'Results of stage 4.',
     'how_to_run': _HOW_TO_RUN},
    {'stage': 6, 'flag': '-v', 'name': 'Network visualization',
     'purpose': 'Keeps edges whose bootstrap frequency is at least freq, draws the top ntop subnetworks as '
                'interactive HTML and circular PDF, and runs functional enrichment with the online STRING '
                'database. Results are shown in chat and can be downloaded.',
     'inputs': 'Results of stage 5.',
     'how_to_run': _HOW_TO_RUN},
]
for _stage, _key in zip(ANALYSIS_STAGES, _STAGE_KEYS):
    _stage['step'] = _key
    _stage['parameters'] = {name: {'meaning': text, 'source': _README} for name, text in STAGE_PARAMETERS[_key].items()}


SCOPE = {
    'cohort': 'The HPC3 chat workflow supports TCGA only.',
    'reference_data': 'Prepared for chromosome 1 only, matching the SIGNET example study (simulated TCGA-LUAD data).',
    'genome_build': 'ref, gmap and GTF use GRCh38; study genotypes must use the same build.',
    'results': 'A finished step means the expected files exist; it does not establish biological validity.',
}


def signet_catalog() -> dict:
    """List audited SIGNET scripts, analysis tools, phases and execution restrictions."""
    from agent.tools.general import GENERAL_TOOLS
    from agent.tools.hpc import HPC_TOOLS
    from agent.tools.registry import ALL_TOOLS
    return {'status': 'ok', 'revision': INVENTORY['revision'], 'analysis_script_files': 138,
            'source_entries': 16, 'internal_scripts': 121, 'development_files': 3,
            'signet_tools': len(SIGNET_TOOLS), 'all_tools_including_list_files': len(ALL_TOOLS),
            'general_tools': [fn.__name__ for fn in GENERAL_TOOLS], 'hpc_tools': [fn.__name__ for fn in HPC_TOOLS],
            'scripts': INVENTORY['scripts'],
            'hpc3_setup': HPC3_SETUP, 'analysis_stages': ANALYSIS_STAGES, 'resources': RESOURCE_NOTE, 'scope': SCOPE,
            'note': 'Preparation is not execution. No scientific success is inferred from exit code alone.'}


def configure_signet(run_id: str, cohort: str = 'TCGA', nchr: int = 22, ncores: int = 2) -> dict:
    """Create a NEW isolated SIGNET run; never overwrite a run or edit official source.

    Args:
        run_id: Unique letters/digits/underscore/hyphen run name.
        cohort: TCGA or GTEx.
        nchr: Autosome count from 1 to 22.
        ncores: Local worker count from 1 to 8.
    """
    try:
        _name(run_id)
        if cohort not in ('TCGA', 'GTEx'):
            raise ValueError('cohort must be TCGA or GTEx.')
        _number(nchr, 1, 22, True)
        _number(ncores, 1, 8, True)
        _verify_source()
        source = source_path()
        root = _no_links(PROJECT / 'runs' / run_id)
        root.mkdir(parents=True, exist_ok=False)
        work = root / 'work'
        work.mkdir()
        for folder in ('tmp', 'data', 'res'):
            (work / folder).mkdir()
        for folder in ('logs', 'home'):
            (root / folder).mkdir()
        for item in INVENTORY['scripts']:
            destination = work / item['path']
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / item['path'], destination)
        # The scheduler templates are data, not independently callable scripts.
        for path in (source / 'script/network').glob('template.sub*'):
            shutil.copy2(_no_links(path), work / 'script/network' / path.name)
        shutil.copy2(_no_links(source / 'config.ini.default'), work / 'config.ini')
        defaults = _settings(root)
        path_keys = ['ped.file','map.file','gmap','ref','vcf0','vcf.file','read.file','anno',
                     'gexp.file','pmap.file','reads.file','tpm.file','gtf.file','cli.file','pheno',
                     'snps.map','snps.maf','matched.gexp','matched.gexp.withpc','matched.geno',
                     'gene.pos','net.gexp.data','net.geno.data','sig.pair','net.genename',
                     'net.genepos','sif','Afreq','coef','vis.genepos','tf']
        values = {key: str(work / 'missing' / key) for key in path_keys}
        values.update(cohort=cohort, nchr=nchr, ncore_local=ncores, ncores=ncores,
                      forcerm='F', interactive='F', email='F')
        for key in defaults:
            if key.startswith(('resg.', 'rest.', 'resa.')) or key in ('resc','resn','resv'):
                folder = key.split('.')[0]
                (work / 'res' / folder).mkdir(exist_ok=True)
                values[key] = str(work / 'res' / folder / 'signet')
        _update(root, values)
        (root / 'manifest.json').write_text(json.dumps({'revision': INVENTORY['revision'], 'cohort': cohort}) + '\n')
        return {'status': 'created', 'run_id': run_id, 'work_directory': str(work), 'settings': _settings(root)}
    except (ValueError, OSError) as exc:
        return {'status': 'invalid', 'error': str(exc)}


def get_signet_settings(run_id: str) -> dict:
    """Read settings and recorded operation states from an existing isolated run; no scientific execution."""
    try:
        root = _run(run_id)
        operations = []
        for path in sorted(root.glob('*.json')):
            if path.name == 'manifest.json':
                continue
            record = json.loads(path.read_text())
            if path.name.endswith('.plan.json'):
                operations.append({'operation':record.get('operation'), 'status':'prepared', 'executed':False})
            else:
                state = {key:record[key] for key in ('operation','status','executed','returncode','output_files','stdout_log','stderr_log') if key in record}
                if state.get('status') == 'starting':
                    state['executed'] = 'unknown'
                operations.append(state)
        return {'status': 'ok', 'settings': _settings(root), 'operations':operations}
    except (ValueError, OSError, TypeError, AttributeError) as exc:
        return {'status': 'invalid', 'error': str(exc)}


def propose_hpc3_genotype(run_id: str, use_example: bool = False) -> dict:
    """Prepare the first-stage HPC3 genotype review card for an existing TCGA run.

    Use example inputs only when requested. The researcher can edit the card
    and must click to approve. This tool never submits a job.
    """
    from agent.runtime import step_proposal
    from agent.runtime.signet_jobs import StepError
    session = step_proposal.CHAT_SESSION.get()
    if session is None:
        return {'status': 'unavailable', 'executed': False, 'reason': 'Open the desktop chat to review a proposal.'}
    try:
        step_proposal.prepare(run_id, session, 'example' if use_example else 'custom', allow_unlinked=True)
    except StepError as error:
        return {'status': error.code, 'executed': False, 'error': str(error)}
    return {'status': 'awaiting_confirmation', 'executed': False, 'run_id': run_id}


def get_step_report(run_id: str, step: str) -> dict:
    """State of one HPC3 analysis step ("-g", "-t", ...); for a failure, its masked log tail. Read-only."""
    from agent.runtime import step_proposal, step_report
    from agent.runtime.signet_jobs import StepError
    try:
        return step_report.report(run_id, step, step_proposal.CHAT_SESSION.get())
    except StepError as error:
        return {'status': error.code, 'executed': False, 'error': str(error)}


# Analyses run only on HPC3 through the chat confirmation cards (agent.runtime.signet_jobs);
# the model can explain, prepare a card and read reports, but never run a SIGNET step itself.
SIGNET_TOOLS = [signet_catalog, configure_signet, propose_hpc3_genotype, get_step_report, get_signet_settings]


def dispatch_tool(name, arguments):
    """Validate the model's tool name, keyword arguments and primitive types before dispatch."""
    from agent.tools.registry import ALL_TOOLS
    functions = {fn.__name__:fn for fn in ALL_TOOLS}
    try:
        if name not in functions or not isinstance(arguments, dict):
            raise ValueError('Unsupported tool or argument object.')
        fn = functions[name]
        signature = inspect.signature(fn)
        signature.bind(**arguments)
        for key,value in arguments.items():
            annotation = signature.parameters[key].annotation
            if annotation is int and (type(value) is not int):
                raise ValueError(f'{key} must be an integer.')
            if annotation is float and (type(value) not in (int,float)):
                raise ValueError(f'{key} must be numeric.')
            if annotation in (str,bool) and type(value) is not annotation:
                raise ValueError(f'{key} has the wrong type.')
            if annotation == list[str] and (not isinstance(value,list) or any(type(v) is not str for v in value)):
                raise ValueError(f'{key} must be a list of strings.')
        if name == 'list_files':
            if Path(arguments['folder']).resolve() != PROJECT:
                raise ValueError('The folder must be this project directory.')
            return {'files':fn(**arguments)}
        return fn(**arguments)
    except (ValueError,TypeError,OSError) as exc:
        return {'status':'invalid','executed':False,'error':str(exc)}
