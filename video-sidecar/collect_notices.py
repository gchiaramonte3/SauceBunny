"""Build-only notice collection. Never run by the installed application."""
import hashlib
import importlib.metadata as metadata
import json
import shutil
import sys
import sysconfig
import urllib.request
from pathlib import Path

destination = Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=True)
missing_wheel_notices = {
    "cython": ("https://raw.githubusercontent.com/cython/cython/3.1.8/LICENSE.txt", "9568a2b155e66ac3e0ba1fd80b52b827b9460e6cf6f233125e7cbca8e206ddc3"),
    "tokenizers": ("https://raw.githubusercontent.com/huggingface/tokenizers/v0.23.2/LICENSE", "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"),
    "sentencepiece": ("https://raw.githubusercontent.com/google/sentencepiece/v0.2.2/LICENSE", "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"),
}
inventory = []
for distribution in sorted(metadata.distributions(), key=lambda d: d.metadata["Name"].lower()):
    name = distribution.metadata["Name"]
    target = destination / f"{name}-{distribution.version}"
    copied = []
    for file in distribution.files or []:
        if (".dist-info/" in str(file) or name.lower() == "opencv-python") and file.name.lower().startswith(("license", "licence", "copying", "notice")):
            source = Path(distribution.locate_file(file))
            if source.is_file():
                target.mkdir(exist_ok=True)
                # Preserve every nested notice, including licenses with the
                # same filename, rather than silently overwriting them.
                output = target / str(file).replace("/", "__")
                shutil.copy2(source, output)
                copied.append(output.name)
    if name.lower() in missing_wheel_notices:
        url, expected = missing_wheel_notices[name.lower()]
        with urllib.request.urlopen(url, timeout=30) as response:
            text = response.read(100_000)
        if hashlib.sha256(text).hexdigest() != expected:
            raise ValueError(f"Upstream notice changed: {name}")
        target.mkdir(exist_ok=True)
        (target / "LICENSE").write_bytes(text)
        copied.append("LICENSE")
    if not copied:
        raise ValueError(f"Missing dependency license: {name}")
    inventory.append({"name": name, "version": distribution.version,
        "license": distribution.metadata.get("License-Expression") or distribution.metadata.get("License", ""),
        "project_urls": distribution.metadata.get_all("Project-URL", []), "notices": copied})
shutil.copy2(Path(sysconfig.get_path("stdlib")) / "LICENSE.txt", destination / "CPython-LICENSE.txt")
(destination / "dependency-inventory.json").write_text(json.dumps(inventory, indent=2))
print(f"Collected notices for {len(inventory)} build/runtime dependencies and CPython")
