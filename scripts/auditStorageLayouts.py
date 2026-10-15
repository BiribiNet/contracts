"""Offline, compiler-derived storage audit. Never connects to a chain or signs.

Usage: python3 scripts/auditStorageLayouts.py [reference-commit] [output.json]
Requires current Hardhat artifacts and solc 0.8.27 (SOLC_BINARY may override).
Includes the engine's library namespace, which OZ's implementation scan misses.
"""
import copy
import hashlib
import json
import os
import posixpath
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
REFERENCE = sys.argv[1] if len(sys.argv) > 1 else "df898f08c8eb822dd772903f01d25fad6e5d251f"
OUTPUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "deployments/mainnet-storage-2026-10-15.json"
SOLC = os.environ.get("SOLC_BINARY", str(Path.home() / "Library/Caches/hardhat-nodejs/compilers-v2/macosx-amd64/solc-macosx-amd64-v0.8.27+commit.40a35a09"))
SPECS = {
    "RouletteEngine": ("contracts/libraries/RouletteEngineStorageLib.sol", "RouletteEngineStorageLib.Layout"),
    "SideBet": ("contracts/SideBet.sol", "SideBet.SideBetData"),
    "BankVault4626": ("contracts/BankVault4626.sol", "BankVault4626.BankVaultStorage"),
}


def git_source(ref, path):
    return subprocess.check_output(["git", "show", f"{ref}:{path}"], cwd=ROOT, text=True)


def current_input(name):
    debug_path = ROOT / f"artifacts/contracts/{name}.sol/{name}.dbg.json"
    debug = json.loads(debug_path.read_text())
    build = json.loads((debug_path.parent / debug["buildInfo"]).resolve().read_text())
    # Refuse stale build inputs anywhere in the dependency closure, including libraries.
    for path, source in build["input"]["sources"].items():
        local = ROOT / (path if path.startswith("contracts/") else f"node_modules/{path}")
        if not local.exists() or local.read_text() != source["content"]:
            raise RuntimeError(f"Stale or missing source in artifact: {path}; compile first")
    return build["input"]


def dependency_closure(inp, roots):
    inp = copy.deepcopy(inp)
    kept = {}
    pending = list(roots)
    while pending:
        path = pending.pop()
        if path in kept:
            continue
        kept[path] = inp["sources"][path]
        for imported in re.findall(r'import\s+(?:[^;]*?from\s+)?["\']([^"\']+)["\']\s*;', kept[path]["content"]):
            pending.append(posixpath.normpath(posixpath.join(posixpath.dirname(path), imported)) if imported.startswith(".") else imported)
    inp["sources"] = kept
    return inp


def compile_layouts(inp, name, namespace_path, namespace_type):
    inp = copy.deepcopy(inp)
    # Expose custom storage as a real variable: solc otherwise omits assembly namespaces.
    probe_path = "MainnetStorageProbe.sol"
    inp["sources"][probe_path] = {"content": f'pragma solidity ^0.8.27; import "{namespace_path}"; contract MainnetStorageProbe {{ {namespace_type} internal data; }}'}
    inp["settings"]["outputSelection"] = {"*": {"*": ["storageLayout"]}}
    proc = subprocess.run([SOLC, "--standard-json"], input=json.dumps(inp), text=True, capture_output=True, check=True)
    out = json.loads(proc.stdout)
    errors = [e["formattedMessage"] for e in out.get("errors", []) if e["severity"] == "error"]
    if errors:
        raise RuntimeError("\n".join(errors))
    custom = out["contracts"][probe_path]["MainnetStorageProbe"]["storageLayout"]
    custom["storage"] = custom["types"][custom["storage"][0]["type"]]["members"]
    ordinary = out["contracts"][f"contracts/{name}.sol"][name]["storageLayout"]
    return {"custom": custom, "ordinary": ordinary}


