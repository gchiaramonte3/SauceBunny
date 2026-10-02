"""Build-only audit of every Mach-O dependency in the one-folder bundle."""
from pathlib import Path
import re
import subprocess
import sys

root = Path(sys.argv[1])
found = []
for path in root.rglob('*'):
    if path.is_symlink() or not path.is_file():
        continue
    kind = subprocess.check_output(['/usr/bin/file','-b',str(path)],text=True)
    if 'Mach-O' not in kind:
        continue
    found.append(path)
    architectures = subprocess.check_output(['/usr/bin/lipo','-archs',str(path)],text=True).split()
    if 'arm64' not in architectures:
        raise SystemExit(f'Missing Apple Silicon architecture: {path}')
    deps = subprocess.check_output(['/usr/bin/otool','-L',str(path)],text=True)
    for line in deps.splitlines():
        if not line.startswith((' ', '\t')) or ' (compatibility version ' not in line:
            continue  # A universal Mach-O repeats its architecture header.
        dependency = line.strip().split(' (',1)[0]
        if not dependency.startswith(('/usr/lib/','/System/Library/','@rpath/','@loader_path/','@executable_path/')):
            raise SystemExit(f'Non-portable bundled dependency: {path.name}: {dependency}')
    loads = subprocess.check_output(['/usr/bin/otool','-l',str(path)],text=True)
    # Only deployment-target load commands, not dylib version numbers or SDKs.
    for block in re.split(r'Load command \d+', loads):
        if 'LC_BUILD_VERSION' not in block and 'LC_VERSION_MIN_MACOSX' not in block:
            continue
        floor = re.search(r'(?:minos|version) (\d+)\.(\d+)', block)
        if not floor or tuple(map(int, floor.groups())) > (14,0):
            raise SystemExit(f'Requires newer than macOS 14: {path}: {block.strip()}')
    if re.search(r'path (?:/Users/|/opt/homebrew/|/usr/local/)',loads):
        raise SystemExit(f'Non-portable RPATH in {path.name}')
    subprocess.run(['/usr/bin/codesign','--verify','--strict',str(path)],check=True)
if len(found) < 2:
    raise SystemExit('The runtime audit did not find the interpreter and bootloader.')
print(f'Verified {len(found)} bundled Mach-O files: arm64, deployment target <=14, self-contained and signed. Not macOS 14 runtime certification.')
