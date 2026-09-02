#!/usr/bin/env bash
# Sync the code of this private repo into the public mirror.
# Copies an explicit allowlist only: no .agent, no docs/superpowers, no
# .superpowers, no deploy files with host paths. Shows the diff and stops;
# pushing is a separate, deliberate step (see README's "Публичное зеркало").
set -euo pipefail

PUBLIC_REMOTE="https://github.com/Crabbb/steam-family-monitor.git"
WORK_DIR="${TMPDIR:-/tmp}/steam-family-monitor-sync"

# Kept in sync by hand with the real tree (see README's "Публичное зеркало"
# for the rationale): `src` and `prisma/schema.prisma` are copied wholesale so
# new modules under them come along automatically; every other path is named
# explicitly and must be added here the day it is introduced.
PATHS=(
  "src"
  "prisma/schema.prisma"
  "prisma.config.ts"
  "docs/development-plan.xml"
  "docs/knowledge-graph.xml"
  "docs/requirements.xml"
  "docs/technology.xml"
  "server.ts"
  "package.json"
  "package-lock.json"
  "tsconfig.json"
  "tsconfig.server.json"
  "next.config.ts"
  "postcss.config.mjs"
  "eslint.config.mjs"
  "jest.config.mjs"
  "jest.setup.mjs"
  "jest.global-setup.mjs"
  "prd.md"
  "AGENTS.md"
  "README.md"
  "LICENSE"
  ".gitattributes"
  ".gitignore"
  ".github"
  ".env.example"
  "Dockerfile"
  "compose.yml"
  ".dockerignore"
  "public"
  "scripts/sync-public.sh"
)

# Dirty only matters inside the paths we copy. A tracked edit or an untracked new file in
# an allowlisted path would silently ship uncommitted work to a public repository; unrelated
# scratch elsewhere in the tree (drafts, local notes) is none of this script's business.
dirty="$(git status --porcelain -- "${PATHS[@]}")"
if [ -n "$dirty" ]; then
  echo "Uncommitted changes inside synced paths. Commit or stash first:" >&2
  echo "$dirty" >&2
  exit 1
fi

rm -rf "$WORK_DIR"
git clone --quiet "$PUBLIC_REMOTE" "$WORK_DIR"

missing=()
for path in "${PATHS[@]}"; do
  if [ ! -e "$path" ]; then
    missing+=("$path")
    echo "Missing in private repo: $path" >&2
    continue
  fi
  rm -rf "${WORK_DIR:?}/$path"
  mkdir -p "$WORK_DIR/$(dirname "$path")"
  cp -a "$path" "$WORK_DIR/$path"
done

# Private-only paths must never appear in the mirror. rm -rf is a no-op on a
# path that does not exist, so it is safe to list entries that were removed
# from the private repo (e.g. the old Dockerfile.deploy/docker-compose.yml)
# alongside ones that still exist — this also strips anything the public
# mirror's own pre-revision history may still be carrying under these names.
rm -rf "$WORK_DIR/.agent" "$WORK_DIR/docs/superpowers" "$WORK_DIR/docs/deploy-vps.md" "$WORK_DIR/.superpowers" \
       "$WORK_DIR/.test" "$WORK_DIR/Dockerfile.deploy" \
       "$WORK_DIR/docker-compose.yml" "$WORK_DIR/compose.override.yml"

cd "$WORK_DIR"
# Stage everything before diffing. A brand-new file (a module that did not
# exist in the mirror before, e.g. the first sync of src/lib/steamHttp.ts) is
# untracked in this fresh clone, and `git diff` — unlike `git diff --cached`
# after `git add` — never looks at untracked files' content at all. Without
# this staging step, both the stat below and the secret scan after it would
# silently skip every new file's content: a false "clean" on exactly the
# files most likely to carry something copy-pasted from a real run.
git add -A
echo "=== diff against the public mirror ==="
git --no-pager diff --cached --stat
echo
echo "=== secret and private-infra scan ==="
# The scanner cannot scan itself: this file contains the very patterns it looks for, so
# including it would make every run report a match and train the reader to ignore the result.
# It is reviewed like any other file in git; it just cannot be its own input.
git --no-pager diff --cached -U0 -- . ':(exclude)scripts/sync-public.sh' | grep -inE "srv/config|[0-9]{9,}:AA|bot[0-9]{8,}|api[_-]?key\"?\s*[:=]\s*\"[^\"]|steamApiKey\"?\s*[:=]\s*\"[^\"]|-----BEGIN" \
  && { echo "Suspicious content in the diff — stop and review." >&2; exit 2; } \
  || echo "clean"

if [ "${#missing[@]}" -gt 0 ]; then
  echo >&2
  echo "Allowlist is stale — fix scripts/sync-public.sh, do not ignore this:" >&2
  for path in "${missing[@]}"; do
    echo "  - $path" >&2
  done
  exit 3
fi

echo
echo "Mirror prepared at: $WORK_DIR"
echo "Everything above is already staged (git add -A). Review the diff by"
echo "hand, then, only with the owner's explicit go-ahead:"
echo "  cd $WORK_DIR && git commit && git push"