def compare_layout(before, after):
    seen = set()

    def members(a, b, path):
        if len(b) < len(a):
            raise RuntimeError(f"{path}: fields removed")
        for old, new in zip(a, b):
            for key in ("label", "slot", "offset"):
                if old[key] != new[key]:
                    raise RuntimeError(f"{path}: {key} changed: {old} -> {new}")
            types(old["type"], new["type"], path + "." + old["label"])

    def types(old_id, new_id, path, fixed_stride=False):
        pair = (old_id, new_id, fixed_stride)
        if pair in seen:
            return
        seen.add(pair)
        old, new = before["types"][old_id], after["types"][new_id]
        if old["encoding"] != new["encoding"]:
            raise RuntimeError(f"{path}: encoding changed")
        # Appending a struct field inside an array changes its stride: unsafe even
        # when every existing field has the same relative slot and offset.
        if fixed_stride or "members" not in old:
            if old["numberOfBytes"] != new["numberOfBytes"]:
                raise RuntimeError(f"{path}: size/array stride changed")
        if "members" in old:
            members(old["members"], new.get("members", []), path)
        for key in ("key", "value", "base"):
            if key in old:
                if key not in new:
                    raise RuntimeError(f"{path}: {key} removed")
                types(old[key], new[key], path + f"[{key}]", key == "base")
        if not any(k in old for k in ("members", "key", "base")) and old["label"] != new["label"]:
            raise RuntimeError(f"{path}: type changed {old['label']} -> {new['label']}")

    members(before["storage"], after["storage"], "storage")


report = {
    "referenceCommit": subprocess.check_output(["git", "rev-parse", REFERENCE], cwd=ROOT, text=True).strip(),
    "candidateCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
    "scope": "Offline source comparison; not proof of current deployed bytecode or a fork rehearsal",
    "contracts": [],
}
for name, (namespace_path, namespace_type) in SPECS.items():
    roots = [f"contracts/{name}.sol", namespace_path]
    full_input = current_input(name)
    new_input = dependency_closure(full_input, roots)
    # Reconstruct the reference from Git, rather than accidentally selecting a
    # cached build with the right main file but different imported libraries.
    if git_source(REFERENCE, "yarn.lock") != (ROOT / "yarn.lock").read_text():
        raise RuntimeError("Dependency lockfile changed; reconstruct reference dependencies separately")
    old_input = copy.deepcopy(full_input)
    old_input["sources"] = {p: s for p, s in old_input["sources"].items() if not p.startswith("contracts/")}
    reference_paths = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", REFERENCE, "contracts"], cwd=ROOT, text=True).splitlines()
    for path in reference_paths:
        if path.endswith(".sol"):
            old_input["sources"][path] = {"content": git_source(REFERENCE, path)}
    old_input = dependency_closure(old_input, roots)
    before = compile_layouts(old_input, name, namespace_path, namespace_type)
    after = compile_layouts(new_input, name, namespace_path, namespace_type)
    for key in ("custom", "ordinary"):
        compare_layout(before[key], after[key])
    old_namespace = old_input["sources"][namespace_path]["content"]
    new_namespace = new_input["sources"][namespace_path]["content"]
    pattern = r"(?:STORAGE_LOCATION\s*=\s*)(0x[0-9a-fA-F]{64})"
    old_slots, new_slots = re.findall(pattern, old_namespace), re.findall(pattern, new_namespace)
    if not old_slots or old_slots != new_slots:
        raise RuntimeError(f"{name}: namespace root changed or missing")
    row = {"contract": name, "compatible": True, "namespaceRoot": new_slots[0],
           "existingFields": len(before["custom"]["storage"]), "candidateFields": len(after["custom"]["storage"]),
           "ordinaryFields": after["ordinary"]["storage"], "referenceReconstructedFromGit": True, "dependencyLockfileUnchanged": True,
           "sourceSha256": hashlib.sha256(new_namespace.encode()).hexdigest(), "layouts": {"reference": before, "candidate": after}}
    report["contracts"].append(row)
    print(f"{name}: compatible, {row['existingFields']} -> {row['candidateFields']} custom fields, {len(row['ordinaryFields'])} ordinary fields", flush=True)
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(report, indent=2) + "\n")
print(f"Saved {OUTPUT}")
