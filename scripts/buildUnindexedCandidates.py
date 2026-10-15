"""Compile verified deployed sources with only protocol event indexing removed."""
import copy
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / 'deployments/unindexed-upgrade-2026-10-15'
SOLC = Path.home() / 'Library/Caches/hardhat-nodejs/compilers-v2/macosx-amd64/solc-macosx-amd64-v0.8.27+commit.40a35a09'


def compile_input(inp):
    proc = subprocess.run([str(SOLC), '--standard-json'], input=json.dumps(inp), text=True, capture_output=True, check=True)
    output = json.loads(proc.stdout)
    errors = [e['formattedMessage'] for e in output.get('errors', []) if e['severity'] == 'error']
    if errors:
        raise RuntimeError('\n'.join(errors))
    return output


summary = []
for file in FOLDER.glob('*-verified.json'):
    name = file.name[:-len('-verified.json')]
    verified = json.loads(file.read_text())
    source = verified['SourceCode']
    baseline = json.loads(source[1:-1] if source.startswith('{{') else source)
    # Compile only the intended contract and its library dependencies. Preserve exact settings.
    baseline['settings']['outputSelection'] = {'*': {'*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'storageLayout']}}
    before = compile_input(baseline)
    candidate = copy.deepcopy(baseline)
    changed = []
    for path, value in candidate['sources'].items():
        if path.startswith('contracts/') and not path.startswith('contracts/vendor/'):
            updated = re.sub(r'\bindexed\s+', '', value['content'])
            if updated != value['content']:
                changed.append(path)
                value['content'] = updated
    candidate['settings']['libraries'] = {}
    after = compile_input(candidate)
    source_path = next(path for path, contracts in after['contracts'].items() if name in contracts)
    old_contract = before['contracts'][source_path][name]
    new_contract = after['contracts'][source_path][name]
    # Event layout edits cannot alter storage: require identical compiler layouts.
    if old_contract['storageLayout'] != new_contract['storageLayout']:
        raise RuntimeError(f'{name}: unexpected storage layout change')
    expected_abi = copy.deepcopy(old_contract['abi'])
    for event in expected_abi:
        if event['type'] == 'event':
            # Only locally declared protocol events change; inherited dependency events do not.
            new_event = next(e for e in new_contract['abi'] if e['type'] == 'event' and e['name'] == event['name'] and [i['type'] for i in e['inputs']] == [i['type'] for i in event['inputs']])
            for old, new in zip(event['inputs'], new_event['inputs']):
                if old.get('indexed') is False and new.get('indexed'):
                    raise RuntimeError(f'{name}: newly indexed input')
                old['indexed'] = new['indexed']
    if expected_abi != new_contract['abi']:
        raise RuntimeError(f'{name}: unexpected ABI changes beyond event indexing')
    if len(new_contract['evm']['deployedBytecode']['object']) // 2 > 24576:
        raise RuntimeError(f'{name}: EIP-170 limit exceeded')
    (FOLDER / f'{name}-baseline-output.json').write_text(json.dumps(before) + '\n')
    (FOLDER / f'{name}-candidate-input.json').write_text(json.dumps(candidate) + '\n')
    (FOLDER / f'{name}-candidate-output.json').write_text(json.dumps(after) + '\n')
    row = {'name': name, 'sourcePath': source_path, 'oldAddress': verified['address'], 'compiler': verified['CompilerVersion'], 'sourceFilesChanged': changed,
           'inputSha256': hashlib.sha256(json.dumps(candidate, sort_keys=True).encode()).hexdigest(),
           'oldRuntimeBytes': len(old_contract['evm']['deployedBytecode']['object']) // 2,
           'newRuntimeBytes': len(new_contract['evm']['deployedBytecode']['object']) // 2,
           'storageLayoutIdentical': True, 'originalLibraries': baseline['settings'].get('libraries', {})}
    summary.append(row)
    print(json.dumps(row), flush=True)
(FOLDER / 'build-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
