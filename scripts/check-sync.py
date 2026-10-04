"""Run: python scripts/check-sync.py. Uses only temporary files."""
from pathlib import Path
from tempfile import TemporaryDirectory
import importlib.util
import json

spec = importlib.util.spec_from_file_location('sync', Path(__file__).with_name('sync.py'))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

with TemporaryDirectory() as temp:
    root = Path(temp) / 'project'
    vault = Path(temp) / 'vault'
    (root / 'plugin').mkdir(parents=True)
    install = vault / '.obsidian/plugins/english-reading-assistant'
    install.mkdir(parents=True)
    for name in sync.MIRROR:
        (root / 'plugin' / name).write_text('source', encoding='utf-8')
    (root / 'plugin/manifest.json').write_text(json.dumps({'id': 'english-reading-assistant'}), encoding='utf-8')
    config = {'vault': str(vault), 'mirror': 'development/plugin'}
    (install / 'main.js').write_text('user edit', encoding='utf-8')
    try:
        sync.changes(root, config, {})
        raise AssertionError('Unadopted existing file was not blocked')
    except ValueError as error:
        assert 'Local changes' in str(error)
    assert (install / 'main.js').read_text(encoding='utf-8') == 'user edit'
    state = {str(install / 'main.js'): sync.digest(b'user edit')}
    files, updates = sync.changes(root, config, state)
    assert len(updates) == len(sync.CODE) + len(sync.MIRROR)
    for target, content in files:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    state = {str(target): sync.digest(content) for target, content in files}
    assert not sync.changes(root, config, state)[1]
    (install / 'data.json').write_text('private draft', encoding='utf-8')
    (install / 'focus-questions.json').write_text('private questions', encoding='utf-8')
    (root / 'plugin/main.js').write_text('updated source', encoding='utf-8')
    assert len(sync.changes(root, config, state)[1]) == 2
    assert all(target.name not in ['data.json', 'focus-questions.json'] for target, _ in files)
    (install / 'main.js').write_text('unsynced local edit', encoding='utf-8')
    try:
        sync.changes(root, config, state)
        raise AssertionError('Conflicting local edit was not blocked')
    except ValueError as error:
        assert 'Local changes' in str(error)
    try:
        sync.changes(root, {**config, 'mirror': '../outside'}, state)
        raise AssertionError('Path escape was not blocked')
    except ValueError as error:
        assert 'inside the vault' in str(error)
print('PASS: preflight conflicts fail before writes; two targets update; private files excluded; repeat sync empty; path escape rejected.')
