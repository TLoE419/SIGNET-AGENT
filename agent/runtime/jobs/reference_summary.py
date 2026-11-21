"""Public reference-preparation provenance: fixed enums and counts, never source paths or IDs."""
import json
import math
import sys


def safe_preparation(value):
    if not isinstance(value, dict):
        return {}
    result = {}
    if value.get('status') == 'ok':
        result['status'] = 'ok'
    chromosome = value.get('chromosome')
    if str(chromosome) in [str(number) for number in range(1, 23)]:
        result['chromosome'] = str(chromosome)
    for key in ('study_samples', 'study_markers', 'matched_markers', 'reference_calls_without_genotype'):
        if type(value.get(key)) is int and value[key] >= 0:
            result[key] = value[key]
    rate = value.get('match_rate')
    if type(rate) in (float, int) and math.isfinite(rate) and 0 <= rate <= 1:
        result['match_rate'] = rate
    formats = value.get('formats')
    if isinstance(formats, dict):
        allowed = {'reference': ('vcf', 'gen'), 'genetic_map': ('pos_chr_cm', 'impute2')}
        result['formats'] = {key: formats[key] for key, values in allowed.items() if formats.get(key) in values}
    rejected = value.get('rejected')
    if isinstance(rejected, dict):
        result['rejected'] = {key: rejected[key] for key in
                              ('allele_mismatch', 'not_biallelic_snv', 'duplicate_position', 'not_in_reference')
                              if type(rejected.get(key)) is int and rejected[key] >= 0}
    return result


if __name__ == '__main__':
    with open(sys.argv[1]) as stream:
        data = stream.read(1024 * 1024 + 1)
    if len(data) <= 1024 * 1024:
        print(json.dumps(safe_preparation(json.loads(data))))
