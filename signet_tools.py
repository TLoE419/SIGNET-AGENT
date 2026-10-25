"""Fixed SIGNET entry points; source is read-only and each run owns its files."""
import hashlib
import csv
import gzip
import importlib.util
import inspect
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys

PROJECT = Path(__file__).resolve().parent
SOURCE = PROJECT / '.dependencies/official-signet'
INVENTORY = json.loads((PROJECT / 'signet_inventory.json').read_text())
TIMEOUT_SECONDS = 300


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


def _input(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_./-]+', value):
        raise ValueError('Input paths may contain only letters, digits, _, ., / and -; upstream scripts do not quote paths safely.')
    raw = Path(value)
    raw = raw if raw.is_absolute() else PROJECT / raw
    _no_links(raw)
    path = raw.resolve()
    if not any(path.is_relative_to(PROJECT / folder) for folder in ('data', 'runs')):
        raise ValueError('Inputs must be inside this project data/ or runs/.')
    if any(part.startswith('.') for part in path.relative_to(PROJECT).parts):
        raise ValueError('Hidden inputs are not accepted.')
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f'Missing or empty input: {path}')
    return str(path)


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


def signet_catalog() -> dict:
    """List audited SIGNET scripts, analysis tools, phases and execution restrictions."""
    from tools import GENERAL_TOOLS
    return {'status': 'ok', 'revision': INVENTORY['revision'], 'analysis_script_files': 138,
            'source_entries': 16, 'internal_scripts': 121, 'development_files': 3,
            'analysis_tools': 15, 'signet_tools': 23, 'all_tools_including_list_files': 25,
            'general_tools': [fn.__name__ for fn in GENERAL_TOOLS],
            'scripts': INVENTORY['scripts'],
            'prepare_only': ['prepare_network', 'prepare_visualization'],
            'network_execution': ['submit_network', 'get_network_status', 'cancel_network'],
            'visualization_execution': ['run_visualization'],
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


def _execute(run_id, operation, command, values=None, dependencies=(), modules=(),
             cohort=None, stdin='', cwd=None, prerequisites=(), environment=None, prepare=False):
    root = None
    locked = False
    try:
        root = _run(run_id)
        _verify_source(root / 'work')
        if cohort and _settings(root)['cohort'] != cohort:
            raise ValueError(f'This tool requires cohort={cohort}.')
        for relative in prerequisites:
            path = root / 'work' / relative
            if not path.is_file() or not path.stat().st_size:
                raise ValueError(f'Required intermediate input is missing: {relative}')
        stage = _name(operation)
        if (root / f'{stage}.json').exists():
            raise ValueError('This operation was already attempted; use a new run to avoid overwriting outputs.')
        fd = os.open(root / '.active', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        locked = True
        work = root / 'work'
        argv = [part.replace('{work}', str(work)) for part in command]
        if values:
            _update(root, values)
        if operation == 'cis_eqtl' and sys.platform == 'darwin' and not prepare:
            from signet_runtime import execute_cis
            return execute_cis(root, _settings(root))
        if operation == 'visualization' and not prepare:
            from visualization_runtime import execute
            return execute(root, _settings(root))
        missing = [name for name in dependencies if shutil.which(name) is None]
        missing += [f'Python module: {name}' for name in modules if importlib.util.find_spec(name) is None]
        if 'bash' in dependencies and sys.platform != 'linux':
            missing.append('Linux with GNU getopt, sed, readlink, coreutils (upstream shell requirements)')
        plan = {'operation': operation, 'argv': argv, 'cwd': str(work / cwd) if cwd else str(work),
                'missing_dependencies': missing, 'stdin': stdin,
                'revision': INVENTORY['revision'], 'settings_file': str(work / 'config.ini')}
        if prepare:
            snapshot = root / f'{stage}.config.ini'
            shutil.copyfile(work / 'config.ini', snapshot)
            plan['settings_snapshot'] = str(snapshot)
            plan['manual_prerequisite'] = 'Restore settings_snapshot to settings_file before manually running argv; preparation never executes it.'
            (root / f'{stage}.plan.json').write_text(json.dumps(plan, indent=2)+'\n')
        if prepare or missing:
            return {'status': 'prepared' if prepare else 'unavailable', **plan, 'executed': False,
                    'reason': 'Manual execution required for scheduler submission or online interactive visualization.' if prepare else 'Required runtime is unavailable.'}
        before = {str(p): (p.stat().st_mtime_ns, p.stat().st_size)
                  for folder in ('res','tmp','data') for p in (work / folder).rglob('*') if p.is_file()}
        if cwd:
            (work / cwd).mkdir(parents=True, exist_ok=True)
        (root / f'{stage}.json').write_text(json.dumps({'status':'starting','executed':False,**plan})+'\n')
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(root / 'home'),
               'LANG': 'C', 'SIGNET_ROOT': str(work), 'SIGNET_SCRIPT_ROOT': str(work / 'script'),
               'SIGNET_DATA_ROOT': str(work / 'data'), 'SIGNET_TMP_ROOT': str(work / 'tmp'),
               'SIGNET_RESULT_ROOT': str(work / 'res'), **{k: str(v) for k,v in (environment or {}).items()}}
        outpath, errpath = root / 'logs' / f'{stage}.stdout', root / 'logs' / f'{stage}.stderr'
        # A process group lets timeout cleanup include scientific child workers.
        with outpath.open('xb') as stdout, errpath.open('xb') as stderr:
            with subprocess.Popen(argv, cwd=plan['cwd'], env=env, stdin=subprocess.PIPE,
                                  stdout=stdout, stderr=stderr, start_new_session=True) as process:
                try:
                    process.communicate(input=stdin.encode(), timeout=TIMEOUT_SECONDS)
                    status = 'process_completed' if process.returncode == 0 else 'failed'
                except (subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.communicate()
                    status = 'interrupted' if isinstance(exc, KeyboardInterrupt) else 'timed_out'
                returncode = process.returncode
        outputs = sorted(str(p.relative_to(root)) for folder in ('res', 'tmp', 'data')
                         for p in (work / folder).rglob('*') if p.is_file() and not p.is_symlink()
                         and before.get(str(p)) != (p.stat().st_mtime_ns,p.stat().st_size))
        result = {'status': status, 'executed': True, 'returncode': returncode, **plan,
                  'output_files': outputs[:1000], 'output_list_truncated': len(outputs)>1000,
                  'stdout_log': str(outpath), 'stderr_log': str(errpath),
                  'summary': 'Inspect outputs and logs; an exit code of zero does not establish scientific validity.'}
        (root / f'{stage}.json').write_text(json.dumps(result, indent=2)+'\n')
        return result
    except (ValueError, OSError) as exc:
        return {'status': 'invalid', 'executed': False, 'error': str(exc)}
    finally:
        if locked:
            (root / '.active').unlink(missing_ok=True)


def genotype_tcga(run_id: str, ped: str, map_file: str, reference_prefix: str, genetic_map_prefix: str,
                  mind: float = 0.1, geno: float = 0.1, hwe: float = 0.0001,
                  interval: int = 5000000, chromosome: int = 0) -> dict:
    """Stage 1 TCGA genotype QC and imputation. Prefixes must identify chr1.gen/chr1.map inputs; chromosome=0 means all."""
    ref = _prefix_inputs(reference_prefix, '.gen', run_id, chromosome)
    gmap = _prefix_inputs(genetic_map_prefix, '.map', run_id, chromosome)
    values = {'ped.file':_input(ped),'map.file':_input(map_file),'ref':ref,'gmap':gmap,
              'mind':_number(mind,0,1),'geno':_number(geno,0,1),'hwe':_number(hwe,0,1),
              'int':_number(interval,1,100000000,True),
              'restrict.tcga.geno':_number(chromosome,1,22,True) if chromosome else 'no'}
    return _execute(run_id,'genotype_tcga',['bash','{work}/signet','-g'],values,
                    ('bash','Rscript','perl','plink','impute2','ParaFly'),cohort='TCGA')


def _prefix_inputs(prefix, suffix, run_id, chromosome):
    nchr = int(_settings(_run(run_id))['nchr'])
    if chromosome:
        _number(chromosome,1,nchr,True)
    chromosomes = [chromosome] if chromosome else range(1,nchr+1)
    for number in chromosomes:
        path = _input(prefix + str(number) + suffix)
    return path[:-len(str(number)+suffix)]


def genotype_gtex(run_id: str, vcf_before_phasing: str, vcf: str, reads: str, annotation: str, tissue: str) -> dict:
    """Stage 1 GTEx genotype extraction and PLINK processing, using explicit input files."""
    return _execute(run_id,'genotype_gtex',['bash','{work}/signet','-g'],
                    {'vcf0':_input(vcf_before_phasing),'vcf.file':_input(vcf),'read.file':_input(reads),
                     'anno':_input(annotation),'tissue':_name(tissue)},
                    ('bash','Rscript','bcftools','tabix','plink'),cohort='GTEx')


def expression_tcga(run_id: str, expression: str, annotation_gtf: str, chromosome: int = 0) -> dict:
    """Stage 2 TCGA expression normalization and gene positions; chromosome=0 means all."""
    return _execute(run_id,'expression_tcga',['bash','{work}/signet','-t'],
                    {'gexp.file':_input(expression),'pmap.file':_input(annotation_gtf),
                     'restrict.tcga':_number(chromosome,1,22,True) if chromosome else 'no'},
                    ('bash','Rscript'),cohort='TCGA')


def expression_gtex(run_id: str, reads: str, tpm: str, annotation_gtf: str, tissue: str) -> dict:
    """Stage 2 GTEx expression preparation; requires genotype extraction intermediates."""
    return _execute(run_id,'expression_gtex',['bash','{work}/signet','-t'],
                    {'reads.file':_input(reads),'tpm.file':_input(tpm),'gtf.file':_input(annotation_gtf),'tissue':_name(tissue)},
                    ('bash','Rscript','python3','bgzip','tabix'),('numpy','pandas','scipy','feather'),cohort='GTEx',
                    prerequisites=('tmp/tmpg/subjid_wb_common.txt','tmp/tmpg/GTEx_snp.vcf.gz'))


def adjust_tcga(run_id: str, clinical: str, principal_components: int = 3) -> dict:
    """Stage 3 TCGA matching, PCA and covariate adjustment; choose PCs after inspecting plots in a prior exploratory run."""
    npc = _number(principal_components,0,10,True)
    return _execute(run_id,'adjust_tcga',['bash','{work}/signet','-a'],{'cli.file':_input(clinical)},
                    ('bash','Rscript','perl','ParaFly','smartpca.perl'),cohort='TCGA',stdin=npc+'\n',
                    prerequisites=('res/resg/signet_Geno','res/resg/signet_Genotype.sampleID','res/rest/signet_gexp','res/rest/signet_gexpID'))


def adjust_gtex(run_id: str, phenotype: str, annotation: str, annotation_gtf: str,
                tissue: str, principal_components: int = 3) -> dict:
    """Stage 3 GTEx PCA and covariate adjustment; requires genotype and expression preprocessing."""
    npc = _number(principal_components,0,10,True)
    return _execute(run_id,'adjust_gtex',['bash','{work}/signet','-a'],
                    {'pheno':_input(phenotype),'anno':_input(annotation),'gtf.file':_input(annotation_gtf),'tissue':_name(tissue)},
                    ('bash','Rscript','plink','smartpca.perl','python3'),('numpy','pandas','statsmodels'),
                    cohort='GTEx',stdin=npc+'\n',prerequisites=('tmp/tmpg/GTEx_snp.vcf',))


def cis_eqtl(run_id: str, expression: str, expression_with_pc: str, genotype: str,
             snp_map: str, snp_maf: str, gene_positions: str, alpha: float = 0.05,
             permutations: int = 100, upstream: int = 1000, downstream: int = 1000) -> dict:
    """Stage 4 cis-eQTL mapping; macOS uses the existing local Docker/Linux VM.

    No scheduler submission. A previous unavailable result may be retried after
    restoring the runtime, provided get_signet_settings shows no recorded attempt.
    """
    return _execute(run_id,'cis_eqtl',['bash','{work}/signet','-c'],
                    {'matched.gexp':_input(expression),'matched.gexp.withpc':_input(expression_with_pc),
                     'matched.geno':_input(genotype),'snps.map':_input(snp_map),'snps.maf':_input(snp_maf),
                     'gene.pos':_input(gene_positions),'alpha.cis':_number(alpha,1e-12,1),
                     'nperms':_number(permutations,1,10000,True),'upstream':_number(upstream,0,10000000,True),
                     'downstream':_number(downstream,0,10000000,True)},('bash','Rscript','ParaFly'))


def prepare_network(run_id: str, expression: str, genotype: str, significant_pairs: str,
                    gene_names: str, gene_positions: str, container: str = '', bootstraps: int = 100,
                    markers_per_gene: int = 3, correlation: float = 0.3, memory_gb: int = 16,
                    queue: str = 'standby', walltime_hours: int = 4, cores: int = 128,
                    computing: str = 'slurm', stage: int = 1) -> dict:
    """Stage 5 PREPARE ONLY: validate SLURM or cloud (stage 1/2) network configuration; never submit or execute jobs."""
    if computing not in ('slurm','cloud'):
        raise ValueError('computing must be slurm or cloud.')
    _number(stage,1,2,True)
    return _execute(run_id,'network',['bash','{work}/signet','-n'],
                    {'net.gexp.data':_input(expression),'net.geno.data':_input(genotype),
                     'sig.pair':_input(significant_pairs),'net.genename':_input(gene_names),
                     'net.genepos':_input(gene_positions),
                     'sif':_input(container) if computing=='slurm' or container else str(_run(run_id)/'work/missing/sif'),
                     'nboots':_number(bootstraps,1,10000,True),'ncis':_number(markers_per_gene,1,100,True),
                     'cor':_number(correlation,0,1),'memory':_number(memory_gb,1,1024,True),
                     'queue':_name(queue),'walltime':_number(walltime_hours,1,168,True)+':00:00',
                     'ncores':_number(cores,1,1024,True),'computing':computing,'stage':str(stage)},
                    ('bash','Rscript','singularity','sbatch','srun') if computing=='slurm' else ('bash','Rscript'),prepare=True)


def submit_network(run_id: str, expression: str, genotype: str, significant_pairs: str,
                   gene_names: str, gene_positions: str, bootstraps: int,
                   markers_per_gene: int, correlation: float) -> dict:
    """Submit Stage 5 to the existing local Docker VM / SLURM, asynchronously.

    Use a fresh configured run and confirmed scientific parameters; genotype must match
    significant-pair indices (normally Stage 4 merged eQTL data). Fixed runtime: official
    image, local queue, 4 cores, 4 GB. Never replay an uncertain submission; query status.
    Pinned official code supports three markers per gene; other values are rejected.
    """
    from network_runtime import submit
    from signet_runtime import image_path
    root = _run(run_id)
    _verify_source(root / 'work')
    for item in INVENTORY['support_files']:
        if item['path'].startswith('script/network/template.sub'):
            template = root / 'work' / item['path']
            if hashlib.sha256(template.read_bytes()).hexdigest() != item['sha256']:
                raise ValueError('Network scheduler template differs from the audited source.')
    if markers_per_gene != 3 or isinstance(markers_per_gene, bool):
        raise ValueError('Pinned official network code selects up to three markers; only markers_per_gene=3 is supported.')
    values = {'net.gexp.data': _input(expression), 'net.geno.data': _input(genotype),
              'sig.pair': _input(significant_pairs), 'net.genename': _input(gene_names),
              'net.genepos': _input(gene_positions), 'sif': image_path(),
              'nboots': _number(bootstraps, 1, 10000, True), 'ncis': '3',
              'cor': _number(correlation, 0, 1), 'computing': 'slurm', 'stage': '1',
              'queue': 'local', 'memory': '4', 'ncores': '4', 'walltime': '01:00:00',
              'interactive': 'F', 'forcerm': 'F', 'email': 'F'}
    if (root / 'network.json').exists() or any((root / 'work' / path).exists()
            for path in ('tmp/tmpn', 'data/network')):
        raise ValueError('Network was already attempted; query status, or configure a NEW run.')
    fd = os.open(root / '.active', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    try:
        _update(root, values)
        return submit(root, _settings(root))
    finally:
        (root / '.active').unlink()


def get_network_status(run_id: str) -> dict:
    """Query actual Stage 5 controller/jobs; collect and verify completed output. Never resubmit."""
    return _network_status(run_id)


def cancel_network(run_id: str) -> dict:
    """Request stop of this run's Stage 5 process and owned jobs, preserving inputs/results/logs.

    Cancellation is asynchronous; query get_network_status until confirmed cancelled.
    """
    return _network_status(run_id, cancel=True)


def _network_status(run_id, cancel=False):
    from network_runtime import status
    root = _run(run_id)
    if not (root / 'network.json').is_file():
        raise ValueError('No Stage 5 submission is recorded for this run.')
    fd = os.open(root / '.active', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    try:
        return status(root, cancel=cancel)
    finally:
        (root / '.active').unlink()


def prepare_visualization(run_id: str, frequencies: str, coefficients: str, gene_positions: str,
                          frequency: float = 1, top_networks: int = 3, taxonomy_id: int = 9606,
                          assembly: str = 'hg38', transcription_factors: str = '') -> dict:
    """Stage 6 PREPARE ONLY: online STRINGdb lookup and interactive Shiny require manual execution."""
    values = {'Afreq':_input(frequencies),'coef':_input(coefficients),'vis.genepos':_input(gene_positions),
              'freq':_number(frequency,0,1),'ntop':_number(top_networks,1,100,True),
              'id':_number(taxonomy_id,1,10000000,True),'assembly':_name(assembly)}
    if taxonomy_id != 9606 or transcription_factors:
        values['tf'] = _input(transcription_factors)
    return _execute(run_id,'visualization',['bash','{work}/signet','-v'],values,('bash','Rscript'),prepare=True)



def run_visualization(run_id: str, frequencies: str, coefficients: str, gene_positions: str,
                      frequency: float, top_networks: int, taxonomy_id: int = 9606,
                      assembly: str = 'hg38', transcription_factors: str = '') -> dict:
    """Execute Stage 6 official exports in the existing Docker VM, including online STRING annotation.

    Produces edge lists, PDFs, enrichment tables and interactive HTML; no persistent Shiny server.
    Use a fresh configured run, aligned network matrices and ordered gene positions.
    Frequency and subnetwork count must be chosen explicitly. Online services may fail;
    only verified_completed means checked technical exports, not scientific validity.
    """
    values = {'Afreq': _input(frequencies), 'coef': _input(coefficients),
              'vis.genepos': _input(gene_positions), 'freq': _number(frequency, 0, 1),
              'ntop': _number(top_networks, 1, 100, True),
              'id': _number(taxonomy_id, 1, 10000000, True), 'assembly': _name(assembly)}
    if taxonomy_id != 9606 or transcription_factors:
        values['tf'] = _input(transcription_factors)
    return _execute(run_id, 'visualization', ['bash', '{work}/signet', '-v'], values)


def run_pca(run_id: str) -> dict:
    """Stage 3 PCA only on existing matched/pruned intermediate genotype files in the isolated run."""
    root = _run(run_id)
    gtex = _settings(root)['cohort'] == 'GTEx'
    files = ('tmp/tmpa/Geno_all_prune.ped','tmp/tmpa/Geno_all_prune.pedsnp','tmp/tmpa/Geno_all_prune.pedind') if gtex else ('res/resa/signet_new.Geno','res/resa/signet_new.Geno.map','tmp/tmpg/clean_Genotype.fam','tmp/tmpg/geno_id')
    return _execute(run_id,'pca',['bash','{work}/script/adj/adj_pca_gtex.sh' if gtex else '{work}/script/adj/adj_pca.sh'],
                    dependencies=('bash','Rscript','smartpca.perl'),prerequisites=files,cwd='tmp/tmpa',
                    environment={'resa':_settings(root)['resa.gtex' if gtex else 'resa.tcga']})


def plot_pca(run_id: str) -> dict:
    """Stage 3 plot existing PCA eigenvectors/eigenvalues without recomputing the PCA."""
    return _execute(run_id,'plot_pca',['Rscript','{work}/script/adj/pca_vis.R'],dependencies=('Rscript',),
                    cwd='tmp/tmpa',prerequisites=('tmp/tmpa/Geno.pca.evec','tmp/tmpa/Geno.eval'))


def combine_covariates(run_id: str, expression_covariates: str, genotype_pcs: str = '',
                       additional_covariates: list[str] = None) -> dict:
    """Stage 3 combine covariate matrices and drop collinear rows; output inside run/res/covariates/."""
    argv = [sys.executable,'{work}/script/adj/combine_covariates.py',_input(expression_covariates),'signet','-o','{work}/res/covariates']
    if genotype_pcs:
        argv += ['--genotype_pcs',_input(genotype_pcs)]
    if additional_covariates:
        if not isinstance(additional_covariates, list) or len(additional_covariates)>20:
            raise ValueError('Expected at most 20 additional covariate files.')
        argv += ['--add_covariates',*[_input(path) for path in additional_covariates]]
    return _standalone(run_id,'combine_covariates',argv,('numpy','pandas'),'covariates')


def adjust_expression(run_id: str, expression_bed: str, covariates: str) -> dict:
    """Stage 3 standalone expression OLS residual adjustment; sample-column order must match covariates."""
    _validate_adjustment(expression_bed, covariates)
    return _standalone(run_id,'adjust_expression',[sys.executable,'{work}/script/adj/gexp_cov_adjust.py',
                        '--expr',_input(expression_bed),'--covf',_input(covariates),
                        '--prefix','{work}/res/adjusted/signet'],('numpy','pandas','statsmodels'),'adjusted')


def _validate_adjustment(expression, covariates):
    expression, covariates = _input(expression), _input(covariates)
    opener = gzip.open if expression.endswith('.gz') else open
    with opener(expression, 'rt') as handle:
        header = next(csv.reader(handle, delimiter='\t'), [])
    with open(covariates) as handle:
        cov_header = next(csv.reader(handle, delimiter='\t'), [])
    if len(header)<5 or header[3]!='gene_id' or not cov_header or cov_header[0]!='ID':
        raise ValueError('Expected expression BED header with gene_id in column 4, and covariate header starting ID.')
    if header[4:] != cov_header[1:] or len(set(header[4:])) != len(header[4:]):
        raise ValueError('Expression and covariate sample columns must match exactly in order, without duplicates.')


def normalize_expression(run_id: str, tpm: str, counts: str, annotation_gtf: str,
                         sample_lookup: str, vcf_chromosomes: str, sample_ids: str = '',
                         convert_tpm: bool = False, legacy_mode: bool = False,
                         tpm_threshold: float = 0.1, count_threshold: int = 6,
                         sample_fraction: float = 0.2, normalization: str = 'tmm') -> dict:
    """Stage 2 standalone GTEx expression BED normalization; upstream requires its older pandas/feather API."""
    if normalization not in ('tmm','qn') or type(convert_tpm) is not bool or type(legacy_mode) is not bool:
        raise ValueError('Use normalization=tmm/qn and boolean conversion/legacy flags.')
    argv = [sys.executable,'{work}/script/gexp_prep/eqtl_prepare_expression_igt2log.py',
            _input(tpm),_input(counts),_input(annotation_gtf),_input(sample_lookup),_input(vcf_chromosomes),
            'signet','-o','{work}/res/normalized','--tpm_threshold',_number(tpm_threshold,0,1e9),
            '--count_threshold',_number(count_threshold,0,100000000,True),
            '--sample_frac_threshold',_number(sample_fraction,0,1),'--normalization_method',normalization]
    if sample_ids:
        argv += ['--sample_id_list',_input(sample_ids)]
    if convert_tpm:
        argv.append('--convert_tpm')
    if legacy_mode:
        argv.append('--legacy_mode')
    return _standalone(run_id,'normalize_expression',argv,('numpy','pandas','scipy','feather'),'normalized',('bgzip','tabix'))


def _standalone(run_id, operation, argv, modules, output, dependencies=()):
    root = _run(run_id)
    (root / 'work/res' / output).mkdir(exist_ok=True)
    return _execute(run_id,operation,argv,modules=modules,dependencies=dependencies)


def get_visualization_workspace() -> dict:
    """Read the current session Stage 6 baseline, parameters and pending changes; no execution."""
    from stage6_workspace import get_visualization_workspace as read
    return read()


def propose_visualization_change(frequency: float = -1, top_networks: int = 0) -> dict:
    """Propose Stage 6 changes; execution requires the researcher to click Confirm & run.

    frequency: Requested threshold 0..1; -1 preserves the pending value, or baseline if no proposal.
    top_networks: Requested count 1..100; 0 preserves the pending value, or baseline if no proposal.
    Only change parameters explicitly requested. Never execute a proposal yourself.
    """
    from stage6_workspace import propose_visualization_change as propose
    return propose(frequency, top_networks)


SIGNET_TOOLS = [signet_catalog,configure_signet,get_signet_settings,genotype_tcga,genotype_gtex,
                expression_tcga,expression_gtex,adjust_tcga,adjust_gtex,cis_eqtl,prepare_network,
                submit_network,get_network_status,cancel_network,
                prepare_visualization,run_visualization,get_visualization_workspace,propose_visualization_change,run_pca,plot_pca,combine_covariates,adjust_expression,normalize_expression]


def dispatch_tool(name, arguments):
    """Validate the model's tool name, keyword arguments and primitive types before dispatch."""
    from tools import GENERAL_TOOLS
    functions = {fn.__name__:fn for fn in [*GENERAL_TOOLS,*SIGNET_TOOLS]}
    try:
        if name not in functions or not isinstance(arguments, dict):
            raise ValueError('Unsupported tool or argument object.')
        if name == 'run_visualization':
            from stage6_workspace import CHAT_CONTEXT
            if CHAT_CONTEXT.get() is not None:
                return {'status': 'awaiting_confirmation', 'executed': False,
                        'reason': 'Use propose_visualization_change. Only the UI confirmation endpoint can execute Stage 6.'}
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
