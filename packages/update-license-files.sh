#!/usr/bin/env bash
# Fetch license texts from the exact Redis and FalkorDB sources being bundled.
#
# Usage: packages/update-license-files.sh <redis_version> <falkordb_version> [platform...]
# Example: packages/update-license-files.sh 8.10.3 v6.2.0
# Requires: Redis >= 8.0.0, FalkorDB >= v6.2.0, curl, Python >= 3.9, and cargo.
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
MACOS_LLVM_VERSION="${MACOS_LLVM_VERSION:-23.1.5}"
MACOS_OPENSSL_VERSION="${MACOS_OPENSSL_VERSION:-3.5.9}"
LINUX_LLVM_VERSION="${LINUX_LLVM_VERSION:-23.1.6}"

if [[ ! "$REDIS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid redis_version: $REDIS_VERSION" >&2
  exit 1
fi
if [[ ! "$FALKORDB_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid falkordb_version: $FALKORDB_VERSION (expected vX.Y.Z)" >&2
  exit 1
fi

# Platform LICENSE documents Redis 8.x's RSALv2/SSPLv1/AGPLv3 tri-license.
IFS=. read -r redis_major _ _ <<<"${REDIS_VERSION}"
if (( redis_major < 8 )); then
  echo "redis_version must be >= 8.0.0 (got $REDIS_VERSION)" >&2
  exit 1
fi

# The dual SSPLv1/AGPLv3 license only applies to FalkorDB >= v6.2.0.
IFS=. read -r fdb_major fdb_minor _ <<<"${FALKORDB_VERSION#v}"
if (( fdb_major < 6 || (fdb_major == 6 && fdb_minor < 2) )); then
  echo "falkordb_version must be >= v6.2.0 (got $FALKORDB_VERSION)" >&2
  exit 1
fi

for required_cmd in curl python3 cargo; do
  if ! command -v "${required_cmd}" >/dev/null 2>&1; then
    echo "Missing required tool: ${required_cmd}" >&2
    exit 1
  fi
done

cargo_version_output="$(cargo --version)"
if [[ ! "${cargo_version_output}" =~ ^cargo[[:space:]]+([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  echo "Unable to determine Cargo version from: ${cargo_version_output}" >&2
  exit 1
fi
cargo_major="${BASH_REMATCH[1]}"
cargo_minor="${BASH_REMATCH[2]}"
if (( cargo_major < 1 || (cargo_major == 1 && cargo_minor < 85) )); then
  echo "Cargo 1.85.0 or later is required (found ${cargo_version_output})." >&2
  exit 1
fi

if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))'; then
  echo "Python 3.9 or later is required for python3." >&2
  exit 1
fi

PACKAGES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -gt 0 ]]; then
  PLATFORMS=("$@")
else
  PLATFORMS=(linux-x64 darwin-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
  if [[ ! "${platform}" =~ ^[a-z0-9-]+$ ]]; then
    echo "Invalid platform name: ${platform}" >&2
    exit 1
  fi
  if [[ ! -f "${PACKAGES_DIR}/${platform}/package.json" ]]; then
    echo "Unknown platform package: ${platform}" >&2
    exit 1
  fi
  case "${platform}" in
    linux-x64|darwin-arm64) ;;
    *)
      echo "Unsupported platform target mapping for: ${platform}" >&2
      exit 1
      ;;
  esac
done

REDIS_TREE="https://github.com/redis/redis/tree/${REDIS_VERSION}"
REDIS_ARCHIVE="https://github.com/redis/redis/archive/refs/tags/${REDIS_VERSION}.tar.gz"
FALKORDB_TREE="https://github.com/FalkorDB/FalkorDB/tree/${FALKORDB_VERSION}"
FALKORDB_ARCHIVE="https://github.com/FalkorDB/FalkorDB/archive/refs/tags/${FALKORDB_VERSION}.tar.gz"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fetch() {
  curl --fail --location --silent --show-error -o "$2" "$1"
}

fetch "${REDIS_ARCHIVE}" "$TMP_DIR/redis.tar.gz"
fetch "${FALKORDB_ARCHIVE}" "$TMP_DIR/falkordb.tar.gz"

REDIS_VERSION="$REDIS_VERSION" \
FALKORDB_VERSION="$FALKORDB_VERSION" \
MACOS_LLVM_VERSION="$MACOS_LLVM_VERSION" \
MACOS_OPENSSL_VERSION="$MACOS_OPENSSL_VERSION" \
LINUX_LLVM_VERSION="$LINUX_LLVM_VERSION" \
REDIS_TREE="$REDIS_TREE" \
TMP_DIR="$TMP_DIR" \
PLATFORMS_CSV="$(IFS=,; echo "${PLATFORMS[*]}")" \
python3 - <<'PY'
from __future__ import annotations

from collections import deque
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
from pathlib import PurePosixPath
import re
import subprocess
import tarfile
import tempfile
import threading
from urllib.parse import urljoin
from urllib.error import HTTPError
import urllib.request

redis_version = os.environ["REDIS_VERSION"]
falkordb_version = os.environ["FALKORDB_VERSION"]
macos_llvm_version = os.environ["MACOS_LLVM_VERSION"]
macos_openssl_version = os.environ["MACOS_OPENSSL_VERSION"]
linux_llvm_version = os.environ["LINUX_LLVM_VERSION"]
redis_tree = os.environ["REDIS_TREE"]
tmp_dir = os.environ["TMP_DIR"]
platforms = [p for p in os.environ["PLATFORMS_CSV"].split(",") if p]
github_token = os.environ.get("GITHUB_TOKEN", "").strip()

PLATFORM_TARGETS = {
    "linux-x64": "x86_64-unknown-linux-gnu",
    "darwin-arm64": "aarch64-apple-darwin",
}
CRATES_IO_REGISTRY_SOURCES = {
    "registry+https://github.com/rust-lang/crates.io-index",
    "registry+https://index.crates.io",
    "registry+https://index.crates.io/",
}

COMMENT_BLOCK_RE = re.compile(r"/\*.*?\*/", re.S)
LEADING_CPP_COMMENTS_RE = re.compile(r"\A(?:\s*//[^\n]*\n)+")
STANDALONE_LICENSE_RE = re.compile(
    r"(redistribution and use|permission is hereby granted|permission to use|"
    r"permission is granted|100% public domain|creativecommons\.org/publicdomain|"
    r"author:\s+brad conte|same terms as perl itself|apache license,?\s+version\s+2\.0|"
    r"spdx-license-identifier)",
    re.I,
)
NOTICE_BASENAME_RE = re.compile(
    r"^(license|licence|copying|copyright|notice|unlicense)([-_.].*)?$", re.I
)
TEXT_EXTENSIONS = {
    "",
    ".txt",
    ".md",
    ".rst",
    ".text",
    ".html",
    ".bsd-3-clause",
    ".apache",
    ".mit",
    ".mpl",
    ".isc",
}


def fetch_bytes(url: str, *, api: bool = False) -> bytes:
    headers = {"User-Agent": "falkordblite-license-updater"}
    if api:
        headers["Accept"] = "application/vnd.github+json"
        if github_token:
            headers["Authorization"] = f"Bearer {github_token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def format_notice(component: str, source: str, text: str) -> str:
    cleaned = "\n".join(line.rstrip(" \t") for line in text.splitlines()).strip("\n")
    if not cleaned:
        raise SystemExit(f"Empty notice text for {component} ({source})")
    return (
        "\n\n================================================================\n"
        f"{component}\n"
        f"Source: {source}\n"
        "================================================================\n\n"
        f"{cleaned}\n"
    )


def maybe_annotate_malformed_agpl(rel_path: str, text: str) -> str:
    basename = PurePosixPath(rel_path).name.lower()
    if "agpl" not in basename:
        return text
    head_lines = "\n".join(text.splitlines()[:10])
    # Upstream RedisAI/VectorSimilarity license/AGPLv3.txt has an AGPLv3 heading
    # ("19 Nov 2007") followed by the GPLv3 body and GPLv3 Section 13 ("13. Use
    # with the GNU Affero General Public License.") instead of AGPLv3 Section 13.
    if (
        "GNU AFFERO GENERAL PUBLIC LICENSE" in head_lines.upper()
        and "13. Use with the GNU Affero General Public License." in text
        and "13. Remote Network Interaction" not in text
    ):
        note = (
            "[Note: This upstream file carries an AGPLv3 heading, but its body "
            "reproduces the GNU General Public License v3 (including GPLv3 "
            "Section 13) rather than the GNU Affero General Public License v3 "
            "(AGPLv3 Section 13: Remote Network Interaction). The upstream file "
            "is reproduced unchanged below. For the canonical AGPLv3 text, see "
            "LICENSE-AGPL and LICENSE-REDIS.txt in this package.]\n\n"
        )
        return note + text
    return text


def safe_extract_tar_regular_files(tf: tarfile.TarFile, dest_dir: str) -> str:
    real_dest = os.path.realpath(dest_dir)
    roots: set[str] = set()
    for member in tf.getmembers():
        if not member.isfile():
            continue
        parts = PurePosixPath(member.name).parts
        if not parts or ".." in parts or parts[0].startswith("/"):
            raise SystemExit(f"Unsafe archive member path: {member.name}")
        roots.add(parts[0])
        target_path = os.path.realpath(os.path.join(real_dest, *parts))
        if os.path.commonpath([real_dest, target_path]) != real_dest:
            raise SystemExit(f"Archive path escapes destination: {member.name}")
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        extracted = tf.extractfile(member)
        if extracted is None:
            raise SystemExit(f"Unable to extract {member.name}")
        with open(target_path, "wb") as out_f:
            out_f.write(extracted.read())
    if len(roots) != 1:
        raise SystemExit(f"Expected single archive root directory, got: {sorted(roots)}")
    return os.path.join(real_dest, next(iter(roots)))


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


def resolve_github_repo(raw_url: str, parent_repo: str | None = None) -> str:
    url = raw_url.strip()
    if url.startswith(("./", "../")):
        if not parent_repo:
            raise SystemExit(f"Cannot resolve relative URL without parent: {raw_url}")
        url = urljoin(f"https://github.com/{parent_repo}/", url)
    elif url.startswith("git@github.com:"):
        url = "https://github.com/" + url[len("git@github.com:") :]
    if url.endswith(".git"):
        url = url[:-4]
    url = url.rstrip("/")
    match = re.match(r"^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)", url)
    if not match:
        raise SystemExit(f"Unsupported non-GitHub dependency URL: {raw_url}")
    return match.group(1)


def is_notice_path(rel_path: str) -> bool:
    p = PurePosixPath(rel_path)
    basename = p.name
    ext = p.suffix.lower() if "." in basename else ""
    if ext not in TEXT_EXTENSIONS and not NOTICE_BASENAME_RE.match(basename):
        return False
    if ext in {".c", ".cc", ".cpp", ".h", ".hpp", ".rs", ".py", ".sh", ".toml", ".json", ".lock"}:
        return False
    if NOTICE_BASENAME_RE.match(basename):
        return True
    parent_parts = {part.lower() for part in p.parts[:-1]}
    return bool(parent_parts & {"license", "licenses"}) and ext in TEXT_EXTENSIONS


def is_license_file(rel_path: str) -> bool:
    return bool(
        re.match(
            r"^(license|licence|copying|unlicense)([-_.].*)?$",
            PurePosixPath(rel_path).name,
            re.I,
        )
    )


def parse_cargo_lock_sources(
    lock_text: str,
) -> dict[tuple[str, str], set[str | None]]:
    out: dict[tuple[str, str], set[str | None]] = {}
    for block in lock_text.split("\n[[package]]\n")[1:]:
        m_name = re.search(r'^name\s*=\s*"([^"]+)"', block, re.M)
        m_ver = re.search(r'^version\s*=\s*"([^"]+)"', block, re.M)
        if not m_name or not m_ver:
            continue
        m_src = re.search(r'^source\s*=\s*"([^"]+)"', block, re.M)
        out.setdefault((m_name.group(1), m_ver.group(1)), set()).add(
            m_src.group(1) if m_src else None
        )
    return out


def resolve_cargo_runtime_crates(
    workspace_dir: str, package_name: str, target_triple: str
) -> set[tuple[str, str, str]]:
    lock_path = os.path.join(workspace_dir, "Cargo.lock")
    with open(lock_path, encoding="utf-8") as f:
        lock_sources = parse_cargo_lock_sources(f.read())
    output = subprocess.check_output(
        [
            "cargo",
            "tree",
            "-p",
            package_name,
            "--edges",
            "normal,no-proc-macro",
            "--target",
            target_triple,
            "--prefix",
            "none",
            "--locked",
        ],
        cwd=workspace_dir,
        text=True,
    )
    resolved: set[tuple[str, str, str]] = set()
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if line.endswith(" (*)"):
            line = line[:-4].rstrip()
        match = re.match(r"^(\S+)\s+v(\S+)(?:\s+\((.+)\))?$", line)
        if not match:
            continue
        name, version, displayed_source = match.groups()
        key = (name, version)
        candidates = lock_sources.get(key, set())
        if displayed_source and displayed_source != "*":
            if displayed_source.startswith(("/", "file://")):
                continue
            matches = {
                source
                for source in candidates
                if source is not None
                and source.removeprefix("git+").startswith(displayed_source)
            }
            if len(matches) != 1:
                raise SystemExit(
                    f"Unable to match cargo tree package source for {name} {version}: "
                    f"{displayed_source} (locked sources: {sorted(str(s) for s in candidates)})"
                )
            source = matches.pop()
        else:
            registry_sources = candidates & CRATES_IO_REGISTRY_SOURCES
            if len(registry_sources) == 1:
                source = next(iter(registry_sources))
            elif len(candidates) == 1:
                source = next(iter(candidates))
            elif candidates:
                raise SystemExit(
                    f"Ambiguous locked sources for cargo tree package {name} {version}: "
                    f"{sorted(str(s) for s in candidates)}"
                )
            else:
                continue
        if source is not None:
            resolved.add((name, version, source))
    if not resolved:
        raise SystemExit(
            f"cargo tree resolved zero external runtime crates for {package_name} ({target_triple})"
        )
    return resolved


common_sections: list[str] = []
linux_sections: list[str] = []
macos_sections: list[str] = []

if "linux-x64" in platforms:
    if not re.fullmatch(r"\d+\.\d+\.\d+", linux_llvm_version):
        raise SystemExit(f"Invalid Linux LLVM version: {linux_llvm_version}")
if "darwin-arm64" in platforms:
    if not re.fullmatch(r"\d+\.\d+\.\d+", macos_llvm_version):
        raise SystemExit(f"Invalid macOS LLVM version: {macos_llvm_version}")
    if not re.fullmatch(r"\d+\.\d+\.\d+", macos_openssl_version):
        raise SystemExit(f"Invalid macOS OpenSSL version: {macos_openssl_version}")

# 1. Extract Redis license files, dynamically discovered deps/*, embedded Lua modules, and src/.
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

    common_sections.append(
        format_notice(
            "Redis BSD-3-Clause contributions (REDISCONTRIBUTIONS.txt)",
            f"{redis_tree}/REDISCONTRIBUTIONS.txt",
            redis_contributions,
        )
    )

    redis_dep_dirs = sorted(
        {
            PurePosixPath(rel_path).parts[1]
            for rel_path in members_by_rel
            if len(PurePosixPath(rel_path).parts) >= 3
            and PurePosixPath(rel_path).parts[0] == "deps"
        }
    )
    required_redis_deps = {"fpconv", "hdr_histogram", "hiredis", "jemalloc", "linenoise", "lua"}
    missing_redis_deps = required_redis_deps - set(redis_dep_dirs)
    if missing_redis_deps:
        raise SystemExit(
            f"Missing expected Redis deps/ directories: {sorted(missing_redis_deps)}"
        )

    for dep_dir in redis_dep_dirs:
        dep_prefix = f"deps/{dep_dir}/"
        dep_notice_files = [
            rel_path
            for rel_path in sorted(members_by_rel)
            if rel_path.startswith(dep_prefix)
            and not any(
                seg in {"test", "tests", "example", "examples", "bench", "benches"}
                for seg in PurePosixPath(rel_path).parts[2:-1]
            )
            and is_notice_path(rel_path)
        ]
        if dep_notice_files:
            for rel_path in dep_notice_files:
                common_sections.append(
                    format_notice(
                        f"Redis dependency: {dep_dir} ({rel_path})",
                        f"{redis_tree}/{rel_path}",
                        read_redis_text(rel_path),
                    )
                )
        else:
            seen_dep_snippets: set[str] = set()
            for rel_path in sorted(members_by_rel):
                if not rel_path.startswith(dep_prefix):
                    continue
                fname = PurePosixPath(rel_path).name
                if fname.lower().startswith("readme"):
                    readme_txt = read_redis_text(rel_path)
                    if re.search(r"copyright|license", readme_txt, re.I):
                        seen_dep_snippets.add(rel_path)
                        common_sections.append(
                            format_notice(
                                f"Redis dependency: {dep_dir} ({rel_path})",
                                f"{redis_tree}/{rel_path}",
                                readme_txt,
                            )
                        )
                elif rel_path.endswith((".c", ".h", ".hpp", ".cc", ".cpp")):
                    snippet = extract_comment_notice(read_redis_text(rel_path))
                    if snippet and snippet not in seen_dep_snippets:
                        seen_dep_snippets.add(snippet)
                        common_sections.append(
                            format_notice(
                                f"Redis dependency: {dep_dir} ({rel_path})",
                                f"{redis_tree}/{rel_path}",
                                snippet,
                            )
                        )
            if not seen_dep_snippets:
                raise SystemExit(
                    f"No license or copyright notice found for Redis deps/{dep_dir}"
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
        common_sections.append(
            format_notice(
                f"Redis dependency: {component} ({rel_path})",
                f"{redis_tree}/{rel_path}",
                notice_text,
            )
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
        common_sections.append(
            format_notice(
                f"Redis source component: {rel_path}",
                f"{redis_tree}/{rel_path}",
                notice_text,
            )
        )

    required_src = {
        "src/lzf_c.c",
        "src/lzf_d.c",
        "src/pqsort.c",
        "src/mt19937-64.c",
        "src/strl.c",
    }
    missing_src = required_src - src_captured
    if missing_src:
        raise SystemExit(f"Missing expected Redis src/ notices: {sorted(missing_src)}")
    if "src/fast_float_strtod.c" not in src_captured and "fast_float" not in redis_dep_dirs:
        raise SystemExit("Missing fast_float notice in Redis src/ or deps/")

# 2. Extract FalkorDB source archive, top-level licenses, and Cargo tree.
falkordb_extract_parent = os.path.join(tmp_dir, "falkordb-src")
os.makedirs(falkordb_extract_parent, exist_ok=True)
with tarfile.open(os.path.join(tmp_dir, "falkordb.tar.gz"), mode="r:gz") as fdb_tf:
    falkordb_src_root = safe_extract_tar_regular_files(fdb_tf, falkordb_extract_parent)

for src_name, dst_name in [
    ("LICENSE", "LICENSE-FALKORDB"),
    ("LICENSE-SSPL", "LICENSE-SSPL"),
    ("LICENSE-AGPL", "LICENSE-AGPL"),
    ("LICENSE-SSPL", "LICENSE-FALKORDB-SSPL"),
    ("LICENSE-AGPL", "LICENSE-FALKORDB-AGPL"),
]:
    src_path = os.path.join(falkordb_src_root, src_name)
    if not os.path.isfile(src_path):
        raise SystemExit(f"Missing expected file in FalkorDB archive: {src_name}")
    with open(src_path, "rb") as rf, open(os.path.join(tmp_dir, dst_name), "wb") as wf:
        wf.write(rf.read())

# Both modules statically link LLVM OpenMP. The macOS module additionally
# statically links LLVM libc++/libc++abi and Homebrew OpenSSL. Versions below
# were recorded by the FalkorDB v6.2.0 build jobs.
if "linux-x64" in platforms:
    linux_llvm_tag = f"llvmorg-{linux_llvm_version}"
    linux_openmp_path = "openmp/LICENSE.TXT"
    linux_openmp_url = (
        f"https://raw.githubusercontent.com/llvm/llvm-project/"
        f"{linux_llvm_tag}/{linux_openmp_path}"
    )
    linux_sections.append(
        format_notice(
            f"FalkorDB Linux static runtime dependency: LLVM OpenMP (libomp.a) "
            f"(LLVM {linux_llvm_version})",
            f"https://github.com/llvm/llvm-project/blob/"
            f"{linux_llvm_tag}/{linux_openmp_path}",
            fetch_bytes(linux_openmp_url).decode("utf-8", "replace"),
        )
    )

if "darwin-arm64" in platforms:
    llvm_tag = f"llvmorg-{macos_llvm_version}"
    for component, source_path in (
        ("libc++", "libcxx/LICENSE.TXT"),
        ("libc++abi", "libcxxabi/LICENSE.TXT"),
        ("LLVM OpenMP (libomp.a)", "openmp/LICENSE.TXT"),
    ):
        source_url = (
            f"https://raw.githubusercontent.com/llvm/llvm-project/{llvm_tag}/{source_path}"
        )
        macos_sections.append(
            format_notice(
                f"FalkorDB macOS static runtime dependency: {component} "
                f"(LLVM {macos_llvm_version})",
                f"https://github.com/llvm/llvm-project/blob/{llvm_tag}/{source_path}",
                fetch_bytes(source_url).decode("utf-8", "replace"),
            )
        )

    openssl_tag = f"openssl-{macos_openssl_version}"
    openssl_license_url = (
        f"https://raw.githubusercontent.com/openssl/openssl/{openssl_tag}/LICENSE.txt"
    )
    macos_sections.append(
        format_notice(
            f"FalkorDB macOS static runtime dependency: OpenSSL {macos_openssl_version} "
            "(libssl.a and libcrypto.a)",
            f"https://github.com/openssl/openssl/blob/{openssl_tag}/LICENSE.txt",
            fetch_bytes(openssl_license_url).decode("utf-8", "replace"),
        )
    )

# 3. Parse FalkorDB deps/native-deps.lock and recursively traverse C/C++ deps and submodules.
sections: dict[str, dict[str, str]] = {}
section = None
with open(
    os.path.join(falkordb_src_root, "deps", "native-deps.lock"), encoding="utf-8"
) as lock_in:
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

redisearch_rust_workspace: str | None = None
visited: set[tuple[str, str]] = set()
while queue:
    label, repo, rev = queue.popleft()
    if (repo, rev) in visited:
        continue
    visited.add((repo, rev))

    archive_bytes = fetch_bytes(f"https://github.com/{repo}/archive/{rev}.tar.gz")
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as dep_tf:
        if label == "redisearch":
            rs_extract_parent = os.path.join(tmp_dir, "redisearch-src")
            os.makedirs(rs_extract_parent, exist_ok=True)
            rs_root = safe_extract_tar_regular_files(dep_tf, rs_extract_parent)
            candidate_ws = os.path.join(rs_root, "src", "redisearch_rs")
            if os.path.isfile(os.path.join(candidate_ws, "Cargo.lock")):
                redisearch_rust_workspace = candidate_ws

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

        excluded_notice_dirs = {
            "test",
            "tests",
            "json_test",
            "example",
            "examples",
            "bench",
            "benches",
        }
        covered_dep_dirs: set[str] = set()
        for rel_path in notice_paths:
            parts = PurePosixPath(rel_path).parts
            if (
                len(parts) >= 2
                and parts[0] == "deps"
                and not any(part.lower() in excluded_notice_dirs for part in parts[2:-1])
            ):
                covered_dep_dirs.add(parts[1])
            dep_text = maybe_annotate_malformed_agpl(rel_path, read_dep_text(rel_path))
            common_sections.append(
                format_notice(
                    f"FalkorDB dependency: {label} ({rel_path})",
                    f"https://github.com/{repo}/blob/{rev}/{rel_path}",
                    dep_text,
                )
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

        # Capture embedded notices in vendored deps/<subdir>/ trees that have
        # no standalone LICENSE/COPYING file (e.g. RediSearch fast_float, geohash, phonetics).
        vendored_dirs = sorted(
            {
                PurePosixPath(p).parts[1]
                for p in rel_members
                if len(PurePosixPath(p).parts) >= 3
                and PurePosixPath(p).parts[0] == "deps"
                and PurePosixPath(p).parts[1].lower()
                not in {"test", "tests", "json_test", "example", "examples", "bench", "benches"}
                and f"deps/{PurePosixPath(p).parts[1]}" not in submodule_paths
                and PurePosixPath(p).parts[1] not in covered_dep_dirs
            }
        )
        for vdir in vendored_dirs:
            seen_snippets: set[str] = set()
            captured_notice = False
            if label == "redisearch" and vdir == "cndict":
                friso_license_rev = "3432fa78dc8902f9968eab80831934e79eb121ce"
                friso_license_path = "LICENSE.md"
                friso_license_url = (
                    "https://raw.githubusercontent.com/lionsoul2014/friso/"
                    f"{friso_license_rev}/{friso_license_path}"
                )
                common_sections.append(
                    format_notice(
                        f"FalkorDB dependency: {label}/deps/cndict "
                        "(Friso Chinese dictionary and tokenizer data)",
                        f"https://github.com/FalkorDB/RediSearch/tree/{rev}/deps/cndict "
                        f"(license: https://github.com/lionsoul2014/friso/blob/"
                        f"{friso_license_rev}/{friso_license_path})",
                        fetch_bytes(friso_license_url).decode("utf-8", "replace"),
                    )
                )
                captured_notice = True
            for rel_path in sorted(rel_members):
                if not rel_path.startswith(f"deps/{vdir}/"):
                    continue
                fname = PurePosixPath(rel_path).name
                if fname.lower().startswith("readme"):
                    readme_txt = read_dep_text(rel_path)
                    if re.search(r"copyright|license", readme_txt, re.I):
                        common_sections.append(
                            format_notice(
                                f"FalkorDB dependency: {label} ({rel_path})",
                                f"https://github.com/{repo}/blob/{rev}/{rel_path}",
                                readme_txt,
                            )
                        )
                        captured_notice = True
                elif rel_path.endswith((".c", ".h", ".hpp", ".cc", ".cpp")):
                    src_txt = read_dep_text(rel_path)
                    head120 = "\n".join(src_txt.splitlines()[:120])
                    if "Redis Source Available License" in head120:
                        redis_header = COMMENT_BLOCK_RE.search(head120)
                        if not redis_header:
                            raise SystemExit(
                                f"Redis license identifier without a comment header in "
                                f"{label}/{rel_path}"
                            )
                        snippet = redis_header.group(0)
                        if snippet not in seen_snippets:
                            seen_snippets.add(snippet)
                            common_sections.append(
                                format_notice(
                                    f"FalkorDB dependency: {label} ({rel_path})",
                                    f"https://github.com/{repo}/blob/{rev}/{rel_path}",
                                    snippet,
                                )
                            )
                            captured_notice = True
                        continue
                    snippet = extract_comment_notice(src_txt)
                    if snippet and snippet not in seen_snippets:
                        seen_snippets.add(snippet)
                        common_sections.append(
                            format_notice(
                                f"FalkorDB dependency: {label} ({rel_path})",
                                f"https://github.com/{repo}/blob/{rev}/{rel_path}",
                                snippet,
                            )
                        )
                        captured_notice = True
            if not captured_notice:
                raise SystemExit(
                    f"No license or copyright notice found for linked dependency "
                    f"{label}/deps/{vdir} in {repo}@{rev}"
                )

# 4. Resolve per-platform Rust runtime Cargo dependencies (FalkorDB + RediSearch staticlib).
per_platform_crates: dict[str, set[tuple[str, str, str]]] = {}
all_needed_crates: dict[tuple[str, str, str], None] = {}

for platform in platforms:
    triple = PLATFORM_TARGETS[platform]
    merged: set[tuple[str, str, str]] = set()
    if redisearch_rust_workspace is not None:
        merged.update(
            resolve_cargo_runtime_crates(
                redisearch_rust_workspace, "redisearch_rs", triple
            )
        )
    merged.update(
        resolve_cargo_runtime_crates(falkordb_src_root, "falkordb-rs", triple)
    )
    per_platform_crates[platform] = merged
    for crate in merged:
        all_needed_crates[crate] = None

github_repo_license_cache: dict[tuple[str, str], list[tuple[str, str]]] = {}
github_repo_license_lock = threading.Lock()
github_repo_member_license_cache: dict[
    tuple[str, str, str, str], list[tuple[str, str]]
] = {}


def fetch_github_repo_root_licenses(repo: str, ref: str) -> list[tuple[str, str]]:
    cache_key = (repo, ref)
    with github_repo_license_lock:
        if cache_key in github_repo_license_cache:
            return github_repo_license_cache[cache_key]
    archive_bytes = fetch_bytes(f"https://github.com/{repo}/archive/{ref}.tar.gz")
    found: list[tuple[str, str]] = []
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as gh_tf:
        members = [m for m in gh_tf.getmembers() if m.isfile()]
        if not members:
            raise SystemExit(f"Empty archive for {repo}@{ref}")
        root_prefix = members[0].name.split("/", 1)[0] + "/"
        for m in sorted(members, key=lambda x: x.name):
            if not m.name.startswith(root_prefix):
                continue
            rel = m.name[len(root_prefix) :]
            if "/" in rel or not is_notice_path(rel):
                continue
            extracted = gh_tf.extractfile(m)
            if extracted is not None:
                found.append(
                    (
                        f"https://github.com/{repo}/blob/{ref}/{rel}",
                        extracted.read().decode("utf-8", "replace"),
                    )
                )
    with github_repo_license_lock:
        github_repo_license_cache[cache_key] = found
    return found


def fetch_github_repo_member_license(
    repo: str, ref: str, package_name: str, package_version: str
) -> list[tuple[str, str]]:
    cache_key = (repo, ref, package_name, package_version)
    with github_repo_license_lock:
        if cache_key in github_repo_member_license_cache:
            return github_repo_member_license_cache[cache_key]

    archive_bytes = fetch_bytes(f"https://github.com/{repo}/archive/{ref}.tar.gz")
    found: list[tuple[str, str]] = []
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as gh_tf:
        members = [m for m in gh_tf.getmembers() if m.isfile()]
        if not members:
            raise SystemExit(f"Empty archive for {repo}@{ref}")
        root_prefix = members[0].name.split("/", 1)[0] + "/"
        manifest_paths = sorted(
            m.name[len(root_prefix) :]
            for m in members
            if m.name.startswith(root_prefix)
            and PurePosixPath(m.name[len(root_prefix) :]).name == "Cargo.toml"
        )
        if not manifest_paths:
            raise SystemExit(f"No Cargo.toml found for git crate {package_name} {package_version} ({repo}@{ref})")

        with tempfile.TemporaryDirectory(prefix="git-crate-license-", dir=tmp_dir) as extract_dir:
            source_root = safe_extract_tar_regular_files(gh_tf, extract_dir)
            candidate_paths = sorted(
                manifest_paths,
                key=lambda path: (path != "Cargo.toml", path.count("/"), path),
            )
            matching_packages: dict[str, dict[str, str | None]] = {}
            for manifest_rel_path in candidate_paths:
                manifest_path = os.path.join(source_root, *PurePosixPath(manifest_rel_path).parts)
                try:
                    metadata_output = subprocess.check_output(
                        [
                            "cargo",
                            "metadata",
                            "--no-deps",
                            "--format-version",
                            "1",
                            "--manifest-path",
                            manifest_path,
                        ],
                        cwd=source_root,
                        stderr=subprocess.PIPE,
                    )
                except subprocess.CalledProcessError as exc:
                    error = exc.stderr.decode("utf-8", "replace") if exc.stderr else str(exc)
                    raise SystemExit(
                        f"Unable to inspect Cargo manifest {manifest_rel_path} "
                        f"for {repo}@{ref}: {error.strip()}"
                    ) from exc
                metadata = json.loads(metadata_output.decode("utf-8"))
                for package in metadata.get("packages", []):
                    if package.get("name") != package_name or package.get("version") != package_version:
                        continue
                    package_manifest = package.get("manifest_path")
                    if not package_manifest:
                        raise SystemExit(
                            f"Cargo metadata omitted the manifest path for "
                            f"{package_name} {package_version} in {repo}@{ref}"
                        )
                    matching_packages[os.path.realpath(package_manifest)] = package
                if matching_packages:
                    break

            if not matching_packages:
                raise SystemExit(
                    f"Git crate {package_name} {package_version} not found in "
                    f"Cargo manifests at {repo}@{ref}"
                )
            if len(matching_packages) > 1:
                raise SystemExit(
                    f"Ambiguous Cargo manifests for git crate {package_name} "
                    f"{package_version} in {repo}@{ref}"
                )

            package = next(iter(matching_packages.values()))
            license_file = package.get("license_file")
            if license_file:
                if not os.path.isabs(license_file):
                    license_file = os.path.join(
                        os.path.dirname(package["manifest_path"]), license_file
                    )
                source_root_real = os.path.realpath(source_root)
                license_path = os.path.realpath(license_file)
                if os.path.commonpath([source_root_real, license_path]) != source_root_real:
                    raise SystemExit(
                        f"Unsafe declared license-file path for git crate "
                        f"{package_name} {package_version}: {license_file}"
                    )
                if not os.path.isfile(license_path):
                    raise SystemExit(
                        f"Declared license-file missing for git crate "
                        f"{package_name} {package_version}: {license_file}"
                    )
                rel_path = os.path.relpath(license_path, source_root_real).replace(os.sep, "/")
                with open(license_path, encoding="utf-8", errors="replace") as license_in:
                    found.append(
                        (
                            f"https://github.com/{repo}/blob/{ref}/{rel_path}",
                            license_in.read(),
                        )
                    )

    with github_repo_license_lock:
        github_repo_member_license_cache[cache_key] = found
    return found


def fetch_crate_notices(item: tuple[str, str, str]) -> tuple[tuple[str, str, str], list[str]]:
    name, ver, src = item
    rendered: list[str] = []

    if src.startswith("git+"):
        url_part, _, frag = src[len("git+") :].partition("#")
        repo_url = url_part.split("?", 1)[0]
        repo = resolve_github_repo(repo_url)
        if not re.fullmatch(r"[0-9a-f]{40}", frag):
            raise SystemExit(f"Invalid git commit fragment for crate {name} {ver}: {src}")
        gh_lics = fetch_github_repo_root_licenses(repo, frag)
        member_lics = fetch_github_repo_member_license(repo, frag, name, ver)
        if not any(is_license_file(url) for url, _ in gh_lics):
            raise SystemExit(f"No root license files found for git crate {name} {ver} ({repo}@{frag})")
        for lic_url, lic_txt in gh_lics + member_lics:
            rendered.append(
                format_notice(
                    f"FalkorDB Rust crate: {name} {ver} (git {repo}@{frag[:12]})",
                    lic_url,
                    lic_txt,
                )
            )
        return (item, rendered)

    if src not in CRATES_IO_REGISTRY_SOURCES:
        raise SystemExit(
            f"Unsupported Cargo registry for {name} {ver}: {src}; "
            "only crates.io registry sources are supported"
        )

    crate_url = f"https://static.crates.io/crates/{name}/{name}-{ver}.crate"
    crate_bytes = fetch_bytes(crate_url)
    lic_expr = "unspecified"
    repo_url: str | None = None
    vcs_sha1: str | None = None
    license_file: str | None = None
    declared_license_text: str | None = None
    crate_notice_entries: list[tuple[str, str]] = []

    with tarfile.open(fileobj=io.BytesIO(crate_bytes), mode="r:gz") as crate_tf:
        crate_prefix = f"{name}-{ver}/"
        members_by_rel = {
            m.name[len(crate_prefix) :]: m
            for m in crate_tf.getmembers()
            if m.isfile() and m.name.startswith(crate_prefix)
        }
        for rel, m in sorted(members_by_rel.items()):
            if rel == "Cargo.toml":
                with tempfile.TemporaryDirectory(
                    prefix="crate-manifest-", dir=tmp_dir
                ) as manifest_dir:
                    crate_root = safe_extract_tar_regular_files(crate_tf, manifest_dir)
                    manifest_path = os.path.join(crate_root, "Cargo.toml")
                    try:
                        manifest_output = subprocess.check_output(
                            [
                                "cargo",
                                "read-manifest",
                                "--manifest-path",
                                manifest_path,
                            ],
                            stderr=subprocess.PIPE,
                        )
                    except subprocess.CalledProcessError as exc:
                        error = exc.stderr.decode("utf-8", "replace") if exc.stderr else str(exc)
                        raise SystemExit(
                            f"Unable to parse Cargo.toml for crate {name} {ver}: "
                            f"{error.strip()}"
                        ) from exc
                    manifest_data = json.loads(manifest_output.decode("utf-8"))
                lic_expr = manifest_data.get("license") or "unspecified"
                license_file = manifest_data.get("license_file")
                repo_url = manifest_data.get("repository")
            elif rel == ".cargo_vcs_info.json":
                vcs_data = json.loads(
                    crate_tf.extractfile(m).read().decode("utf-8", "replace")
                )
                sha_candidate = vcs_data.get("git", {}).get("sha1", "")
                if re.fullmatch(r"[0-9a-f]{40}", sha_candidate):
                    vcs_sha1 = sha_candidate
            elif (
                is_notice_path(rel)
                and not rel.startswith(("tests/", "benches/", "examples/"))
                and not rel.startswith("vendor/wasi-libc/")
            ):
                extracted = crate_tf.extractfile(m)
                if extracted is not None:
                    crate_notice_entries.append(
                        (rel, extracted.read().decode("utf-8", "replace"))
                    )

        if license_file:
            license_path = PurePosixPath(license_file)
            if license_path.is_absolute() or ".." in license_path.parts:
                raise SystemExit(
                    f"Unsafe license-file path for crate {name} {ver}: {license_file}"
                )
            license_member = members_by_rel.get(license_path.as_posix())
            if license_member is None:
                raise SystemExit(
                    f"Declared license-file {license_file} missing from crate {name} {ver}"
                )
            if not any(rel == license_path.as_posix() for rel, _ in crate_notice_entries):
                extracted = crate_tf.extractfile(license_member)
                if extracted is None:
                    raise SystemExit(
                        f"Unable to read declared license-file for crate {name} {ver}: {license_file}"
                    )
                declared_license_text = extracted.read().decode("utf-8", "replace")

    if license_file and declared_license_text is not None:
        license_path = PurePosixPath(license_file)
        crate_notice_entries.append(
            (license_path.as_posix(), declared_license_text)
        )

    has_root_license = any(
        "/" not in rel
        and re.match(r"^(license|licence|copying|unlicense)([-_.].*)?$", rel, re.I)
        for rel, _ in crate_notice_entries
    )
    has_declared_license = bool(license_file and any(
        rel == PurePosixPath(license_file).as_posix()
        for rel, _ in crate_notice_entries
    ))
    has_license_text = has_root_license or has_declared_license
    if not has_license_text and repo_url:
        gh_repo = resolve_github_repo(repo_url)
        refs_to_try = [vcs_sha1] if vcs_sha1 else [f"v{ver}", ver]
        gh_lics: list[tuple[str, str]] = []
        for candidate_ref in refs_to_try:
            if not candidate_ref:
                continue
            try:
                gh_lics = fetch_github_repo_root_licenses(gh_repo, candidate_ref)
                if any(is_license_file(url) for url, _ in gh_lics):
                    break
                gh_lics = []
            except HTTPError as exc:
                if exc.code != 404:
                    raise
        for lic_url, lic_txt in gh_lics:
            rendered.append(
                format_notice(
                    f"FalkorDB Rust crate: {name} {ver} [Declared license: {lic_expr}]",
                    lic_url,
                    lic_txt,
                )
            )
        if not any(is_license_file(url) for url, _ in gh_lics):
            raise SystemExit(
                f"No license files found for crate {name} {ver} at its locked "
                f"revision or version tags {refs_to_try}"
            )
        has_license_text = True

    for rel, txt in crate_notice_entries:
        rendered.append(
            format_notice(
                f"FalkorDB Rust crate: {name} {ver} ({rel}) [Declared license: {lic_expr}]",
                f"https://crates.io/crates/{name}/{ver} ({crate_url})",
                txt,
            )
        )

    if not has_license_text:
        raise SystemExit(
            f"No license texts found in .crate or upstream repository for {name} {ver}"
        )
    return (item, rendered)


with ThreadPoolExecutor(max_workers=16) as executor:
    crate_notice_map = dict(
        executor.map(fetch_crate_notices, sorted(all_needed_crates.keys()))
    )

rust_license_source_ref = "1.100.0"
for license_name in ("LICENSE-APACHE", "LICENSE-MIT"):
    rust_license_url = (
        f"https://raw.githubusercontent.com/rust-lang/rust/{rust_license_source_ref}/{license_name}"
    )
    common_sections.append(
        format_notice(
            f"Rust standard library bundled by RediSearch ({license_name})",
            f"https://github.com/rust-lang/rust/blob/{rust_license_source_ref}/{license_name}",
            fetch_bytes(rust_license_url).decode("utf-8", "replace"),
        )
    )

rust_library_copyright_sections: dict[str, str] = {}
for platform in platforms:
    target_triple = PLATFORM_TARGETS[platform]
    rustc_archive_name = f"rustc-{rust_license_source_ref}-{target_triple}.tar.xz"
    rustc_archive_url = f"https://static.rust-lang.org/dist/{rustc_archive_name}"
    rustc_archive_bytes = fetch_bytes(rustc_archive_url)
    copyright_path = (
        f"rustc-{rust_license_source_ref}-{target_triple}/"
        "rustc/share/doc/rust/COPYRIGHT-library.html"
    )
    with tarfile.open(fileobj=io.BytesIO(rustc_archive_bytes), mode="r:xz") as rustc_tf:
        try:
            copyright_member = rustc_tf.getmember(copyright_path)
        except KeyError as exc:
            raise SystemExit(
                f"Rust {rust_license_source_ref} toolchain lacks {copyright_path}"
            ) from exc
        copyright_file = rustc_tf.extractfile(copyright_member)
        if copyright_file is None:
            raise SystemExit(f"Unable to read {copyright_path} from {rustc_archive_name}")
        rust_library_copyright = "\n".join(
            line.rstrip(" \t")
            for line in copyright_file.read().decode("utf-8", "replace").splitlines()
        )
    if (
        "Copyright notices for The Rust Standard Library" not in rust_library_copyright
        or "Out-of-tree dependencies" not in rust_library_copyright
    ):
        raise SystemExit(
            f"Rust {rust_license_source_ref} {target_triple} standard-library "
            "attributions are incomplete"
        )
    rust_library_copyright_sections[platform] = format_notice(
        f"Rust standard-library component attributions (COPYRIGHT-library.html; "
        f"Rust {rust_license_source_ref}, {target_triple})",
        f"{rustc_archive_url} ({copyright_path})",
        rust_library_copyright,
    )

for platform in platforms:
    triple = PLATFORM_TARGETS[platform]
    out_path = os.path.join(tmp_dir, f"THIRD-PARTY-NOTICES.{platform}.txt")
    with open(out_path, "w", encoding="utf-8") as notices_out:
        notices_out.write(
            "Third-party component notices for the binaries in this package\n\n"
            "This file reproduces the upstream license and copyright notices for the\n"
            f"third-party components included in Redis {redis_version} and FalkorDB\n"
            f"{falkordb_version} (target {triple}). Source references are given with\n"
            "each notice.\n"
        )
        for sec in common_sections:
            notices_out.write(sec)
        if platform == "linux-x64":
            for sec in linux_sections:
                notices_out.write(sec)
        if platform == "darwin-arm64":
            for sec in macos_sections:
                notices_out.write(sec)
        notices_out.write(rust_library_copyright_sections[platform])
        for crate_name, crate_ver, crate_src in sorted(per_platform_crates[platform]):
            for sec in crate_notice_map[(crate_name, crate_ver, crate_src)]:
                notices_out.write(sec)
PY

# Sanity-check that the fetched and generated texts match what LICENSE describes.
grep -q "Redis Source Available License" "$TMP_DIR/LICENSE-REDIS.txt"
grep -q "Server Side Public License" "$TMP_DIR/LICENSE-REDIS.txt"
grep -q "GNU AFFERO GENERAL PUBLIC LICENSE" "$TMP_DIR/LICENSE-REDIS.txt"
grep -q "BSD-3-Clause License" "$TMP_DIR/REDISCONTRIBUTIONS.txt"
grep -q "Server Side Public License" "$TMP_DIR/LICENSE-SSPL"
grep -q "GNU AFFERO GENERAL PUBLIC LICENSE" "$TMP_DIR/LICENSE-AGPL"

for platform in "${PLATFORMS[@]}"; do
  notices_file="$TMP_DIR/THIRD-PARTY-NOTICES.${platform}.txt"
  grep -q "Lua CJSON" "$notices_file"
  grep -q "Redis dependency: lua (deps/lua/COPYRIGHT)" "$notices_file"
  grep -q "Lua BitOp" "$notices_file"
  grep -q "Marc Alexander Lehmann" "$notices_file"
  grep -q "libuv" "$notices_file"
  grep -q "FalkorDB Rust crate: rquickjs " "$notices_file"
  grep -q "quickjs/LICENSE" "$notices_file"
  grep -q "Fabrice Bellard" "$notices_file"
  grep -q "Rust standard library bundled by RediSearch (LICENSE-APACHE)" "$notices_file"
  grep -q "Rust standard library bundled by RediSearch (LICENSE-MIT)" "$notices_file"
  grep -q "The Rust Project Contributors" "$notices_file"
  grep -q "COPYRIGHT-library.html" "$notices_file"
  grep -q "Copyright notices for The Rust Standard Library" "$notices_file"
  grep -q "Out-of-tree dependencies" "$notices_file"
  grep -q "Copyright Redis Ltd. 2016 - present" "$notices_file"
  grep -q "aho-corasick-1.1.4</h3>" "$notices_file"
  grep -q "FalkorDB Rust crate: lazy_static " "$notices_file"
  grep -q "FalkorDB Rust crate: roaring " "$notices_file"
  if [[ "${platform}" == "darwin-arm64" ]]; then
    grep -q "libc++ (LLVM ${MACOS_LLVM_VERSION})" "$notices_file"
    grep -q "libc++abi (LLVM ${MACOS_LLVM_VERSION})" "$notices_file"
    grep -q "LLVM OpenMP (libomp.a) (LLVM ${MACOS_LLVM_VERSION})" "$notices_file"
    grep -q "OpenSSL ${MACOS_OPENSSL_VERSION} (libssl.a and libcrypto.a)" "$notices_file"
  fi
done

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
    ${FALKORDB_TREE}/Cargo.lock
    ${FALKORDB_TREE}/deps/native-deps.lock
EOF

lock_dir="${PACKAGES_DIR}/.update-license-files.lock"
lock_wait_seconds=0
until mkdir "$lock_dir" 2>/dev/null; do
  if (( lock_wait_seconds >= 120 )); then
    echo "Timed out waiting for license update lock at ${lock_dir}; remove it only if no update is running." >&2
    exit 1
  fi
  sleep 1
  lock_wait_seconds=$((lock_wait_seconds + 1))
done
cleanup_update() {
  rmdir "$lock_dir" || echo "Unable to remove license update lock at ${lock_dir}." >&2
  rm -rf "$TMP_DIR"
}
trap cleanup_update EXIT

PLATFORMS_CSV="$(IFS=,; echo "${PLATFORMS[*]}")" \
PACKAGES_DIR="${PACKAGES_DIR}" TMP_DIR="${TMP_DIR}" \
python3 - <<'PY'
from __future__ import annotations

import os
from pathlib import Path
import shutil
import sys
import tempfile

packages_dir = Path(os.environ["PACKAGES_DIR"])
tmp_dir = Path(os.environ["TMP_DIR"])
platforms = [p for p in os.environ["PLATFORMS_CSV"].split(",") if p]
shared_files = [
    "LICENSE-REDIS.txt",
    "REDISCONTRIBUTIONS.txt",
    "LICENSE-FALKORDB",
    "LICENSE-SSPL",
    "LICENSE-AGPL",
    "LICENSE-FALKORDB-SSPL",
    "LICENSE-FALKORDB-AGPL",
    "NOTICE",
]

transactions: list[tuple[Path, Path, Path]] = []
prepared: list[tuple[Path, Path, Path]] = []
installed: list[tuple[Path, Path]] = []
rollback_failed = False

try:
    for platform in platforms:
        destination = packages_dir / platform
        transaction_dir = Path(
            tempfile.mkdtemp(prefix=".update-license-files-", dir=destination)
        )
        stage_dir = transaction_dir / "stage"
        backup_dir = transaction_dir / "backup"
        transactions.append((transaction_dir, stage_dir, backup_dir))
        stage_dir.mkdir()
        backup_dir.mkdir()

        files = [(name, name) for name in shared_files]
        files.append(
            (f"THIRD-PARTY-NOTICES.{platform}.txt", "THIRD-PARTY-NOTICES.txt")
        )
        for source_name, destination_name in files:
            source = tmp_dir / source_name
            staged = stage_dir / destination_name
            shutil.copy2(source, staged)
            prepared.append(
                (destination / destination_name, staged, backup_dir / destination_name)
            )

    for destination, _, backup in prepared:
        if os.path.lexists(destination):
            shutil.copy2(destination, backup, follow_symlinks=False)

    for destination, staged, backup in prepared:
        os.replace(staged, destination)
        installed.append((destination, backup))
except BaseException as exc:
    rollback_errors: list[str] = []
    for destination, backup in reversed(installed):
        try:
            if os.path.lexists(backup):
                os.replace(backup, destination)
            elif os.path.lexists(destination):
                destination.unlink()
        except OSError as rollback_error:
            rollback_errors.append(f"{destination}: {rollback_error}")
    if rollback_errors:
        rollback_failed = True
        retained = ", ".join(str(transaction[0]) for transaction in transactions)
        print(
            "License installation failed and rollback was incomplete; "
            f"preserved recovery files in {retained}: {'; '.join(rollback_errors)}",
            file=sys.stderr,
        )
    raise
finally:
    if not rollback_failed:
        for transaction_dir, _, _ in transactions:
            shutil.rmtree(transaction_dir)

for platform in platforms:
    print(f"Updated license files in {packages_dir / platform}")
PY
