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
REDIS_ARCHIVE="https://github.com/redis/redis/archive/refs/tags/${REDIS_VERSION}.tar.gz"
FALKORDB_TREE="https://github.com/FalkorDB/FalkorDB/tree/${FALKORDB_VERSION}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fetch() {
  curl --fail --location --silent --show-error -o "$2" "$1"
}

fetch "${REDIS_ARCHIVE}" "$TMP_DIR/redis.tar.gz"
fetch "${FALKORDB_RAW}/LICENSE" "$TMP_DIR/LICENSE-FALKORDB"
fetch "${FALKORDB_RAW}/LICENSE-SSPL" "$TMP_DIR/LICENSE-SSPL"
fetch "${FALKORDB_RAW}/LICENSE-AGPL" "$TMP_DIR/LICENSE-AGPL"
fetch "${FALKORDB_RAW}/deps/native-deps.lock" "$TMP_DIR/native-deps.lock"
cp "$TMP_DIR/LICENSE-SSPL" "$TMP_DIR/LICENSE-FALKORDB-SSPL"
cp "$TMP_DIR/LICENSE-AGPL" "$TMP_DIR/LICENSE-FALKORDB-AGPL"

THIRD_PARTY_NOTICES="$TMP_DIR/THIRD-PARTY-NOTICES.txt"

REDIS_VERSION="$REDIS_VERSION" \
FALKORDB_VERSION="$FALKORDB_VERSION" \
REDIS_TREE="$REDIS_TREE" \
TMP_DIR="$TMP_DIR" \
python3 - <<'PY'
from collections import deque
import io
import json
import os
from pathlib import PurePosixPath
import re
import tarfile
from urllib.parse import urljoin
import urllib.request

redis_version = os.environ["REDIS_VERSION"]
falkordb_version = os.environ["FALKORDB_VERSION"]
redis_tree = os.environ["REDIS_TREE"]
tmp_dir = os.environ["TMP_DIR"]
github_token = os.environ.get("GITHUB_TOKEN", "").strip()

COMMENT_BLOCK_RE = re.compile(r"/\*.*?\*/", re.S)
LEADING_CPP_COMMENTS_RE = re.compile(r"\A(?:\s*//[^\n]*\n)+")
STANDALONE_LICENSE_RE = re.compile(
    r"(redistribution and use|permission is hereby granted|permission to use|"
    r"permission is granted|100% public domain|creativecommons\.org/publicdomain|"
    r"author:\s+brad conte|same terms as perl itself)",
    re.I,
)
NOTICE_BASENAME_RE = re.compile(r"^(license|licence|copying|copyright|notice)([-_.].*)?$", re.I)
TEXT_EXTENSIONS = {"", ".txt", ".md", ".rst", ".text", ".html"}


def fetch_bytes(url: str, *, api: bool = False) -> bytes:
    headers = {"User-Agent": "falkordblite-license-updater"}
    if api:
        headers["Accept"] = "application/vnd.github+json"
        if github_token:
            headers["Authorization"] = f"Bearer {github_token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def append_notice(out, component: str, source: str, text: str) -> None:
    cleaned = text.strip("\r\n")
    if not cleaned:
        raise SystemExit(f"Empty notice text for {component} ({source})")
    out.write(
        "\n\n================================================================\n"
        f"{component}\n"
        f"Source: {source}\n"
        "================================================================\n\n"
        f"{cleaned}\n"
    )


