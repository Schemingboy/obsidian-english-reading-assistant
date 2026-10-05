"""Sync explicit plugin files to a vault; configuration and backups stay local.

Run python scripts/sync.py --check to inspect, or without --check to sync.
Use --reload to flush/reload an already enabled plugin through Obsidian CLI.
"""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
from datetime import datetime

ROOT = Path(__file__).resolve().parents[1]
CODE = ['main.js', 'agent.js', 'agent-ui.js', 'agent-reading.js', 'styles.css', 'manifest.json', 'analyzer.py']
MIRROR = CODE + ['requirements.txt', 'check.js', 'check-agent.js', 'check.py', 'check-colors.py']


def digest(content):
    return hashlib.sha256(content).hexdigest()


def read_json(path, default=None):
    return json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else default


def changes(root, config, state):
    vault = Path(config['vault']).resolve()
    if not (vault / '.obsidian').is_dir():
        raise ValueError('Vault must contain an existing .obsidian directory.')
    plugin_id = read_json(root / 'plugin/manifest.json')['id']
    if plugin_id != 'english-reading-assistant':
        raise ValueError('Unexpected plugin ID.')
    install = vault / '.obsidian/plugins' / plugin_id
    targets = [(install, CODE)]
    if config.get('mirror'):
        mirror = (vault / config['mirror']).resolve()
        if not mirror.is_relative_to(vault) or mirror == vault:
            raise ValueError('Mirror must be a directory inside the vault.')
        if mirror == install or mirror.is_relative_to(install) or install.is_relative_to(mirror):
            raise ValueError('Mirror and install directories must be separate.')
        targets.append((mirror, MIRROR))
    files = [(folder / name, (root / 'plugin' / name).read_bytes()) for folder, names in targets for name in names]
    if config.get('python'):
        python = Path(config['python']).resolve()
        if not python.is_file():
            raise ValueError('Configured Python executable does not exist.')
        files.append((install / 'runtime.json', (json.dumps({'pythonPath': str(python)}, ensure_ascii=False, indent=2) + '\n').encode('utf-8')))
    result = []
    for target, content in files:
        before = target.read_bytes() if target.exists() else None
        if before == content:
            continue
        if before is not None and state.get(str(target)) != digest(before):
            raise ValueError(f'Local changes or unadopted file: {target}. Compare before syncing; nothing was written.')
        result.append((target, content, before))
    return files, result


def cli(config, code):
    result = subprocess.run([config['obsidian'], f"vault={config['vaultName']}", 'eval', f'code={code}'], capture_output=True, text=True, encoding='utf-8', timeout=60)
    if result.returncode or '\nError:' in '\n' + result.stdout or '\nError:' in '\n' + result.stderr or '=> ERA_SYNC_OK' not in result.stdout:
        raise RuntimeError('Obsidian reload failed: ' + result.stdout + result.stderr)


UNLOAD = '''(async()=>{
 const id='english-reading-assistant',p=app.plugins.plugins[id];
 if(!p)throw Error('Enable the plugin before using --reload');
 window.__eraSyncViews=app.workspace.getLeavesOfType(id).map(l=>({path:l.view.file?.path,panel:l.view.panel,scroll:l.view.article?.scrollTop,analyzed:l.view.analysisReady}));
 await p.flush();await app.plugins.unloadPlugin(id);await p.flush();return 'ERA_SYNC_OK';
})()'''
LOAD = '''(async()=>{
 const id='english-reading-assistant',dir=app.vault.configDir+'/plugins/'+id;
 const m=JSON.parse(await app.vault.adapter.read(dir+'/manifest.json'));m.dir=dir;app.plugins.manifests[id]=m;
 await app.plugins.loadPlugin(id);const p=app.plugins.plugins[id];if(!p)throw Error('Plugin did not load');
 for(const s of window.__eraSyncViews||[]){const f=app.vault.getAbstractFileByPath(s.path);if(f){const v=await p.open(f);if(s.analyzed)await v.analyze();v.selectPanel(s.panel||'notes');v.article.scrollTop=s.scroll||0;}}
 delete window.__eraSyncViews;return 'ERA_SYNC_OK';
})()'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--reload', action='store_true')
    args = parser.parse_args()
    config = read_json(ROOT / 'sync.local.json')
    if not config:
        raise ValueError('Create sync.local.json as described in README.md.')
    state_path = ROOT / '.local/sync-state.json'
    state = read_json(state_path, {})
    files, updates = changes(ROOT, config, state)
    print(json.dumps({'changed': [str(p) for p, _, _ in updates], 'checkedFiles': len(files)}, ensure_ascii=False))
    if args.check:
        return
    backup = ROOT / '.local/backups' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup.mkdir(parents=True)
    index = []
    for i, (target, _, before) in enumerate(updates):
        if before is not None:
            (backup / str(i)).write_bytes(before)
        index.append({'target': str(target), 'backup': str(i) if before is not None else None})
    (backup / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding='utf-8')
    if args.reload:
        cli(config, UNLOAD)
    written = []
    try:
        for target, content, before in updates:
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(target.name + '.era-sync-tmp')
            if temporary.exists():
                raise ValueError(f'Unfinished sync file: {temporary}')
            temporary.write_bytes(content)
            temporary.replace(target)
            written.append((target, before))
        for target, content in files:
            if target.read_bytes() != content:
                raise ValueError(f'Verification failed: {target}')
        if args.reload:
            cli(config, LOAD)
    except Exception:
        for target, before in reversed(written):
            if before is None:
                target.unlink()  # This run created it.
            else:
                target.write_bytes(before)
        if args.reload:
            # Unload any partially loaded new version, then restore the old code.
            cli(config, "(async()=>{const p=app.plugins.plugins['english-reading-assistant'];if(p){await p.flush();await app.plugins.unloadPlugin(p.manifest.id);await p.flush();}return 'ERA_SYNC_OK';})()")
            cli(config, LOAD)
        raise
    state.update({str(target): digest(content) for target, content in files})
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    print('PASS: source, mirror and installation match; personal data untouched.')


if __name__ == '__main__':
    main()
