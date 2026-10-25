"""Convert public chr1 VCF calls to SIGNET's unphased GEN contract; preserve study genotypes."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path


def prepare(vcf, out, study, genetic_map):
    markers = [row.split() for row in (study/'example.map').read_text().splitlines()]
    assert len({int(row[3]) for row in markers}) == len(markers)
    index = {int(row[3]): i for i, row in enumerate(markers)}
    allele_sets = [set() for _ in markers]
    samples = 0
    with (study/'example.ped').open() as stream:
        for line in stream:
            row = line.split(); assert len(row) == 6 + 2*len(markers)
            samples += 1
            for i in range(len(markers)):
                allele_sets[i].update(set(row[6+2*i:8+2*i]) - {'0'})
    out.mkdir(parents=True, exist_ok=False)
    (out/'ref').mkdir(); (out/'gmap').mkdir()
    probabilities = {'0|0':'1 0 0','0/0':'1 0 0','0|1':'0 1 0','1|0':'0 1 0',
                     '0/1':'0 1 0','1/0':'0 1 0','1|1':'0 0 1','1/1':'0 0 1'}
    selected = set(); rejected = Counter(); reference_samples = []
    with vcf.open() as stream, (out/'ref/chr1.gen').open('x') as dest:
        for line in stream:
            if line.startswith('#CHROM'):
                reference_samples = line.rstrip().split('\t')[9:]; continue
            if line.startswith('#'): continue
            row = line.rstrip().split('\t'); pos = int(row[1])
            if pos not in index or len(row[3]) != 1 or len(row[4]) != 1: continue
            i = index[pos]
            if not allele_sets[i] <= {row[3], row[4]}:
                rejected['allele_mismatch'] += 1; continue
            if pos in selected: rejected['duplicate_position'] += 1; continue
            assert row[0] == '1' and len(row)-9 == len(reference_samples)
            gt_index = row[8].split(':').index('GT')
            calls = [probabilities[x.split(':')[gt_index]] for x in row[9:]]
            dest.write(' '.join([f'chr1_{pos}',row[2],str(pos),row[3],row[4],*calls])+'\n')
            selected.add(pos)
    assert selected, 'No position AND allele-compatible markers; do not run imputation.'
    (out/'ref/chr1.samples.txt').write_text('\n'.join(reference_samples)+'\n')
    chosen = [i for i, row in enumerate(markers) if int(row[3]) in selected]
    (out/'example.map').write_text(''.join('\t'.join(markers[i])+'\n' for i in chosen))
    with (study/'example.ped').open() as src, (out/'example.ped').open('x') as dest:
        for line in src:
            row = line.split()
            dest.write(' '.join(row[:6]+[a for i in chosen for a in row[6+2*i:8+2*i]])+'\n')
    with gzip.open(genetic_map,'rt') as src:
        next(src); gm = [(int(r[0]),float(r[2])) for r in (line.split() for line in src)]
    assert all(b[0]>a[0] and b[1]>=a[1] for a,b in zip(gm,gm[1:]))
    with (out/'gmap/chr1.map').open('x') as dest:
        dest.write('position COMBINED_rate(cM/Mb) Genetic_Map(cM)\n')
        for i,(pos,cm) in enumerate(gm):
            rate=(gm[i+1][1]-cm)/(gm[i+1][0]-pos)*1e6 if i+1<len(gm) else 0
            dest.write(f'{pos} {rate:.12g} {cm:.12g}\n')
    assert gm[0][0]<=min(selected)<=max(selected)<=gm[-1][0]
    metadata = {'reference_build':'GRCh38','reference_samples':len(reference_samples),'study_samples':samples,
                'original_study_markers':len(markers),'matched_position_and_allele_markers':len(selected),
                'rejected':dict(rejected),'selected_range':[min(selected),max(selected)],
                'study_changes':'Only select directly matching positions/alleles. No genotype, sample or coordinate edits.',
                'reference_conversion':'Phased GT -> unphased deterministic AA/AB/BB GEN probabilities; no imputation in preparation.',
                'genetic_map_conversion':'pos,chr,cM -> position, forward difference rate in cM/Mb, cM.',
                'source_vcf':str(vcf),'source_vcf_sha256':hashlib.sha256(vcf.read_bytes()).hexdigest(),
                'original_ped_sha256':hashlib.sha256((study/'example.ped').read_bytes()).hexdigest(),
                'original_map_sha256':hashlib.sha256((study/'example.map').read_bytes()).hexdigest(),
                'scientific_compatibility':'Position/allele checks passed; the caller must independently verify study/reference genome builds.'}
    (out/'provenance.json').write_text(json.dumps(metadata,indent=2)+'\n')
    print(json.dumps(metadata,indent=2))


if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('vcf',type=Path);parser.add_argument('out',type=Path)
    parser.add_argument('--study', type=Path, required=True, help='Directory containing your example.ped and example.map')
    parser.add_argument('--genetic-map', type=Path, required=True, help='Your gzip genetic map')
    args=parser.parse_args();prepare(args.vcf,args.out,args.study,args.genetic_map)
