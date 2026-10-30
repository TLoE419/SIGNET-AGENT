"""Prepare SIGNET's IMPUTE2 inputs for one study on HPC3; uploaded and run as a Slurm job.

Detects each input's format first and converts only when needed:
  ref   VCF or VCF.gz (chromosome "1" or "chr1") -> unphased .gen with the study's markers;
        an existing .gen is filtered the same way without conversion.
  gmap  "pos chr cM" (SHAPEIT4/Eagle) -> IMPUTE2 "position rate cM"; an IMPUTE2 map is copied.
The study copy keeps only markers whose position and alleles match the reference; the
original study files are never changed. Prints a JSON summary of counts only: no
genotypes, sample IDs or marker lists leave HPC3.

Standalone on purpose: the standard library only, and Python 3.6 syntax, because it
runs with the compute node's system python3.
"""
import argparse
from collections import Counter
import gzip
import json
import os
import shutil
import sys

GENOTYPE = {'0/0': '1 0 0', '0/1': '0 1 0', '1/0': '0 1 0', '1/1': '0 0 1'}
MISSING = '0 0 0'  # IMPUTE2 reads all-zero probabilities as a missing call.
LOW_MATCH = 0.2
# Plain meanings, so the summary explains itself to readers and to the assistant.
MEANINGS = {
    'allele_mismatch': 'The reference has this position, but with different letters (often the other DNA strand).',
    'not_biallelic_snv': 'The reference lists more than two letters, or an insertion/deletion, at this position.',
    'duplicate_position': 'The reference lists this position more than once; only the first was kept.',
    'not_in_reference': 'The reference has no record at this position.',
}


class PreparationError(Exception):
    """A problem the user can act on; reported without a traceback."""


def _open(path):
    with open(path, 'rb') as stream:
        compressed = stream.read(2) == b'\x1f\x8b'
    return gzip.open(path, 'rt') if compressed else open(path)


def _first_line(path):
    with _open(path) as stream:
        for line in stream:
            if line.strip():
                return line
    return ''


def _chromosome(name):
    return name[3:] if name.lower().startswith('chr') else name


def reference_format(path):
    line = _first_line(path)
    if line.startswith('##fileformat=VCF') or line.startswith('#CHROM'):
        return 'vcf'
    fields = line.split()
    if len(fields) > 5 and (len(fields) - 5) % 3 == 0:
        try:
            [float(value) for value in fields[5:]]
            return 'gen'
        except ValueError:
            pass
    return None


def genetic_map_format(path):
    header = [field.lower() for field in _first_line(path).split()]
    if header[:3] == ['pos', 'chr', 'cm']:
        return 'pos_chr_cm'
    if len(header) == 3 and header[0] == 'position':
        return 'impute2'
    return None


def read_study(ped, map_file):
    with open(map_file) as stream:
        markers = [line.split() for line in stream if line.strip()]
    if not markers:
        raise PreparationError('The study map file has no markers.')
    chromosomes = {_chromosome(row[0]) for row in markers}
    if len(chromosomes) != 1:
        raise PreparationError('Only one chromosome per study is supported for now; found ' + ', '.join(sorted(chromosomes)) + '.')
    positions = [int(row[3]) for row in markers]
    if len(set(positions)) != len(positions):
        raise PreparationError('The study map has repeated positions.')
    alleles = [set() for _ in markers]
    samples = 0
    with open(ped) as stream:
        for line in stream:
            row = line.split()
            if not row:
                continue
            if len(row) != 6 + 2 * len(markers):
                raise PreparationError('The study ped and map files do not describe the same markers.')
            samples += 1
            for i in range(len(markers)):
                alleles[i].update(set(row[6 + 2 * i:8 + 2 * i]) - {'0'})
    return chromosomes.pop(), markers, {pos: i for i, pos in enumerate(positions)}, alleles, samples


def _vcf_rows(path, chromosome, index, found, rejected, missing):
    """Yield (position, id, ref, alt, probabilities) for study positions; split lines lazily.

    `found` collects every study position the reference has, kept or not.
    """
    gt = None
    with _open(path) as stream:
        for line in stream:
            if line.startswith('#'):
                continue
            chrom, pos, rsid, ref, alt, rest = line.rstrip('\n').split('\t', 5)
            if _chromosome(chrom) != chromosome or int(pos) not in index:
                continue
            found.add(int(pos))
            if len(ref) != 1 or len(alt) != 1:
                rejected['not_biallelic_snv'] += 1
                continue
            fields = rest.split('\t')
            keys = fields[3].split(':')
            if 'GT' not in keys:
                raise PreparationError('The reference VCF has no GT (genotype) field.')
            gt = keys.index('GT')
            calls = []
            for call in fields[4:]:
                value = call.split(':')[gt].replace('|', '/')
                if value not in GENOTYPE:
                    missing['calls'] += 1
                calls.append(GENOTYPE.get(value, MISSING))
            yield int(pos), rsid, ref, alt, calls


def _gen_rows(path, chromosome, index, found, rejected, missing):
    with _open(path) as stream:
        for line in stream:
            fields = line.split()
            if not fields:
                continue
            pos = int(fields[2])
            if pos not in index:
                continue
            found.add(pos)
            if len(fields[3]) != 1 or len(fields[4]) != 1:
                rejected['not_biallelic_snv'] += 1
                continue
            values = fields[5:]
            yield pos, fields[1], fields[3], fields[4], [' '.join(values[i:i + 3]) for i in range(0, len(values), 3)]


