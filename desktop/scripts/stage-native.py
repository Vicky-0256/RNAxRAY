#!/usr/bin/env python3
"""Stage a native runtime; never silently convert a host venv into a portable app."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
# Repository sources copied into every runtime (verify-native-release checks they are current).
SOURCE_DIRS = ['desktop/runtime', 'desktop/task-runner', 'desktop/spec', 'third_party/cplfold', 'web/cplfold', 'pipeline']
PINS = {"numpy": "1.24.4", "numba": "0.58.1", "llvmlite": "0.41.1"}
PROBE = '''import json,sys,platform,numpy,numba,llvmlite
@numba.njit
def total(x):
    return x.sum()
assert total(numpy.arange(10)) == 45
assert total.nopython_signatures
print(json.dumps({"python":platform.python_version(),"base_prefix":sys.base_prefix,"numpy":numpy.__version__,"numba":numba.__version__,"llvmlite":llvmlite.__version__,"numba_jit":True,"module_paths":[numpy.__file__,numba.__file__,llvmlite.__file__]}))
'''


def run(args, cwd, env):
    return subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True,
                          check=True, timeout=300).stdout


def smoke(root, executable, portable):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(('PYTHON', 'NUMBA')) and k not in ('VIRTUAL_ENV',)}
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    with tempfile.TemporaryDirectory(prefix='rnaxray-native-smoke-') as cache:
        env['NUMBA_CACHE_DIR'] = cache
        # -B is required in addition to PYTHONDONTWRITEBYTECODE because -I
        # isolates user environment variables on some Python builds.
        details = json.loads(run([str(executable), '-I', '-B', '-c', PROBE], root, env))
        if portable and not details['python'].startswith('3.11.'):
            raise ValueError('Portable runtime must use CPython 3.11.x for these dependency pins')
        for package, version in PINS.items():
            if details[package] != version:
                raise ValueError(f'{package}: expected {version}, got {details[package]}')
        if portable:
            for path in [details['base_prefix'], *details['module_paths']]:
                if not Path(path).resolve().is_relative_to(root.resolve()):
                    raise ValueError(f'Runtime depends on host files: {path}')
        output = run([str(executable), '-B', str(root / 'bin/cplfold'), '--sequence',
                      'GGCGCGGCACCGUCCGCGGAACAAACGG', '--beam', '20',
                      '--max-phase1', '3', '--max-phase2', '2'], root, env)
        if '..(((((..[[[[)))))......]]]]' not in output or 'Energy: -8.02 kcal/mol' not in output:
            raise ValueError('CPLfold native smoke did not match reference structure/energy:\n' + output)
        details['cplfold_reference_fold'] = 'passed'
        details['bowtie2'] = bowtie2_smoke(root, cache)
        details['viennarna'] = viennarna_smoke(root, executable, env)
        details['evidence'] = evidence_smoke(root, executable, env, portable)
    return details


VIENNA_PROBE = '''import json, RNA
structure, mfe = RNA.fold_compound("GGGGAAAACCCC&GGGGUUUUCCCC").mfe_dimer()
print(json.dumps({"version": RNA.__version__, "structure": structure, "mfe": round(mfe, 2)}))
'''


def viennarna_smoke(root, executable, env):
    """Folding energy for rnaxraypipe -e 1 comes from the ViennaRNA wheel."""
    try:
        details = json.loads(run([str(executable), '-I', '-B', '-c', VIENNA_PROBE], root, env))
    except subprocess.CalledProcessError:
        return None
    if details['version'] != '2.7.2' or details['mfe'] >= 0:
        raise ValueError('ViennaRNA smoke failed: %s' % details)
    return details


EVIDENCE_REQUIREMENTS = ROOT / 'desktop/runtime/requirements-evidence.txt'
EVIDENCE_PROBE = r'''import importlib.metadata, json, sys
expected = json.loads(sys.argv[1])
try:
    import mcp, rnacentral_sequence_search
    from rnacentral_sequence_search import server
except ImportError as error:
    print(json.dumps({"missing": str(error)}))
    raise SystemExit(0)
found, wrong = {}, {}
for name, version in expected.items():
    try:
        found[name] = importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        found[name] = None
    if found[name] != version:
        wrong[name] = found[name]
print(json.dumps({"mcp": found.get("mcp"), "rnacentral-mcp-server": found.get("rnacentral-mcp-server"),
                  "packages": len(found), "wrong": wrong,
                  "module_paths": [mcp.__file__, rnacentral_sequence_search.__file__]}))
'''


def evidence_pins(platform_name=None):
    """Exact pins of requirements-evidence.txt that apply to this platform."""
    platform_name = platform_name or sys.platform
    pins = {}
    for line in EVIDENCE_REQUIREMENTS.read_text(encoding='utf-8').splitlines():
        line = line.split('#', 1)[0].strip().rstrip('\\').strip()
        if not line or line.startswith('--'):
            continue
        requirement, _, marker = line.partition(';')
        name, _, version = requirement.strip().partition('==')
        marker = marker.strip()
        if marker == 'sys_platform == "win32"' and platform_name != 'win32':
            continue
        if marker and marker != 'sys_platform == "win32"':
            raise ValueError(f'unsupported marker in requirements-evidence.txt: {marker}')
        pins[name.strip().lower()] = version.strip()
    return pins


def evidence_smoke(root, executable, env, portable):
    """RNAcentral MCP client stack: exact pins, then a real stdio session.

    Returns None when the evidence packages are absent (verify-native-release
    rejects that); raises when they are present but wrong.  The session check
    starts the fixed RNAcentral server through the evidence worker and lists
    its tools; it makes no network request.
    """
    details = json.loads(run([str(executable), '-I', '-B', '-c', EVIDENCE_PROBE, json.dumps(evidence_pins())], root, env))
    if 'missing' in details:
        return None
    if details['wrong']:
        raise ValueError('Evidence packages do not match requirements-evidence.txt: %s' % details['wrong'])
    if portable:
        for path in details['module_paths']:
            if not Path(path).resolve().is_relative_to(root.resolve()):
                raise ValueError(f'Evidence runtime depends on host files: {path}')
    requests = ''.join(json.dumps({'id': i, 'request': r}) + '\n' for i, r in
                       enumerate(({'operation': 'status', 'connect': True}, {'operation': 'shutdown'}), 1))
    worker_env = {k: v for k, v in env.items() if k in ('PATH', 'HOME', 'SYSTEMROOT', 'TEMP', 'TMP')}
    worker_env.update(PYTHONDONTWRITEBYTECODE='1', PYTHONUNBUFFERED='1', PYTHONIOENCODING='utf-8')
    completed = subprocess.run([str(executable), '-B', '-m', 'desktop.runtime.evidence.worker', '--serve'],
                               cwd=root, env=worker_env, input=requests, text=True, capture_output=True,
                               check=True, timeout=120)
    status = json.loads(completed.stdout.splitlines()[0])['response']
    if not status.get('ok') or status.get('tools') != ['get_rna_description', 'map_rna_id']:
        raise ValueError('Evidence worker smoke failed: %s' % status)
    details.pop('module_paths')
    details.pop('wrong')
    details['worker_status'] = 'passed'
    details['tools'] = status['tools']
    return details


def bowtie2_smoke(root, scratch):
    """Build an index and map one read with the staged -s binaries."""
    suffix = '.exe' if os.name == 'nt' else ''
    align, build = root / 'bin' / ('bowtie2-align-s' + suffix), root / 'bin' / ('bowtie2-build-s' + suffix)
    if not align.is_file() or not build.is_file():
        return None
    reference = 'GGCGCGGCACCGUCCGCGGAACAAACGGAUCGAUCGGAUCCGAUGCUAGCUAGGCUAGCGAUCGAUCGAUGCAUGC'.replace('U', 'T')
    work = Path(scratch)
    # LF bytes: text mode writes CRLF on Windows, which Bowtie2 rejects as reads.
    (work / 'ref.fa').write_bytes(('>ref\n' + reference * 3 + '\n').encode())
    (work / 'read.fa').write_bytes(('>r1\n' + reference[10:60] + '\n').encode())
    subprocess.run([str(build), str(work / 'ref.fa'), str(work / 'idx')], capture_output=True, check=True, timeout=300)
    sam = subprocess.run([str(align), '--local', '-x', str(work / 'idx'), '-f', str(work / 'read.fa')],
                         capture_output=True, text=True, check=True, timeout=300).stdout
    if not any(line.startswith('r1\t') and line.split('\t')[2] == 'ref' for line in sam.splitlines()):
        raise ValueError('Bowtie2 smoke did not align the probe read:\n' + sam)
    version = subprocess.run([str(align), '--version'], capture_output=True, text=True, check=True, timeout=60).stdout.split('\n')[0].split()[-1]
    return {'version': version, 'align': 'passed'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--standalone-python', type=Path,
                        help='Extracted relocatable CPython 3.11 directory, with pinned dependencies installed')
    source.add_argument('--development-python', type=Path,
                        help='Host interpreter: produces nonportable development resources only')
    parser.add_argument('--output', type=Path, default=ROOT / 'desktop/resources/native')
    parser.add_argument('--source-id', help='Standalone source URL/version and SHA256 for provenance')
    parser.add_argument('--bowtie2', type=Path, help='Output of acquire-bowtie2.py for this platform')
    args = parser.parse_args()
    output = args.output.absolute()
    if output.exists():
        parser.error(f'Output already exists; choose an empty destination: {output}')
    portable = args.standalone_python is not None
    if portable and not args.source_id:
        parser.error('--source-id is required for portable runtime provenance')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='native-stage-', dir=output.parent) as temp:
        stage = Path(temp) / 'native'
        stage.mkdir()
        relative_python = Path('python/python.exe' if os.name == 'nt' else 'python/bin/python3')
        interpreter = stage / relative_python
        if portable:
            source_dir = args.standalone_python.resolve()
            if (source_dir / 'pyvenv.cfg').exists():
                parser.error('Virtual environments are not standalone CPython distributions')
            shutil.copytree(source_dir, stage / 'python', symlinks=True)
            for entry in (stage / 'python').rglob('*'):
                if entry.is_symlink() and not entry.resolve().is_relative_to((stage / 'python').resolve()):
                    raise ValueError(f'Standalone Python has external symlink: {entry}')
        else:
            interpreter.parent.mkdir(parents=True)
            if os.name == 'nt':
                raise ValueError('Development staging on Windows requires standalone mode')
            import shlex
            interpreter.write_text('#!/bin/sh\nexec ' + shlex.quote(str(args.development_python.absolute())) + ' \"$@\"\n')
            interpreter.chmod(0o755)
        for relative in SOURCE_DIRS:
            shutil.copytree(ROOT / relative, stage / relative,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '*.nbc', '*.nbi', 'tests', 'data'))
        # RNAxRay's own licence and authors, and the notices for everything else in the app.
        for name in ('LICENSE', 'AUTHORS', 'THIRD_PARTY_NOTICES.md'):
            shutil.copy2(ROOT / name, stage / name)
        (stage / 'bin').mkdir()
        shutil.copy2(ROOT / 'bin/cplfold', stage / 'bin/cplfold')
        if args.bowtie2:
            for binary in sorted((args.bowtie2 / 'bin').iterdir()):
                shutil.copy2(binary, stage / 'bin' / binary.name)
            (stage / 'third_party/bowtie2').mkdir(parents=True)
            for name in ('LICENSE', 'VERSION'):
                shutil.copy2(args.bowtie2 / name, stage / 'third_party/bowtie2' / name)
        details = smoke(stage, interpreter, portable)
        # Never ship interpreter caches generated by smoke checks. Besides
        # wasting space, they make the manifest machine- and version-specific.
        for cache in stage.rglob('__pycache__'):
            shutil.rmtree(cache)
        for cache in stage.rglob('*.pyc'):
            cache.unlink()
        manifest = {'manifest_version': '1.0', 'portable': portable,
                    'mode': 'standalone' if portable else 'development-external-python',
                    'platform': platform.system(), 'architecture': platform.machine(),
                    'python_executable': relative_python.as_posix(),
                    'source_id': args.source_id if portable else str(args.development_python.absolute()),
                    'checks': details, 'files': {}}
        for file in sorted(stage.rglob('*')):
            if file.is_file() and not file.is_symlink():
                manifest['files'][file.relative_to(stage).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
        (stage / 'native-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        stage.rename(output)
    print(json.dumps({'output': str(output), 'portable': portable, 'checks': details}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(error.stdout, file=sys.stderr)
        print(error.stderr, file=sys.stderr)
        raise SystemExit(error.returncode)
