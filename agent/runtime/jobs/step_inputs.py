"""Read-only expression annotation preflight, usable with HPC3 system Python."""
def gtf_problem(path):
    with open(path, 'rb') as stream:
        if stream.read(2) == b'\x1f\x8b':
            return 'SIGNET needs an uncompressed GTF. Decompress this file first.'
    with open(path, errors='replace') as stream:
        for number, line in enumerate(stream):
            if number >= 5000:
                break
            if line.startswith('#') or not line.strip():
                continue
            fields = line.rstrip('\n').split('\t')
            if len(fields) != 9:
                return 'This is not a GTF file: rows need 9 tab-separated columns.'
            if fields[2] == 'gene':
                if 'transcript_type' in fields[8]:
                    return None
                return 'This GTF is not collapsed: gene rows have no transcript_type, so signet -t would find 0 genes.'
    return 'This GTF has no gene rows near its start.'

