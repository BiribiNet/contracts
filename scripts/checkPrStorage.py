import json, pathlib, subprocess, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOLC = pathlib.Path.home() / 'Library/Caches/hardhat-nodejs/compilers-v2/macosx-amd64/solc-macosx-amd64-v0.8.27+commit.40a35a09'
results = []
for name, typ in [('RouletteEngine', 'RouletteEngineStorageLib.Layout'), ('SideBet', 'SideBet.SideBetData'), ('BankVault4626', 'BankVault4626.BankVaultStorage')]:
    builds = [json.loads(p.read_text()) for p in (ROOT / 'artifacts/build-info').glob('*.json')]
    old_source = subprocess.check_output(['git','show',f'a610335:contracts/{name}.sol'], text=True)
    old = next(b['input'] for b in builds if b['input']['sources'].get(f'contracts/{name}.sol',{}).get('content') == old_source)
    matching = [b for b in builds if b['input']['sources'].get(f'contracts/{name}.sol',{}).get('content') == (ROOT/f'contracts/{name}.sol').read_text()]
    new = matching[-1]['input']
    layouts = []
    import_path = 'contracts/libraries/RouletteEngineStorageLib.sol' if name == 'RouletteEngine' else f'contracts/{name}.sol'
    for version, source in [('old', old), ('new', new)]:
        inp = json.loads(json.dumps(source))
        inp['sources']['StorageProbe.sol'] = {'content': f'pragma solidity ^0.8.27; import "{import_path}"; contract StorageProbe {{ {typ} internal data; }}'}
        inp['settings']['outputSelection'] = {'*': {'*': ['storageLayout']}}
        out = subprocess.run([str(SOLC), '--standard-json'], input=json.dumps(inp), text=True, capture_output=True, check=True)
        result = json.loads(out.stdout)
        errors = [e['formattedMessage'] for e in result.get('errors', []) if e['severity'] == 'error']
        if errors: raise RuntimeError('\n'.join(errors))
        layout = result['contracts']['StorageProbe.sol']['StorageProbe']['storageLayout']
        layout['storage'] = layout['types'][layout['storage'][0]['type']]['members']
        layouts.append(layout)
        (ROOT/f'deployments/pr-{name}-{version}-layout.json').write_text(json.dumps(layout, indent=2)+'\n')
    old_layout, new_layout = layouts
    def compatible(a, b):
        if a['encoding'] != b['encoding']: raise RuntimeError('Encoding changed')
        if a['encoding'] not in ['mapping', 'dynamic_array'] and not a.get('members') and a['numberOfBytes'] != b['numberOfBytes']: raise RuntimeError('Type size changed')
        for field in ['key', 'value', 'base']:
            if field in a: compatible(old_layout['types'][a[field]], new_layout['types'][b[field]])
        if 'members' in a: compare_members(a['members'], b['members'])
        if not any(k in a for k in ['members', 'base', 'key']):
            if a['label'] != b['label']: raise RuntimeError(f"Type changed {a['label']} -> {b['label']}")
    def compare_members(a, b):
        if len(b) < len(a): raise RuntimeError('Storage fields removed')
        for before, after in zip(a, b):
            for k in ['label','slot','offset']:
                if before[k] != after[k]: raise RuntimeError(f'Storage field changed: {before} -> {after}')
            compatible(old_layout['types'][before['type']], new_layout['types'][after['type']])
    compare_members(old_layout['storage'], new_layout['storage'])
    # The namespace location itself must be unchanged.
    for path, content in old['sources'].items():
        if path in new['sources']:
            for location in re.findall(r'0x[0-9a-fA-F]{64}', content['content']):
                if ('STORAGE_LOCATION' in content['content'] or path.endswith('RouletteEngineStorageLib.sol')) and location not in new['sources'][path]['content']:
                    raise RuntimeError(f'Namespace location removed: {path}')
    results.append({'contract':name, 'existingFields':len(old_layout['storage']), 'newFields':len(new_layout['storage']), 'compatible':True})
    print(results[-1], flush=True)
(ROOT/'deployments/pr-storage-check-2026-10-09.json').write_text(json.dumps(results, indent=2)+'\n')
