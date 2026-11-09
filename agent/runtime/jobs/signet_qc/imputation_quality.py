"""Summarize IMPUTE2's native variant-level evidence without applying thresholds."""

import math

from .plink_reports import distribution, table_rows


def summarize(expected_outputs):
    info_files = [path.with_name(path.name + '_info') for path in expected_outputs]
    present = [path for path in info_files if path.is_file()]
    coverage = {'expected_chunks': len(info_files), 'reported_chunks': len(present)}
    if not present:
        return {'status': 'unavailable', **coverage}

    metrics = {'info': [], 'certainty': [], 'concord_type1': []}
    try:
        for path in present:
            for row in table_rows(path, 'info', 'certainty', optional=('concord_type1',)):
                for name, value in zip(metrics, row):
                    if value is None:
                        continue
                    number = float(value)
                    # INFO can be negative. Exactly -1 denotes an undefined metric.
                    if number == -1:
                        continue
                    if not math.isfinite(number) or number > 1 or (name != 'info' and number < 0):
                        raise ValueError('Invalid IMPUTE2 quality metric.')
                    metrics[name].append(number)
    except (OSError, ValueError):
        return {'status': 'unverified', **coverage}

    return {
        'status': 'measured' if len(present) == len(info_files) else 'partial',
        **coverage,
        **{name: distribution(values) for name, values in metrics.items()},
    }
