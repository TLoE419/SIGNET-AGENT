"""Check saved source identities without selecting new dataset/reference files."""
import json
import os
import stat
import sys


result = {'files': [], 'issues': []}
for source in json.loads(sys.argv[1]):
    try:
        path = source['path']
        info = os.stat(path)
        identity = [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]
        if os.path.realpath(path) != path or not stat.S_ISREG(info.st_mode) or not os.access(path, os.R_OK) or not info.st_size:
            raise OSError()
        if source.get('identity') is not None and identity != source['identity']:
            result['issues'].append('The original ' + source['role'] + ' source changed; this retry will not replace the saved study or reference.')
        result['files'].append({'role': source['role'], 'path': path, 'identity': identity})
    except (OSError, ValueError, KeyError, TypeError):
        result['issues'].append('An original study or reference file is missing or unreadable; restore it before retrying this run.')
print('@@retry_sources\t' + json.dumps(result, separators=(',', ':')))