def extract_comment_notice(text: str, *, include_tail: bool = False) -> str:
    head_area = "\n".join(text.splitlines()[:120])
    blocks = [b.strip() for b in COMMENT_BLOCK_RE.findall(head_area)]
    cpp_match = LEADING_CPP_COMMENTS_RE.match(head_area)
    if cpp_match:
        blocks.insert(0, cpp_match.group(0).strip())

    matched = [i for i, b in enumerate(blocks) if STANDALONE_LICENSE_RE.search(b)]
    parts = []
    if matched:
        parts.append("\n\n".join(blocks[: matched[-1] + 1]))
    elif include_tail and blocks:
        parts.append(blocks[0])

    if include_tail:
        tail_area = "\n".join(text.splitlines()[-60:])
        tail_blocks = [
            b.strip()
            for b in COMMENT_BLOCK_RE.findall(tail_area)
            if STANDALONE_LICENSE_RE.search(b)
        ]
        if not tail_blocks:
            raise SystemExit("Expected trailing license block not found")
        parts.extend(tail_blocks)

    return "\n\n".join(parts)


def parse_gitmodules(text: str) -> dict[str, str]:
    modules: dict[str, str] = {}
    current: dict[str, str] | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line.startswith("[submodule ") and line.endswith("]"):
            current = {}
        elif current is not None and "=" in line:
            key, value = (part.strip() for part in line.split("=", 1))
            current[key] = value
            if "path" in current and "url" in current:
                modules[current["path"]] = current["url"]
    return modules


def resolve_github_repo(raw_url: str, parent_repo: str) -> str:
    url = raw_url.strip()
    if url.startswith(("./", "../")):
        url = urljoin(f"https://github.com/{parent_repo}/", url)
    elif url.startswith("git@github.com:"):
        url = "https://github.com/" + url[len("git@github.com:") :]
    if url.endswith(".git"):
        url = url[:-4]
    url = url.rstrip("/")
    match = re.fullmatch(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)", url)
    if not match:
        raise SystemExit(f"Unsupported non-GitHub dependency URL: {raw_url}")
    return match.group(1)


def is_notice_path(rel_path: str) -> bool:
    p = PurePosixPath(rel_path)
    basename = p.name
    ext = p.suffix.lower() if "." in basename else ""
    if ext not in TEXT_EXTENSIONS:
        return False
    if NOTICE_BASENAME_RE.match(basename):
        return True
    parent_parts = {part.lower() for part in p.parts[:-1]}
    return bool(parent_parts & {"license", "licenses"})


