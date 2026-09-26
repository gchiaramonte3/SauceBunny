# NEXIS relinking verification

Scope: existing Multitrack linked/grouped AAF imports. Source media remains
read-only. No server mounting, credentials, network URL access, full-file
conversion, new decoder dependency or alternative-group marker export.

## Corrected failure

The resolver rejected every non-local authority in `file://server/workspace/...`
locators, also losing the filename used for folder matching. Connected storage
could therefore remain offline. Network authorities now namespace remembered
local path mappings; they are never passed to a network client. A chosen workspace,
renamed mount, Avid MediaFiles folder, MXF folder or numbered subfolder can resolve
known relative paths before any scan. Original-recorder ancestor paths are not
substituted for trimmed Avid media.

OP1a may contain several PCM streams with identical format/duration. SourcePackage
UMID plus source slot now resolves the MXF MaterialPackage track ID. FFprobe
selects that ID, then returns the stream index used by bounded PCM extraction.
Neither stream order nor a microphone's editable name determines routing.

## Automated coverage

- No arbitrary source-size ceiling: generated sparse AAF and MXF files above
  64 GiB exercise graph inspection, MXF headers and bounded head/tail identity.
  Sparse fixtures are not a certification of hours of real large-essence playback.
- Multitrack has the shared Pipeline controls before and after import. Native
  stages, candidate paths/sizes, permission errors, source/stream mismatches and
  resolution totals survive in a local rolling log (two 1 MiB files). Export
  diagnostics uses Save As and includes the build and saved graph without
  transcript text or media samples. No report is uploaded automatically.

- Server/UNC and percent-encoded locators, exporter prefixes, renamed mounts,
  authority separation, prefix boundaries and traversal rejection.
- Scoped folder scans, duplicate filenames, symlink exclusion, cancellation,
  disconnection, changed media and preserved verified bindings.
- Generated two-microphone OP1a with distinct 440/880 Hz tones: actual header
  identities, FFprobe selection, seeked FFmpeg extraction and measured isolation.
- Generated mono OP-Atom: header identity survives rename; PCM format validation.
- AAF MultipleDescriptor/LinkedSlotID routing, rational nested trim, ambiguous
  descriptors, malformed/missing MXFs and explicit unsupported origin rejection.
- Version migration preserves owner labels, committed empty results, mappings
  and stable lane IDs; changed routing warns rather than deleting transcripts.
- Relink compare-and-save includes mappings; diagnostic UI retains its disclosure.

Both supplied production AAFs were re-inspected read-only. The reference AAF
retains A38, three sources and 976 markers. The group AAF retains A1–A20,
98 underlying microphone lanes and 12 markers. A4 retains its selected branch
and four alternatives. No source names or production paths are hard-coded.

## Limits and next on-site check

On September 22, the user confirmed that a reference AAF connected successfully
to NEXIS media on their other computer. This validates that reported workflow;
it is not a measured server-throughput or all-formats certification. The server
remains disconnected from this development Mac. The new Whisper timing counters
make the next remote performance report more informative.

For further coverage, open the existing document and Refresh availability. If the
workspace name changed, use Locate media folder once. Check several selected and
alternative microphones, boundary-adjacent seeks, Solo/Mute, transcription/Stop,
then reopen saved results. Original media and existing transcripts must remain.
If sources remain offline, use Multitrack → Pipeline → Export diagnostics on
that computer. Review paths before sharing the TXT file. This captures the
actual attempted mount paths and rejected identities, not a guess from another Mac.

Known relative paths avoid folder scans. Renamed-file identity fallback is
limited to 5,000 MXFs in a selected folder; larger workspaces require choosing a
closer numbered subfolder. Scan limits never count as proof that no media exists.
Nonzero MXF internal origins, multiple material packages and nested MXF edit lists
remain explicit unsupported cases; there is no silent time-origin substitution.
No macOS 14 device was available for runtime certification. A locally signed
preview is not a notarized public release. No installation or GitHub publication
is part of this change.

Implementation references: [FFmpeg MXF demuxer](https://github.com/FFmpeg/FFmpeg/blob/n8.0/libavformat/mxfdec.c),
[pyaaf2 MXF header parser](https://github.com/markreidvfx/pyaaf2/blob/main/src/aaf2/mxf.py),
[Avid NEXIS client guide](https://resources.avid.com/SupportFiles/attach/AvidNEXIS/AvidNEXIS_Client_Guide_v24.6.pdf).
