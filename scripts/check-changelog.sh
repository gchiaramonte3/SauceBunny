#!/usr/bin/env bash
#
# The version in the manifests must have a CHANGELOG entry before it is tagged.
#
# Why this exists: nine semver bumps went out in one day, none tagged, and the
# CHANGELOG ended up with entries for 0.2.1, 0.2.2, 0.2.3, 0.2.9 and 0.3.0 and
# nothing for 0.2.4 through 0.2.8. Nobody noticed, because nothing reads the
# CHANGELOG at build time — it is prose, and prose rots silently.
#
# The rule it enforces is deliberately narrow, so it never blocks ordinary work:
#
#   · A DEV BUILD needs nothing. `npm run release:dmg` with no argument keeps
#     the semver and only re-stamps CFBundleVersion, so there is no new version
#     to describe. That is the common case and it stays frictionless.
#   · A RELEASE needs an entry. The moment the semver moves, the CHANGELOG must
#     have a matching `## [X.Y.Z]` heading — checked here, and again before a
#     tag is pushed.
#
# Run with --strict to also require that the version is not still sitting under
# an [Unreleased] heading.

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
STRICT="${1:-}"

if grep -qE "^## \[${VERSION//./\\.}\]" CHANGELOG.md; then
  echo "✓ CHANGELOG has an entry for ${VERSION}"
else
  cat >&2 <<MSG
✗ CHANGELOG.md has no entry for ${VERSION}

  Add one before releasing:

    ## [${VERSION}] — $(date -u +%Y-%m-%d)

    ### Fixed
    - ...

  A build you are only handing to someone for testing does NOT need this —
  it should not have bumped the semver at all. Use:

    npm run release:dmg          # keeps the semver, re-stamps the build number
MSG
  exit 1
fi

if [ "$STRICT" = "--strict" ]; then
  # Everything above the version's own heading, i.e. [Unreleased] and friends.
  if awk "/^## \[${VERSION//./\\.}\]/{exit} /^- /{n++} END{exit !(n>0)}" CHANGELOG.md; then
    echo "⚠ there are entries above [${VERSION}] — move them in, or they ship undescribed" >&2
    exit 1
  fi
fi

# Explicit, because the last statement above is a conditional whose test is
# FALSE in the common case, and a script's exit status is the status of the
# last command it ran. Without this the check printed a tick and exited 1 —
# the same shape as the `grep -c` and `grep -q` traps in CLAUDE.md's bundling
# gotchas: a command's status leaking out as the script's verdict.
exit 0
