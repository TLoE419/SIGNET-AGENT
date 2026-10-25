"""Run pinned, unmodified signet -g in the existing VM, isolated from chat and earlier runs."""
import argparse
import io
import json
from pathlib import Path
from dotenv import load_dotenv
import shutil
import sys
import tarfile
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import signet_tools as st
import signet_runtime as vm


def run(dataset, run_id, seconds):
    dataset=dataset.resolve(); assert dataset.is_relative_to(st.PROJECT/'data')
    created=st.configure_signet(run_id,cohort='TCGA',nchr=1,ncores=1)
    if created.get('status')!='created':raise ValueError(created)
    root=st._run(run_id);remote='/tmp/signet-agent-genotype/'+run_id
    values={'ped.file':str(dataset/'example.ped'),'map.file':str(dataset/'example.map'),
            'ref':str(dataset/'ref/chr'),'gmap':str(dataset/'gmap/chr'),
            'restrict.tcga.geno':'1','int':'1000000'}
    for key in ('ped.file','map.file'):st._input(values[key])
    for folder,name in [('ref','chr1.gen'),('gmap','chr1.map')]:st._input(str(dataset/folder/name))
    st._update(root,values);shutil.copyfile(root/'work/config.ini',root/'genotype_tcga.config.ini')
    settings=st._settings(root)
    original=vm.bundle(root,settings,remote,input_keys=('ped.file','map.file'))
    payload=io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(original),mode='r:gz') as src,tarfile.open(fileobj=payload,mode='w:gz') as dst:
        for item in src.getmembers():
            content=src.extractfile(item).read() if item.isfile() else None
            if item.name=='work/config.ini':
                content=content.replace(values['ref'].encode(),(remote+'/reference/ref/chr').encode()).replace(values['gmap'].encode(),(remote+'/reference/gmap/chr').encode());item.size=len(content)
            dst.addfile(item,io.BytesIO(content) if content is not None else None)
        dst.add(dataset/'ref/chr1.gen',arcname='reference/ref/chr1.gen')
        dst.add(dataset/'gmap/chr1.map',arcname='reference/gmap/chr1.map')
    uploaded=vm.remote('umask 077; mkdir -p /tmp/signet-agent-genotype && mkdir '+remote+' && tar xzf - -C '+remote,input=payload.getvalue(),capture_output=True,timeout=60)
    if uploaded.returncode:raise RuntimeError(uploaded.stderr.decode()[-500:])
    started=time.time()
    command=(f'cd {remote}/work && timeout -k 5 {seconds}s singularity exec --cleanenv --no-home '
             f'--env OPENBLAS_NUM_THREADS=1,OMP_NUM_THREADS=1 --bind {remote}:{remote} {vm.image_path()} bash ./signet -g')
    record={'status':'starting','executed':True,'operation':'genotype_tcga','runtime':'existing-docker-vm',
            'dataset':str(dataset),'remote_directory':remote,'command':command,'revision':st.INVENTORY['revision']}
    (root/'genotype_tcga.json').write_text(json.dumps(record,indent=2)+'\n')
    with (root/'logs/genotype_tcga.stdout').open('xb') as out,(root/'logs/genotype_tcga.stderr').open('xb') as err:
        result=vm.remote(command,stdout=out,stderr=err,timeout=seconds+20)
    fetched=vm.remote('cd '+remote+' && tar czf - work/res work/tmp work/data',capture_output=True,timeout=90)
    outputs=vm.restore_outputs(root,fetched.stdout) if fetched.returncode==0 else []
    matrix=root/'work/res/resg/signet_Geno';ids=root/'work/res/resg/signet_Genotype.sampleID'
    complete=root/'work/tmp/tmpg/impute_params.txt.completed';jobs=root/'work/tmp/tmpg/impute_params.txt'
    counts={}
    if matrix.is_file() and ids.is_file():
        rows=[line.split() for line in matrix.read_text().splitlines() if line.strip()]
        names=[line.split() for line in ids.read_text().splitlines() if line.strip()]
        counts={'samples':len(rows),'sample_ids':len(names),'markers':len(rows[0]) if rows else 0,
                'rectangular':bool(rows) and all(len(row)==len(rows[0]) for row in rows),
                'finite_dosages':bool(rows) and all(value in ('0','1','2') for row in rows for value in row)}
    lines=lambda p:len(p.read_text().splitlines()) if p.is_file() else 0
    counts.update(imputation_jobs=lines(jobs),completed_jobs=lines(complete))
    ok=(result.returncode==0 and counts.get('samples',0)>0 and counts.get('markers',0)>0
        and counts['samples']==counts['sample_ids'] and counts['rectangular'] and counts['finite_dosages']
        and counts['imputation_jobs']>0 and counts['imputation_jobs']==counts['completed_jobs'])
    record.update(status='verified_completed' if ok else 'timed_out' if result.returncode==124 else 'failed_validation',returncode=result.returncode,
                  duration_seconds=round(time.time()-started,2),output_files=outputs,validation=counts,
                  scientific_validation=False,scope='Only matching original example markers from the prepared reference dataset.')
    (root/'genotype_tcga.json').write_text(json.dumps(record,indent=2)+'\n')
    print(json.dumps(record,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('dataset',type=Path);p.add_argument('run_id');p.add_argument('--seconds',type=int,default=180)
    a=p.parse_args();load_dotenv(st.PROJECT / '.env');run(a.dataset,a.run_id,a.seconds)
