"""Start the production desktop server with the existing local scheduler fixture."""

import json
import os
from pathlib import Path
import runpy
import sys
import tempfile

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO), str(REPO / 'tests')]
from test_signet_jobs import EXAMPLE_EXPRESSION_PATH, StepsTest


def main():
    server = REPO / 'electron/main/backend/server.py'
    if sys.argv[1:3] != ['-u', str(server)]:
        raise ValueError('Expected the desktop backend command.')
    metadata = Path(os.environ['SIGNET_GENOTYPE_TEST_METADATA'])
    tempfile.tempdir = str(metadata.parent)
    fixture = StepsTest()
    try:
        fixture.setUp()
        inputs = fixture.genotype_inputs()
        expression = fixture.hpc / 'ws/signet' / EXAMPLE_EXPRESSION_PATH
        expression.parent.mkdir(parents=True, exist_ok=True)
        expression.write_text('gene_id\tS1\tS2\tS3\tS4\nENSG1\t1\t3\t5\t7\nENSG2\t2\t4\t6\t8\nENSG3\t2\t4\t6\t8\n')
        annotation = fixture.hpc / 'ws/refdata/gencode.v22.genes.gtf'
        annotation.write_text('chr1\tGENCODE\tgene\t100\t200\t.\t+\t.\tgene_id "ENSG1";\n')
        expression_inputs = {'gexp.file': str(expression), 'pmap.file': str(annotation)}
        clinical = fixture.hpc / 'ws/refdata/official-demo-chr1-restart-clinical.tsv'
        clinical.write_text('submitter_id\trace\tgender\n'
                            'TCGA-XX-A001\tasian\tfemale\n'
                            'TCGA-XX-A002\tblack or african american\tmale\n'
                            'TCGA-XX-A003\twhite\tfemale\n'
                            'TCGA-XX-A004\twhite\tmale\n')
        fixture.slurm(squeue='PENDING')
        sbatch = fixture.fake / 'bin/sbatch'
        first, body = sbatch.read_text().split('\n', 1)
        sbatch.write_text(first + '\nprintf "submitted\\n" >> "$FAKE/sbatch_calls"\n' + body)

        dataset_path = fixture.project / 'data/datasets/example-chr1.json'
        dataset_path.parent.mkdir()
        dataset_path.write_text(json.dumps({
            'id': 'example-chr1',
            'name': ['第 1 號染色體範例', 'Chromosome 1 example'],
            'inputs': {'genotype': [inputs['ped.file'], inputs['map.file']], 'expression': [], 'clinical': []},
        }), encoding='utf-8')
        metadata.write_text(json.dumps({
            'project': str(fixture.project), 'remote': fixture.config['workRoot'],
            'slurm': str(fixture.fake), 'inputs': inputs, 'expression_inputs': expression_inputs,
            'adjust_inputs': {'cli.file': str(clinical)},
        }), encoding='utf-8')

        sys.argv = [str(server), *sys.argv[3:]]
        runpy.run_path(str(server), run_name='__main__')
    finally:
        fixture.doCleanups()


if __name__ == '__main__':
    main()
