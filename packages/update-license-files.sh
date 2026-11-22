#!/usr/bin/env bash
# Fetch the license texts of the bundled Redis and FalkorDB releases and
# generate NOTICE for each platform package.
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

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fetch() {
  curl --fail --location --silent --show-error -o "$2" "$1"
}

fetch "${REDIS_RAW}/LICENSE.txt" "$TMP_DIR/LICENSE-REDIS.txt"
fetch "${FALKORDB_RAW}/LICENSE" "$TMP_DIR/LICENSE-FALKORDB"
fetch "${FALKORDB_RAW}/LICENSE-SSPL" "$TMP_DIR/LICENSE-FALKORDB-SSPL"
fetch "${FALKORDB_RAW}/LICENSE-AGPL" "$TMP_DIR/LICENSE-FALKORDB-AGPL"

# Sanity-check that the fetched texts are the licenses we describe in LICENSE.
grep -q "Redis Source Available License" "$TMP_DIR/LICENSE-REDIS.txt"
grep -q "Server Side Public License" "$TMP_DIR/LICENSE-REDIS.txt"
grep -q "GNU AFFERO GENERAL PUBLIC LICENSE" "$TMP_DIR/LICENSE-REDIS.txt"
grep -q "Server Side Public License" "$TMP_DIR/LICENSE-FALKORDB-SSPL"
grep -q "GNU AFFERO GENERAL PUBLIC LICENSE" "$TMP_DIR/LICENSE-FALKORDB-AGPL"

cat >"$TMP_DIR/NOTICE" <<EOF
This package redistributes unmodified third-party software in binary form.
The files listed below are NOT licensed under the MIT license of the
falkordblite wrapper. See LICENSE for the licensing terms.

bin/redis-server
  Component: Redis ${REDIS_VERSION}
  Copyright: Redis Ltd. and contributors
  License:   RSALv2, SSPLv1 or AGPLv3, at the licensee's choice
             (full text: LICENSE-REDIS.txt)
  Source:    ${REDIS_TREE}
  Archive:   https://github.com/redis/redis/archive/refs/tags/${REDIS_VERSION}.tar.gz
  Built from the source above with: make redis-server
  Redis statically links third-party libraries from its deps/ directory
  (e.g. jemalloc, lua, hiredis, linenoise, hdr_histogram, fpconv, xxhash),
  each under its own license; see ${REDIS_TREE}/deps

bin/falkordb.so
  Component: FalkorDB ${FALKORDB_VERSION}
  Copyright: FalkorDB Ltd. and contributors
  License:   SSPLv1 or AGPLv3, at the licensee's choice
             (full texts: LICENSE-FALKORDB, LICENSE-FALKORDB-SSPL,
             LICENSE-FALKORDB-AGPL)
  Source:    ${FALKORDB_TREE}
  Binary:    https://github.com/FalkorDB/FalkorDB/releases/tag/${FALKORDB_VERSION}
  FalkorDB includes third-party components (e.g. GraphBLAS, LAGraph,
  RediSearch) that are subject to their own license terms and notices;
  see ${FALKORDB_TREE}/deps
EOF

for platform in "${PLATFORMS[@]}"; do
  dest="${PACKAGES_DIR}/${platform}"
  if [[ ! -f "${dest}/package.json" ]]; then
    echo "Unknown platform package: ${platform}" >&2
    exit 1
  fi
  cp "$TMP_DIR"/LICENSE-REDIS.txt "$TMP_DIR"/LICENSE-FALKORDB \
    "$TMP_DIR"/LICENSE-FALKORDB-SSPL "$TMP_DIR"/LICENSE-FALKORDB-AGPL \
    "$TMP_DIR"/NOTICE "$dest/"
  echo "Updated license files in ${dest}"
done