with open(os.path.join(tmp_dir, "THIRD-PARTY-NOTICES.txt"), "w", encoding="utf-8") as notices_out:
    notices_out.write(
        "Third-party component notices for the binaries in this package\n\n"
        "This file reproduces the upstream license and copyright notices for the\n"
        f"third-party components included in Redis {redis_version} and FalkorDB\n"
        f"{falkordb_version}. Source references are given with each notice.\n"
    )

    # 1. Extract Redis license files, static deps, embedded Lua modules, and src/ notices.
    with tarfile.open(os.path.join(tmp_dir, "redis.tar.gz"), mode="r:gz") as redis_tf:
        prefix = f"redis-{redis_version}/"
        members_by_rel = {
            m.name[len(prefix) :]: m
            for m in redis_tf.getmembers()
            if m.isfile() and m.name.startswith(prefix)
        }

        def read_redis_text(rel_path: str) -> str:
            member = members_by_rel.get(rel_path)
            if member is None:
                raise SystemExit(f"Missing expected file in Redis archive: {rel_path}")
            extracted = redis_tf.extractfile(member)
            if extracted is None:
                raise SystemExit(f"Unable to read file in Redis archive: {rel_path}")
            return extracted.read().decode("utf-8", "replace")

        license_redis = read_redis_text("LICENSE.txt")
        redis_contributions = read_redis_text("REDISCONTRIBUTIONS.txt")
        with open(os.path.join(tmp_dir, "LICENSE-REDIS.txt"), "w", encoding="utf-8") as f:
            f.write(license_redis)
        with open(os.path.join(tmp_dir, "REDISCONTRIBUTIONS.txt"), "w", encoding="utf-8") as f:
            f.write(redis_contributions)

        append_notice(
            notices_out,
            "Redis BSD-3-Clause contributions (REDISCONTRIBUTIONS.txt)",
            f"{redis_tree}/REDISCONTRIBUTIONS.txt",
            redis_contributions,
        )

        # Static archives linked into redis-server in Redis src/Makefile.
        redis_dep_files = [
            ("lua", "deps/lua/COPYRIGHT"),
            ("jemalloc", "deps/jemalloc/COPYING"),
            ("hiredis", "deps/hiredis/COPYING"),
            ("hdr_histogram", "deps/hdr_histogram/COPYING.txt"),
            ("hdr_histogram", "deps/hdr_histogram/LICENSE.txt"),
            ("fpconv", "deps/fpconv/LICENSE.txt"),
            ("xxhash", "deps/xxhash/LICENSE"),
            ("tre", "deps/tre/LICENSE"),
        ]
        for component, rel_path in redis_dep_files:
            append_notice(
                notices_out,
                f"Redis dependency: {component} ({rel_path})",
                f"{redis_tree}/{rel_path}",
                read_redis_text(rel_path),
            )

        # Embedded third-party modules compiled into deps/lua/src/liblua.a.
        lua_embedded_files = [
            ("lua (Lua CJSON)", "deps/lua/src/lua_cjson.c", False),
            ("lua (Lua CJSON strbuf)", "deps/lua/src/strbuf.c", False),
            ("lua (Lua CJSON strbuf)", "deps/lua/src/strbuf.h", False),
            ("lua (Lua CJSON fpconv)", "deps/lua/src/fpconv.c", False),
            ("lua (Lua BitOp)", "deps/lua/src/lua_bit.c", False),
            ("lua (lua-cmsgpack)", "deps/lua/src/lua_cmsgpack.c", True),
            ("lua (lua_struct)", "deps/lua/src/lua_struct.c", True),
        ]
        for component, rel_path, include_tail in lua_embedded_files:
            notice_text = extract_comment_notice(
                read_redis_text(rel_path), include_tail=include_tail
            )
            if not notice_text:
                raise SystemExit(f"Failed to extract notice from Redis {rel_path}")
            append_notice(
                notices_out,
                f"Redis dependency: {component} ({rel_path})",
                f"{redis_tree}/{rel_path}",
                notice_text,
            )

        # Third-party and permissive-licensed files compiled directly from Redis src/.
        src_captured: set[str] = set()
        for rel_path in sorted(members_by_rel):
            if not rel_path.startswith("src/") or rel_path.startswith(
                ("src/modules/", "src/commands/")
            ):
                continue
            if not rel_path.endswith((".c", ".h")):
                continue
            raw_text = read_redis_text(rel_path)
            if "Redis Source Available License" in "\n".join(raw_text.splitlines()[:120]):
                continue
            notice_text = extract_comment_notice(raw_text)
            if not notice_text:
                continue
            src_captured.add(rel_path)
            append_notice(
                notices_out,
                f"Redis source component: {rel_path}",
                f"{redis_tree}/{rel_path}",
                notice_text,
            )

        required_src = {
            "src/lzf_c.c",
            "src/lzf_d.c",
            "src/pqsort.c",
            "src/mt19937-64.c",
            "src/fast_float_strtod.c",
            "src/strl.c",
        }
        missing_src = required_src - src_captured
        if missing_src:
            raise SystemExit(f"Missing expected Redis src/ notices: {sorted(missing_src)}")

    # 2. Parse FalkorDB native-deps.lock and recursively traverse submodules.
    sections: dict[str, dict[str, str]] = {}
    section = None
    with open(os.path.join(tmp_dir, "native-deps.lock"), encoding="utf-8") as lock_in:
        for raw_line in lock_in:
            line = raw_line.strip()
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1]
                sections[section] = {}
            elif section and "=" in line:
                key, value = (part.strip() for part in line.split("=", 1))
                sections[section][key] = value

    queue: deque[tuple[str, str, str]] = deque()
    for dep_name in ("graphblas", "lagraph", "redisearch"):
        dep = sections.get(dep_name, {})
        rev = dep.get("rev", "").strip('"')
        if not re.fullmatch(r"[0-9a-f]{40}", rev):
            raise SystemExit(f"Missing or invalid {dep_name} revision in native-deps.lock")
        repo = resolve_github_repo(dep.get("url", "").strip('"'), "FalkorDB/FalkorDB")
        queue.append((dep_name, repo, rev))

    visited: set[tuple[str, str]] = set()
    while queue:
        label, repo, rev = queue.popleft()
        if (repo, rev) in visited:
            continue
        visited.add((repo, rev))

        archive_bytes = fetch_bytes(f"https://github.com/{repo}/archive/{rev}.tar.gz")
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as dep_tf:
            members = [m for m in dep_tf.getmembers() if m.isfile()]
            if not members:
                raise SystemExit(f"Empty archive for {repo}@{rev}")
            root_prefix = members[0].name.split("/", 1)[0] + "/"
            rel_members = {
                m.name[len(root_prefix) :]: m
                for m in members
                if m.name.startswith(root_prefix)
            }

            def read_dep_text(rel_path: str) -> str:
                fobj = dep_tf.extractfile(rel_members[rel_path])
                if fobj is None:
                    raise SystemExit(f"Unable to read {rel_path} in {repo}@{rev}")
                return fobj.read().decode("utf-8", "replace")

            notice_paths = [p for p in sorted(rel_members) if is_notice_path(p)]
            if not notice_paths:
                raise SystemExit(f"No text license or notice files found in {repo}@{rev}")

            covered_dep_dirs: set[str] = set()
            for rel_path in notice_paths:
                parts = PurePosixPath(rel_path).parts
                if len(parts) >= 2 and parts[0] == "deps":
                    covered_dep_dirs.add(parts[1])
                append_notice(
                    notices_out,
                    f"FalkorDB dependency: {label} ({rel_path})",
                    f"https://github.com/{repo}/blob/{rev}/{rel_path}",
                    read_dep_text(rel_path),
                )

            submodule_paths: set[str] = set()
            if ".gitmodules" in rel_members:
                gitmodules_map = parse_gitmodules(read_dep_text(".gitmodules"))
                tree_data = json.loads(
                    fetch_bytes(
                        f"https://api.github.com/repos/{repo}/git/trees/{rev}?recursive=1",
                        api=True,
                    ).decode("utf-8")
                )
                if tree_data.get("truncated"):
                    raise SystemExit(f"GitHub returned a truncated tree for {repo}@{rev}")
                for entry in tree_data.get("tree", []):
                    if entry.get("type") != "commit":
                        continue
                    sub_path = entry["path"]
                    sub_sha = entry["sha"]
                    if not re.fullmatch(r"[0-9a-f]{40}", sub_sha):
                        raise SystemExit(f"Invalid submodule SHA for {repo}:{sub_path}")
                    if sub_path not in gitmodules_map:
                        raise SystemExit(
                            f"Submodule {sub_path} in {repo}@{rev} missing from .gitmodules"
                        )
                    sub_repo = resolve_github_repo(gitmodules_map[sub_path], repo)
                    submodule_paths.add(sub_path)
                    queue.append((f"{label}/{sub_path}", sub_repo, sub_sha))

            # Also capture embedded notices in vendored deps/<subdir>/ trees that have
            # no standalone LICENSE/COPYING file (e.g. RediSearch fast_float, geohash, phonetics).
            vendored_dirs = sorted(
                {
                    PurePosixPath(p).parts[1]
                    for p in rel_members
                    if len(PurePosixPath(p).parts) >= 3
                    and PurePosixPath(p).parts[0] == "deps"
                    and f"deps/{PurePosixPath(p).parts[1]}" not in submodule_paths
                    and PurePosixPath(p).parts[1] not in covered_dep_dirs
                }
            )
            for vdir in vendored_dirs:
                seen_Snippets: set[str] = set()
                for rel_path in sorted(rel_members):
                    if not rel_path.startswith(f"deps/{vdir}/"):
                        continue
                    fname = PurePosixPath(rel_path).name
                    if fname.lower().startswith("readme"):
                        readme_txt = read_dep_text(rel_path)
                        if re.search(r"copyright|license", readme_txt, re.I):
                            append_notice(
                                notices_out,
                                f"FalkorDB dependency: {label} ({rel_path})",
                                f"https://github.com/{repo}/blob/{rev}/{rel_path}",
                                readme_txt,
                            )
                    elif rel_path.endswith((".c", ".h", ".hpp", ".cc", ".cpp")):
                        src_txt = read_dep_text(rel_path)
                        head120 = "\n".join(src_txt.splitlines()[:120])
                        if "Redis Source Available License" in head120:
                            continue
                        snippet = extract_comment_notice(src_txt)
                        if snippet and snippet not in seen_Snippets:
                            seen_Snippets.add(snippet)
                            append_notice(
                                notices_out,
                                f"FalkorDB dependency: {label} ({rel_path})",
                                f"https://github.com/{repo}/blob/{rev}/{rel_path}",
                                snippet,
                            )
