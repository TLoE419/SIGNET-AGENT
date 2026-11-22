"""Disposable completed outputs for native delivery QA; transport is forbidden."""
import json
from pathlib import Path
import sys
from unittest.mock import Mock, patch

sys.path[:0] = [str(Path(__file__).resolve().parents[3]), str(Path(__file__).resolve().parents[3] / 'tests')]
from agent.app.chat_ui import ChatServer
import test_workspace_visualization as fixtures


fixture = fixtures.WorkspaceVisualizationTest()
fixture.setUp()
try:
    settings = {'freq': '0.45', 'ntop': '2'}
    fixture.snapshot['settings'] = settings
    fixture.job['settings'] = settings
    for number, names in ((1, 'MEGF6\nB\nC\n'), (2, 'D\nE\n')):
        stem = f'signet_top{number}_freq0.45'
        dependencies = fixture.directory / (stem + '_files')
        dependencies.mkdir()
        (dependencies / 'widget.js').write_text('''window.addEventListener('DOMContentLoaded',()=>{
document.body.dataset.ready='yes';
try{parent.document.body.dataset.escaped='yes';document.body.dataset.parent='accessible'}catch{document.body.dataset.parent='blocked'}
document.body.dataset.bridge=typeof window.signetDesktop;document.body.dataset.require=typeof window.require;
document.querySelector('button').addEventListener('click',event=>{document.body.dataset.clicked=String(event.isTrusted)});
fetch('/signet/datasets').then(()=>document.body.dataset.fetch='allowed').catch(()=>document.body.dataset.fetch='blocked');
});''')
        (fixture.directory / (stem + '.html')).write_text(f'''<!doctype html><html><head><meta charset="utf-8"><script src="{stem}_files/widget.js"></script></head>
<body><h2>Retained original widget {number}</h2><button type="button">Inspect subnetwork {number}</button></body></html>''')
        (fixture.directory / (stem + '_name.txt')).write_text(names)
        (fixture.directory / f'signet_circular_top{number}_freq0.45.pdf').write_bytes(b'%PDF-1.4\n% Controlled original figure fixture\n%%EOF\n')
        for name in (stem + '.html', stem + '_name.txt', f'signet_circular_top{number}_freq0.45.pdf'):
            relative = 'res/resv/' + name
            if relative not in fixture.job['required_outputs']:
                fixture.job['required_outputs'].append(relative)
    fixture.snapshot_path.write_text(json.dumps(fixture.snapshot))
    fixture.job_path.write_text(json.dumps(fixture.job))
    matrix = fixture.root / 'work/res/resn/signet_Afreq'
    matrix.parent.mkdir()
    matrix.write_text('0,0.8,0.9\n0.85,0,1\n0.95,0,0\n')
    with patch('agent.runtime.ssh_transport.remote', side_effect=AssertionError('Native result QA must stay local')):
        server = ChatServer(('127.0.0.1', 0), Mock(), model_label='isolated-fixture')
        print(json.dumps({'origin': f'http://127.0.0.1:{server.server_port}', 'run_id': fixture.run_id}), flush=True)
        server.serve_forever()
finally:
    fixture.doCleanups()
