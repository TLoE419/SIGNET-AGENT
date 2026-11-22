"""Production workspace APIs over a local scheduler and controlled science tools."""

import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO), str(REPO / 'tests')]
from test_signet_jobs import StepsTest
from agent.runtime import signet_jobs
import agent.runtime.ssh_transport as transport
import agent.tools.signet as signet


def dataset(root, identifier, prefix, chromosome):
    root.mkdir(parents=True)
    patients = ['TCGA-{}-{}00{}'.format(prefix, prefix[0], index) for index in range(1, 7)]
    ped, mapping, expression, clinical = [root / name for name in ('study.ped', 'study.map', 'expression.txt', 'clinical.tsv')]
    ped.write_text(''.join('{0}-NT {0}-NT 0 0 {1} -9 A A C T G G\n'.format(patient, index % 2 + 1)
                           for index, patient in enumerate(patients)))
    mapping.write_text(''.join('{} rs{} 0 {}\n'.format(chromosome, index, index * 101) for index in range(1, 4)))
    rows = [' '.join(['Ensembl_ID'] + [patient + '-01A' for patient in patients])]
    rows.extend('ENSG0000010000{}.1 '.format(gene) + ' '.join(str(20 + gene / 10 + sample / 100) for sample in range(6))
                for gene in range(1, 5))
    expression.write_text('\n'.join(rows + [' '.join(['0'] * 7)] * 5) + '\n')
    clinical.write_text('submitter_id\trace\tgender\n' + ''.join(
        '{}\t{}\t{}\n'.format(patient, ['asian', 'black or african american', 'white'][index // 2],
                              ['female', 'male'][index % 2]) for index, patient in enumerate(patients)))
    return {'id': identifier, 'name': [identifier, identifier], 'folder': str(root),
            'inputs': {'genotype': [str(ped), str(mapping)], 'expression': [str(expression)], 'clinical': [str(clinical)]}}, patients


def archived_run(project, record):
    run_id = 'custom-history-b'
    root = project / 'data/stage6-results' / run_id
    root.mkdir(parents=True)
    history = {'run_id': run_id, 'dataset_id': record['id'], 'name': ['資料乙完成分析', 'Dataset B completed analysis'],
               'inputs': record['inputs']}
    (root / 'history.json').write_text(json.dumps(history))
    jobs = {name: {'state': 'completed', 'finished_at': '2026-11-17T01:05:00-0800',
                   'settings': {'mind': '0.1'} if name == 'genotype' else {'restrict.tcga': '2'} if name == 'expression'
                   else {'alpha.cis': '0.05'} if name == 'cis' else {'nboots': '2'} if name == 'network'
                   else {'freq': '0.45', 'ntop': '1'}, 'resources': {'cpus': 2, 'mem_gb': 8}}
            for name in ('genotype', 'expression', 'cis', 'network', 'visualize')}
    jobs['adjust'] = {'state': 'completed', 'options': {'npc': 2}, 'finished_at': '2026-11-17T01:04:00-0800'}
    (root / 'verification.json').write_text(json.dumps({'run': run_id, 'jobs': jobs,
        'graph': {'connections': 3, 'genes': 3, 'subnetworks': 1, 'displayed': 1}}))
    (root / 'signet_edgelist_0.45.txt').write_text('source_gene_symbol,target_gene_symbol,frequency,coefficient\n'
        'MEGF6,GENE1,0.5,0.2\nGENE1,MEGF6,1,-0.4\nGENE1,OTHER,0.5,0.1\n')
    (root / 'stage3.json').write_text(json.dumps({'run_id': run_id, 'npc': 2,
        'matching': {'genotype': 6, 'expression': 6, 'matched': 6, 'retained': 6, 'excluded': 0, 'variants': 3, 'genes': 3},
        'pca': {'points': [[index, index / 2] for index in range(6)], 'variance_explained': [60, 30], 'source': 'retained_genotype'},
        'comparison': {'before_sd': 1, 'covariates_sd': .8, 'after_sd': .5}}))
    (root / 'stages.json').write_text(json.dumps({'run_id': run_id, 'stages': {
        '1': {'samples': 6, 'variants': 3, 'nonzero_bins': [0, 0, 0, 0, 0, 3], 'genotype_codes': [6, 6, 6]},
        '2': {'samples': 6, 'genes': 3, 'histogram': [{'lower': 0, 'upper': 10, 'count': 18}],
              'gene_summary': [{'gene': 'MEGF6', 'min': 1, 'median': 2, 'max': 3}]},
        '4': {'genes': 1, 'counts': {'common': 1, 'low': 0, 'rare': 0},
              'pairs': [{'gene': 'MEGF6', 'variant': '1', 'category': 'common', 'p_value': .01}]},
        '5': {'genes': 3, 'frequencies': [{'frequency': .5, 'count': 2}, {'frequency': 1, 'count': 1}],
              'edges': [{'source': 'MEGF6', 'target': 'GENE1', 'frequency': .5}]}}}))
    return run_id


def install_tools(fixture):
    executable = fixture.fake / 'bin/python3'
    executable.write_text('#!/bin/sh\nexec ' + repr(sys.executable) + ' "$@"\n')
    executable.chmod(0o700)
    # The production job uses GNU sed/date; these two narrow test shims keep the
    # actual batch wrapper portable to macOS without running scientific tools.
    sed = fixture.fake / 'bin/sed'
    sed.write_text('#!' + sys.executable + '\n' + '''import pathlib,re,sys,subprocess
args=sys.argv[1:]
if '-i' not in args:
    raise SystemExit(subprocess.call(['/usr/bin/sed',*args]))
path=pathlib.Path(args[-1]);text=path.read_text();expressions=[];index=0
while index<len(args)-1:
    if args[index]=='-e': expressions.append(args[index+1]);index+=2
    elif args[index]=='-i': index+=1
    else: expressions.append(args[index]);index+=1
for expression in expressions:
    delimiter=expression[1];parts=expression.split(delimiter)
    if expression[0]!='s' or len(parts)<4: raise SystemExit('Unsupported fixture sed')
    text=re.sub(parts[1],lambda _match:parts[2],text,flags=re.MULTILINE)
path.write_text(text)
''')
    sed.chmod(0o700)
    date = fixture.fake / 'bin/date'
    date.write_text('#!/bin/sh\nif [ "$1" = -Iseconds ]; then echo 2026-11-17T02:00:00; else exec /bin/date "$@"; fi\n')
    date.chmod(0o700)
    executor = fixture.fake / 'bin/apptainer'
    executor.write_text('#!' + sys.executable + '\n' + '''import os,pathlib,sys
root=pathlib.Path.cwd().resolve()
if not root.is_relative_to(pathlib.Path(os.environ['SIGNET_CUSTOM_REMOTE']).resolve()): raise SystemExit('Outside fixture run')
flag=next((value for value in sys.argv if value in ('-g','-t','-a')),None)
if flag is None: raise SystemExit('Only controlled SIGNET fixture steps are supported')
def write(name,value):
    target=root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(value)
def setting(key):
    for line in (root/'config.ini').read_text().splitlines():
        if line.partition('=')[0].strip()==key:return line.partition('=')[2].strip()
    raise ValueError('Missing fixture setting '+key)
if flag=='-g':
    ids=[line.split()[1] for line in pathlib.Path(setting('ped.file')).read_text().splitlines() if line.strip()]
    write('res/resg/signet_Geno','0 1 2\\n'*len(ids));write('res/resg/signet_Genotype.sampleID','\\n'.join(ids)+'\\n')
    write('tmp/tmpg/impute/impute_Genotype.sizes','6 samples, 3 variants\\n')
    write('tmp/tmpg/clean_Genotype.fam',''.join(value+' '+value+' 0 0 1 -9\\n' for value in ids))
else:
    ids=(root/'res/resg/signet_Genotype.sampleID').read_text().splitlines()
    matrix=''.join(' '.join(str(index+gene+1) for gene in range(4))+'\\n' for index in range(len(ids)))
    if flag=='-t':
        write('res/rest/signet_gexp',matrix);write('res/rest/signet_gexpID','\\n'.join(value[:12]+'-01A' for value in ids)+'\\n')
        write('res/rest/signet_gene_name','GENE1\\nMEGF6\\nOTHER\\nGENE4\\n')
        write('res/rest/signet_gene_pos',''.join(name+' chr2 '+str(index*100+100)+' '+str(index*100+150)+'\\n' for index,name in enumerate(['GENE1','MEGF6','OTHER','GENE4'])))
    else:
        adjusted=''.join(' '.join(str((index-2)*.5+gene/10) for gene in range(4))+'\\n' for index in range(len(ids)))
        for name,value in {'signet_matched.gexp':matrix,'signet_new.Geno':'0 1 2\\n'*len(ids),
            'signet_new.Geno.map':'2 rs1 0 101 A G\\n2 rs2 0 202 C T\\n2 rs3 0 303 G T\\n','signet_new.Geno.maf':'.1\\n.2\\n.3\\n',
            'signet_gexp.data':adjusted,'signet_gexp_rmpc.data':adjusted,'signet_geno.data':'0 1 2\\n'*len(ids)}.items():write('res/resa/'+name,value)
        write('tmp/tmpg/geno_id','\\n'.join(ids)+'\\n')
        write('tmp/tmpa/Geno.pca.evec','#eigvals: 6 3 1\\n'+''.join(value[:12]+' '+str(index-2)+' '+str(index/2)+' 0\\n' for index,value in enumerate(ids)))
        write('tmp/tmpa/Geno.eval','6\\n3\\n1\\n')
print('Controlled scientific fixture completed '+flag)
''')
    executor.chmod(0o700)


def main():
    server = REPO / 'electron/main/backend/server.py'
    if sys.argv[1:3] != ['-u', str(server)]:
        raise ValueError('Expected the desktop backend command.')
    metadata = Path(os.environ['SIGNET_CUSTOM_TEST_METADATA'])
    tempfile.tempdir = str(metadata.parent)
    fixture = StepsTest()
    downloaded_steps = signet_jobs.DOWNLOADED_STEPS
    try:
        fixture.setUp()
        signet_jobs.DOWNLOADED_STEPS = downloaded_steps
        fixture.config['revision'] = signet.INVENTORY['revision']
        os.environ['SIGNET_DATASETS_STATE_FILE'] = str(fixture.project / 'data/workspace-datasets.json')
        os.environ['SIGNET_CUSTOM_REMOTE'] = fixture.config['workRoot']
        patcher = patch.object(transport, 'setup_environment', side_effect=lambda: dict(fixture.config))
        patcher.start();fixture.addCleanup(patcher.stop)
        first, patients = dataset(fixture.hpc / 'cohorts/a', 'custom-cohort-a', 'AA', 2)
        second, _ = dataset(fixture.hpc / 'cohorts/b', 'custom-cohort-b', 'BB', 2)
        catalog = fixture.project / 'data/datasets';catalog.mkdir()
        for record in (first, second):
            (catalog / (record['id'] + '.json')).write_text(json.dumps(record))
        archived = archived_run(fixture.project, second)
        refdata = fixture.hpc / 'ws/refdata'
        corrected_clinical = refdata / 'corrected-clinical.tsv'
        original_clinical = Path(first['inputs']['clinical'][0])
        corrected_clinical.write_text(original_clinical.read_text())
        # A readable but malformed future input must not force genotype/expression reruns.
        original_clinical.write_text('\n'.join('\t'.join(line.split('\t')[:2])
            for line in original_clinical.read_text().splitlines()) + '\n')
        reference, genetic_map, annotation = refdata / 'custom-reference.vcf', refdata / 'custom-map.txt', refdata / 'custom-annotation.gtf'
        reference.write_text('##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tR1\tR2\n' + ''.join(
            '2\t{}\trs{}\t{}\t{}\t.\tPASS\t.\tGT\t0/0\t0/1\n'.format(index*101,index,*alleles)
            for index,alleles in enumerate((('A','G'),('C','T'),('G','T')),1)))
        genetic_map.write_text('pos chr cM\n0 2 0\n1000 2 1\n')
        annotation.write_text(''.join('chr2\tGENCODE\tgene\t{}\t{}\t.\t+\t.\tgene_id "ENSG0000010000{}.1"; gene_name "GENE{}"; transcript_type "protein_coding";\n'.format(index*100,index*100+50,index,index) for index in range(1,5)))
        (refdata / 'selected.tsv').write_text('ref\t{}\ngmap\t{}\ngtf\t{}\n'.format(reference,genetic_map,annotation))
        install_tools(fixture)
        batch = fixture.fake / 'bin/sbatch'
        batch.write_text('#!/bin/bash\nprintf "submitted\\n" >> "$FAKE/sbatch_calls"\n'+batch.read_text().split('\n',1)[1])
        fixture.slurm(squeue='PENDING')
        metadata.write_text(json.dumps({'project':str(fixture.project),'remote':fixture.config['workRoot'],'slurm':str(fixture.fake),
            'datasets':[first,second],'patients':patients,'archived':archived,'annotation':str(annotation),
            'reference':str(reference),'genetic_map':str(genetic_map),'python':sys.executable,
            'corrected_clinical':str(corrected_clinical)}))
        sys.argv=[str(server),*sys.argv[3:]]
        runpy.run_path(str(server),run_name='__main__')
    finally:
        fixture.doCleanups()


if __name__ == '__main__':
    main()