PY

# Sanity-check that the fetched and generated texts match what LICENSE describes.
grep -q "Redis Source Available License" "$TMP_DIR/LICENSE-REDIS.txt"
grep -q "Server Side Public License" "$TMP_DIR/LICENSE-REDIS.txt"
grep -q "GNU AFFERO GENERAL PUBLIC LICENSE" "$TMP_DIR/LICENSE-REDIS.txt"
grep -q "BSD-3-Clause License" "$TMP_DIR/REDISCONTRIBUTIONS.txt"
grep -q "Server Side Public License" "$TMP_DIR/LICENSE-SSPL"
grep -q "GNU AFFERO GENERAL PUBLIC LICENSE" "$TMP_DIR/LICENSE-AGPL"
grep -q "Lua CJSON" "$THIRD_PARTY_NOTICES"
grep -q "Lua BitOp" "$THIRD_PARTY_NOTICES"
grep -q "Marc Alexander Lehmann" "$THIRD_PARTY_NOTICES"
grep -q "libuv" "$THIRD_PARTY_NOTICES"

cat >"$TMP_DIR/NOTICE" <<EOF
This package redistributes third-party software in binary form. The MIT
license for the separate falkordblite wrapper does not cover these binaries.
Each binary and its embedded dependencies are governed by their own licenses.

