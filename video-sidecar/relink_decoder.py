"""Replace wheel decoder dependencies with the pinned LGPL-only build."""
import ctypes
import shutil
import subprocess
import sys
from pathlib import Path

import importlib.util

installed = Path(sys.argv[1]).resolve()
backup = Path(sys.argv[2]).resolve()
package = Path(importlib.util.find_spec("av").origin).parent
destination = package / ".dylibs"
if not backup.exists() and destination.exists():
    shutil.move(str(destination), backup)
destination.mkdir(exist_ok=True)
libraries = sorted(path for path in (installed / "lib").glob("*.dylib") if not path.is_symlink())
assert len(libraries) == 7, f"Unexpected FFmpeg library set: {libraries}"
for library in libraries:
    shutil.copy2(library, destination / library.name)

def dependencies(path):
    output = subprocess.check_output(["/usr/bin/otool", "-L", str(path)], text=True)
    return [line.strip().split(" ", 1)[0] for line in output.splitlines()[1:]]

for binary in [*destination.glob("*.dylib"), *package.rglob("*.so")]:
    args = []
    if binary.parent == destination:
        args += ["-id", "@loader_path/" + binary.name]
    for dependency in dependencies(binary):
        name = Path(dependency).name
        if name.startswith(("libav", "libsw")):
            # Use the precise library build that compiled these extensions.
            abi = ".".join(name.split(".")[:2])
            matches = [library for library in libraries if library.name.startswith(abi + ".")]
            assert len(matches) == 1, f"No decoder ABI match: {dependency}"
            import os
            replacement = "@loader_path/" + os.path.relpath(destination / matches[0].name, binary.parent)
            args += ["-change", dependency, replacement]
    if args:
        subprocess.run(["/usr/bin/install_name_tool", *args, str(binary)], check=True)
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(binary)], check=True, capture_output=True)
# Inspect the actual new library, not the package's BSD metadata.
codec = ctypes.CDLL(str(next(destination.glob("libavcodec.*.dylib"))))
codec.avcodec_license.restype = ctypes.c_char_p
assert codec.avcodec_license() == b"LGPL version 2.1 or later", codec.avcodec_license()
print("PyAV relinked against pinned LGPL 2.1 FFmpeg libraries")
