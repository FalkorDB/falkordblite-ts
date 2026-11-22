#!/usr/bin/env bash
# Fetch license texts from the exact Redis and FalkorDB sources being bundled.
#
# Usage: packages/update-license-files.sh <redis_version> <falkordb_version> [platform...]
# Example: packages/update-license-files.sh 8.10.3 v6.2.0
#
# Must be re-run (and the result committed) whenever the bundled versions change.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <redis_version> <falkordb_version> [platform...]" >&2
  exit 1
fi

REDIS_VERSION="$1"
FALKORDB_VERSION="$2"
shift 2

if [[ ! "$REDIS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid redis_version: $REDIS_VERSION" >&2
  exit 1
fi
if [[ ! "$FALKORDB_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid falkordb_version: $FALKORDB_VERSION (expected vX.Y.Z)" >&2
  exit 1
fi

# The dual SSPLv1/AGPLv3 license only applies to FalkorDB >= v6.2.0.
IFS=. read -r fdb_major fdb_minor _ <<<"${FALKORDB_VERSION#v}"
if (( fdb_major < 6 || (fdb_major == 6 && fdb_minor < 2) )); then
  echo "falkordb_version must be >= v6.2.0 (got $FALKORDB_VERSION)" >&2
  exit 1
fi

PACKAGES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -gt 0 ]]; then
  PLATFORMS=("$@")
else
  PLATFORMS=(linux-x64 darwin-arm64)
fi

REDIS_RAW="https://raw.githubusercontent.com/redis/redis/${REDIS_VERSION}"
FALKORDB_RAW="https://raw.githubusercontent.com/FalkorDB/FalkorDB/${FALKORDB_VERSION}"
REDIS_TREE="https://github.com/redis/redis/tree/${REDIS_VERSION}"
FALKORDB_TREE="https://github.com/FalkorDB/FalkorDB/tree/${FALKORDB_VERSION}"
GITHUB_API="https://api.github.com"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fetch() {
  curl --fail --location --silent --show-error -o "$2" "$1"
}

fetch_api() {
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    curl --fail --location --silent --show-error \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" \
      -o "$2" "$1"
  else
    fetch "$1" "$2"
  fi
}

fetch "${REDIS_RAW}/LICENSE.txt" "$TMP_DIR/LICENSE-REDIS.txt"
fetch "${FALKORDB_RAW}/LICENSE" "$TMP_DIR/LICENSE-FALKORDB"
fetch "${FALKORDB_RAW}/LICENSE-SSPL" "$TMP_DIR/LICENSE-SSPL"
fetch "${FALKORDB_RAW}/LICENSE-AGPL" "$TMP_DIR/LICENSE-AGPL"
cp "$TMP_DIR/LICENSE-SSPL" "$TMP_DIR/LICENSE-FALKORDB-SSPL"
cp "$TMP_DIR/LICENSE-AGPL" "$TMP_DIR/LICENSE-FALKORDB-AGPL"

# Sanity-check that the fetched texts are the licenses we describe in LICENSE.
grep -q "Redis Source Available License" "$TMP_DIR/LICENSE-REDIS.txt"
grep -q "Server Side Public License" "$TMP_DIR/LICENSE-REDIS.txt"
grep -q "GNU AFFERO GENERAL PUBLIC LICENSE" "$TMP_DIR/LICENSE-REDIS.txt"
grep -q "Server Side Public License" "$TMP_DIR/LICENSE-SSPL"
grep -q "GNU AFFERO GENERAL PUBLIC LICENSE" "$TMP_DIR/LICENSE-AGPL"

THIRD_PARTY_NOTICES="$TMP_DIR/THIRD-PARTY-NOTICES.txt"
cat >"$THIRD_PARTY_NOTICES" <<EOF
Third-party component notices for the binaries in this package

This file reproduces the upstream license and copyright notices for the
third-party components included in Redis ${REDIS_VERSION} and FalkorDB
${FALKORDB_VERSION}. Source references are given with each notice.
EOF

append_notice() {
  local component="$1"
  local source="$2"
  local file="$3"
  local output="$4"
  printf '\n\n================================================================\n%s\nSource: %s\n================================================================\n\n' \
    "$component" "$source" >>"$output"
  cat "$file" >>"$output"
}

# These are the static archives linked into the redis-server target in
# Redis's src/Makefile. jemalloc is included when that allocator is selected.
redis_notices=(
  "lua|deps/lua/COPYRIGHT"
  "jemalloc|deps/jemalloc/COPYING"
  "hiredis|deps/hiredis/COPYING"
  "hdr_histogram|deps/hdr_histogram/COPYING.txt"
  "hdr_histogram|deps/hdr_histogram/LICENSE.txt"
  "fpconv|deps/fpconv/LICENSE.txt"
  "xxhash|deps/xxhash/LICENSE"
  "tre|deps/tre/LICENSE"
)
for entry in "${redis_notices[@]}"; do
  component="${entry%%|*}"
  path="${entry#*|}"
  license_file="$TMP_DIR/redis-${path//\//-}"
  fetch "${REDIS_RAW}/${path}" "$license_file"
  append_notice "Redis dependency: ${component}" \
    "${REDIS_TREE}/${path}" "$license_file" "$THIRD_PARTY_NOTICES"
done

# FalkorDB records its exact submodule revisions in native-deps.lock.
fetch "${FALKORDB_RAW}/deps/native-deps.lock" "$TMP_DIR/native-deps.lock"
python3 - "$TMP_DIR/native-deps.lock" "$TMP_DIR/falkordb-deps.tsv" <<'PY'
import re
import sys

lockfile, output = sys.argv[1:]
names = ("graphblas", "lagraph", "redisearch")
sections = {}
section = None
with open(lockfile, encoding="utf-8") as source:
    for raw_line in source:
        line = raw_line.strip()
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            sections[section] = {}
        elif section and "=" in line:
            key, value = (part.strip() for part in line.split("=", 1))
            sections[section][key] = value

with open(output, "w", encoding="utf-8") as result:
    for name in names:
        dependency = sections.get(name, {})
        revision = dependency.get("rev", "").strip('"')
        if len(revision) != 40 or any(char not in "0123456789abcdef" for char in revision):
            raise SystemExit(f"Missing or invalid {name} revision in native-deps.lock")
        url = dependency.get("url", "").strip('"')
        if url.endswith(".git"):
            url = url[:-4]
        match = re.fullmatch(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)", url)
        if not match:
            raise SystemExit(f"Missing or invalid {name} repository URL in native-deps.lock")
        repo = match.group(1)
        result.write(f"{name}\t{repo}\t{revision}\n")
PY

dependency_count=0
while IFS=$'\t' read -r name repo revision; do
  tree_file="$TMP_DIR/${name}-tree.json"
  fetch_api "${GITHUB_API}/repos/${repo}/git/trees/${revision}?recursive=1" "$tree_file"
  paths_file="$TMP_DIR/${name}-notice-paths.txt"
  python3 - "$tree_file" >"$paths_file" <<'PY'
import json
import re
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
if data.get("truncated"):
    raise SystemExit("GitHub returned a truncated dependency tree")
name_pattern = re.compile(r"^(license|licence|copying|copyright|notice)([-_.].*)?$", re.I)
text_extensions = {"", ".txt", ".md", ".rst", ".text", ".html"}
for entry in data.get("tree", []):
    if entry.get("type") != "blob":
        continue
    path = entry["path"]
    basename = path.rsplit("/", 1)[-1]
    extension = "." + basename.rsplit(".", 1)[-1] if "." in basename else ""
    if name_pattern.match(basename) and extension.lower() in text_extensions:
        print(path)
PY
  if [[ ! -s "$paths_file" ]]; then
    echo "No text license or notice files found in ${repo}@${revision}" >&2
    exit 1
  fi

  while IFS= read -r path; do
    encoded_path="$(python3 -c 'from urllib.parse import quote; import sys; print(quote(sys.argv[1], safe="/"))' "$path")"
    license_file="$TMP_DIR/${name}-notice-${dependency_count}"
    fetch "https://raw.githubusercontent.com/${repo}/${revision}/${encoded_path}" "$license_file"
    append_notice "FalkorDB dependency: ${name} (${path})" \
      "https://github.com/${repo}/blob/${revision}/${path}" \
      "$license_file" "$THIRD_PARTY_NOTICES"
    dependency_count=$((dependency_count + 1))
  done <"$paths_file"
done <"$TMP_DIR/falkordb-deps.tsv"

cat >"$TMP_DIR/NOTICE" <<EOF
This package redistributes third-party software in binary form. The MIT
license for the separate falkordblite wrapper does not cover these binaries.
Each binary and its embedded dependencies are governed by their own licenses.

bin/redis-server
  Component: Redis ${REDIS_VERSION}
  Copyright: Redis Ltd. and contributors
  License:   RSALv2, SSPLv1 or AGPLv3, at the licensee's choice
             (full text: LICENSE-REDIS.txt)
  Source:    ${REDIS_TREE}
  Archive:   https://github.com/redis/redis/archive/refs/tags/${REDIS_VERSION}.tar.gz
  Built from the source above with: make redis-server
  Static dependency license texts and notices: THIRD-PARTY-NOTICES.txt

bin/falkordb.so
  Component: FalkorDB ${FALKORDB_VERSION}
  Copyright: FalkorDB Ltd. and contributors
  License:   SSPLv1 or AGPLv3, at the licensee's choice
             (license statement: LICENSE-FALKORDB; full texts: LICENSE-SSPL,
             LICENSE-AGPL, LICENSE-FALKORDB-SSPL, LICENSE-FALKORDB-AGPL)
  Source:    ${FALKORDB_TREE}
  Binary:    https://github.com/FalkorDB/FalkorDB/releases/tag/${FALKORDB_VERSION}
  Dependency license texts and notices: THIRD-PARTY-NOTICES.txt
  Dependency revisions are pinned in:
    ${FALKORDB_TREE}/deps/native-deps.lock
EOF

for platform in "${PLATFORMS[@]}"; do
  dest="${PACKAGES_DIR}/${platform}"
  if [[ ! -f "${dest}/package.json" ]]; then
    echo "Unknown platform package: ${platform}" >&2
    exit 1
  fi
  cp "$TMP_DIR"/LICENSE-REDIS.txt "$TMP_DIR"/LICENSE-FALKORDB \
    "$TMP_DIR"/LICENSE-SSPL "$TMP_DIR"/LICENSE-AGPL \
    "$TMP_DIR"/LICENSE-FALKORDB-SSPL "$TMP_DIR"/LICENSE-FALKORDB-AGPL \
    "$THIRD_PARTY_NOTICES" "$TMP_DIR"/NOTICE "$dest/"
  echo "Updated license files in ${dest}"
done