bin/redis-server
  Component: Redis ${REDIS_VERSION}
  Copyright: Redis Ltd. and contributors
  License:   RSALv2, SSPLv1 or AGPLv3, at the licensee's choice
             (full text: LICENSE-REDIS.txt; BSD-3-Clause portions:
             REDISCONTRIBUTIONS.txt)
  Source:    ${REDIS_TREE}
  Archive:   ${REDIS_ARCHIVE}
  Built from the source above with: make redis-server
  Embedded and static dependency notices: THIRD-PARTY-NOTICES.txt

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
  if [[ ! "${platform}" =~ ^[a-z0-9-]+$ ]]; then
    echo "Invalid platform name: ${platform}" >&2
    exit 1
  fi
  dest="${PACKAGES_DIR}/${platform}"
  if [[ ! -f "${dest}/package.json" ]]; then
    echo "Unknown platform package: ${platform}" >&2
    exit 1
  fi
  cp "$TMP_DIR"/LICENSE-REDIS.txt "$TMP_DIR"/REDISCONTRIBUTIONS.txt \
    "$TMP_DIR"/LICENSE-FALKORDB "$TMP_DIR"/LICENSE-SSPL "$TMP_DIR"/LICENSE-AGPL \
    "$TMP_DIR"/LICENSE-FALKORDB-SSPL "$TMP_DIR"/LICENSE-FALKORDB-AGPL \
    "$THIRD_PARTY_NOTICES" "$TMP_DIR"/NOTICE "$dest/"
  echo "Updated license files in ${dest}"
done
