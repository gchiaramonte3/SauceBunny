# Repository guidance

Start with [CLAUDE.md](CLAUDE.md), the engineering guide for developers and
coding agents. This file is a navigation entrypoint, not a second rulebook.
If your tool does not load repository instructions automatically, open these
documents explicitly before working.

## Before changing UI

1. Read [docs/DESIGN.md](docs/DESIGN.md), the normative application design
   rules and token conventions.
2. Read [docs/DESIGN-SYSTEM-AUDIT.md](docs/DESIGN-SYSTEM-AUDIT.md) for the
   source-backed findings, its [latest frontend re-audit](docs/DESIGN-FRONTEND-AUDIT.md),
   and [docs/DESIGN-CATALOG.md](docs/DESIGN-CATALOG.md)
   for the catalog's current/proposed classifications. Inspect the relevant
   production component and styles, then the catalog, before editing UI.
3. Reuse the actual production [GenerateButton](src/components/GenerateButton.tsx)
   and [StatefulButton](src/components/StatefulButton.tsx) where those
   specialized actions belong. Preserve their phase, progress and resolution
   behavior. Do not flatten Generate, Export or transport controls into a
   generic 30/26px Button.
4. Keep the task's approved scope. Audit findings and catalog prototypes are
   evidence and review candidates, not permission to migrate production UI.
   The approved production batch is limited to People indicator/details
   accessibility and theater parity, plus Preview's passive Live status and
   Premiere toolbar disclosure. Other catalog proposals remain unadopted.

```bash
npm run design:catalog        # isolated local examples
npm run check:design-catalog  # catalog verification, including build isolation
```

Catalog fixtures must remain isolated: no saved data, native commands,
sessions, device capture or media jobs. See [CONTRIBUTING.md](CONTRIBUTING.md)
for production checks; catalog tests do not replace them.

If guidance conflicts, retain the explicitly approved task scope, use
CLAUDE.md for engineering constraints and DESIGN.md for normative UI rules,
and surface the discrepancy. Do not promote a proposal to a rule silently.
