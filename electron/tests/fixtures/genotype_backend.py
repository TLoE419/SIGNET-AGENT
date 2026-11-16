"""Start the production desktop server with the existing local scheduler fixture."""

import json
import os
from pathlib import Path
import runpy
import sys
import tempfile

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO), str(REPO / 'tests')]
from test_signet_jobs import StepsTest


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
            'slurm': str(fixture.fake), 'inputs': inputs,
        }), encoding='utf-8')

        sys.argv = [str(server), *sys.argv[3:]]
        runpy.run_path(str(server), run_name='__main__')
    finally:
        fixture.doCleanups()


if __name__ == '__main__':
    main()
