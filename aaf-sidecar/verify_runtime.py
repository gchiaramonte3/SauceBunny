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
    deps = subprocess.check_output(['/usr/bin/otool','-L',str(path)],text=True)
    for line in deps.splitlines()[1:]:
        dependency = line.strip().split(' (',1)[0]
        if not dependency.startswith(('/usr/lib/','/System/Library/','@rpath/','@loader_path/','@executable_path/')):
            raise SystemExit(f'Non-portable bundled dependency: {path.name}: {dependency}')
    loads = subprocess.check_output(['/usr/bin/otool','-l',str(path)],text=True)
    if re.search(r'path (?:/Users/|/opt/homebrew/|/usr/local/)',loads):
        raise SystemExit(f'Non-portable RPATH in {path.name}')
    subprocess.run(['/usr/bin/codesign','--verify','--strict',str(path)],check=True)
if len(found) < 2:
    raise SystemExit('The runtime audit did not find the interpreter and bootloader.')
print(f'Verified {len(found)} bundled Mach-O files: self-contained and signed.')