def _write_genetic_map(source, kind, target, low, high):
    if kind == 'impute2':
        shutil.copyfile(source, target)  # Already IMPUTE2's format.
        return 'copied (already IMPUTE2 format)'
    with _open(source) as stream:
        next(stream)
        points = [(int(row[0]), float(row[2])) for row in (line.split() for line in stream) if row]
    if any(b[0] <= a[0] or b[1] < a[1] for a, b in zip(points, points[1:])):
        raise PreparationError('The genetic map positions are not increasing.')
    if not points or not points[0][0] <= low <= high <= points[-1][0]:
        raise PreparationError('The genetic map does not cover the study markers.')
    with open(target, 'w') as dest:
        dest.write('position COMBINED_rate(cM/Mb) Genetic_Map(cM)\n')
        for i, (pos, cm) in enumerate(points):
            rate = (points[i + 1][1] - cm) / (points[i + 1][0] - pos) * 1e6 if i + 1 < len(points) else 0
            dest.write('{} {:.12g} {:.12g}\n'.format(pos, rate, cm))
    return 'converted from pos/chr/cM'


def prepare(study_ped, study_map, reference, genetic_map, out):
    kinds = {'reference': reference_format(reference), 'genetic_map': genetic_map_format(genetic_map)}
    if kinds['reference'] is None:
        raise PreparationError('Unsupported reference format. Supported: VCF (.vcf or .vcf.gz) or IMPUTE2 .gen.')
    if kinds['genetic_map'] is None:
        raise PreparationError('Unsupported genetic map format. Supported: "pos chr cM" (SHAPEIT4/Eagle) or IMPUTE2 "position rate cM".')
    if os.path.exists(out):
        raise PreparationError('The output folder already exists; nothing was replaced.')
    chromosome, markers, index, alleles, samples = read_study(study_ped, study_map)
    partial = out + '.partial'
    shutil.rmtree(partial, ignore_errors=True)
    os.makedirs(os.path.join(partial, 'ref'))
    os.makedirs(os.path.join(partial, 'gmap'))
    rejected, missing, selected, found = Counter(), Counter(), set(), set()
    rows = (_vcf_rows if kinds['reference'] == 'vcf' else _gen_rows)(reference, chromosome, index, found, rejected, missing)
    with open(os.path.join(partial, 'ref', 'chr{}.gen'.format(chromosome)), 'w') as dest:
        for pos, rsid, ref, alt, calls in rows:
            if not alleles[index[pos]] <= {ref, alt}:
                rejected['allele_mismatch'] += 1
            elif pos in selected:
                rejected['duplicate_position'] += 1
            else:
                dest.write(' '.join(['chr{}_{}'.format(chromosome, pos), rsid, str(pos), ref, alt] + calls) + '\n')
                selected.add(pos)
    if len(found) < len(markers):
        rejected['not_in_reference'] = len(markers) - len(found)
    if not selected:
        shutil.rmtree(partial)
        raise PreparationError('No study marker matches the reference by position and alleles; '
                               'check that both use the same genome build.')
    chosen = [i for i, row in enumerate(markers) if int(row[3]) in selected]
    with open(os.path.join(partial, 'study.map'), 'w') as dest:
        dest.writelines('\t'.join(markers[i]) + '\n' for i in chosen)
    with open(study_ped) as source, open(os.path.join(partial, 'study.ped'), 'w') as dest:
        for line in source:
            row = line.split()
            if row:
                dest.write(' '.join(row[:6] + [a for i in chosen for a in row[6 + 2 * i:8 + 2 * i]]) + '\n')
    gmap_note = _write_genetic_map(genetic_map, kinds['genetic_map'], os.path.join(partial, 'gmap', 'chr{}.map'.format(chromosome)),
                                   min(selected), max(selected))
    rate = len(selected) / len(markers)
    summary = {'status': 'ok', 'chromosome': chromosome, 'formats': kinds, 'genetic_map': gmap_note,
               'study_samples': samples, 'study_markers': len(markers), 'matched_markers': len(selected),
               'match_rate': round(rate, 4), 'rejected': dict(rejected),
               'rejected_meanings': {reason: MEANINGS[reason] for reason in rejected},
               # Kept markers can still have reference people without a genotype (./.); IMPUTE2 treats them as missing.
               'reference_calls_without_genotype': missing['calls'],
               'warning': ('Only {:.0%} of study markers matched; the study and reference may use different genome builds.'.format(rate)
                           if rate < LOW_MATCH else None),
               'outputs': {'ref_prefix': os.path.join(out, 'ref', 'chr'), 'gmap_prefix': os.path.join(out, 'gmap', 'chr'),
                           'ped': os.path.join(out, 'study.ped'), 'map': os.path.join(out, 'study.map')},
               'scope': 'Counts only. The original study files were not changed.'}
    # Written last, so a summary file means every output is complete.
    with open(os.path.join(partial, 'summary.json'), 'w') as dest:
        json.dump(summary, dest, indent=2)
    os.rename(partial, out)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    for name in ('--study-ped', '--study-map', '--reference', '--genetic-map', '--out'):
        parser.add_argument(name, required=True)
    args = parser.parse_args()
    try:
        summary = prepare(args.study_ped, args.study_map, args.reference, args.genetic_map, args.out)
    except (PreparationError, OSError, ValueError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}))
        return 1
    # One line, so the app's 20-line log view always shows the whole summary.
    print(json.dumps(summary))
    return 0


if __name__ == '__main__':
    sys.exit(main())
