#!/usr/bin/env python3
"""Build a variable-file package and a five-file legacy bootstrap envelope."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile

CORE = {"xdrive", "install.sh", "upgrade.sh", "uninstall.sh"}
BEGIN = "--BEGIN XDRIVE PACKAGE MANIFEST--"
END = "--END XDRIVE PACKAGE MANIFEST--"


def safe_path(name):
    if name in {"xdrive.candidate", "upgrade.sh.candidate", "uninstall.sh.candidate"}:
        return False
    parts = PurePosixPath(name).parts
    return (0 < len(name) <= 240 and not name.startswith("/")
            and str(PurePosixPath(name)) == name
            and all(part not in (".", "..") and re.fullmatch(r"[A-Za-z0-9_.-]+", part) for part in parts))


def build(stage, destination, legacy=False, extra=None):
    sources = {}
    for root in (stage, extra):
        if root is None:
            continue
        if root.is_symlink() or not root.is_dir():
            raise ValueError("release files directory must be a real directory")
        for source in root.rglob("*"):
            name = source.relative_to(root).as_posix()
            if not safe_path(name) or source.is_symlink():
                raise ValueError(f"unsafe release file path: {name}")
            if source.is_dir():
                continue
            if not source.is_file() or source.stat().st_mode & (stat.S_ISUID | stat.S_ISGID):
                raise ValueError(f"invalid release file type or permissions: {name}")
            if name in sources:
                raise ValueError(f"release files collide: {name}")
            sources[name] = source
    if not CORE.issubset(sources) or "RELEASE.txt" not in sources:
        raise ValueError("release is missing its bootstrap files")
    if legacy:
        sources = {name: source for name, source in sources.items() if name in CORE or name == "RELEASE.txt"}
    files = []
    for name in sorted(sources):
        if name == "RELEASE.txt":
            continue
        source = sources[name]
        size = source.stat().st_size
        mode = 0o755 if name in CORE or source.stat().st_mode & 0o111 else 0o644
        with source.open("rb") as stream:
            hasher = hashlib.sha256()
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(block)
            digest = hasher.hexdigest()
        files.append({"path": name, "size": size, "sha256": digest, "mode": mode})
    if len(files) > 4096 or sum(file["size"] for file in files) > 512 * 1024 * 1024:
        raise ValueError("release package exceeds its resource limits")
    for file in files:
        for parent in PurePosixPath(file["path"]).parents:
            if str(parent) in sources:
                raise ValueError("release has a file/directory path collision")
    metadata = sources["RELEASE.txt"].read_text()
    if BEGIN in metadata or "packageFormat=" in metadata:
        raise ValueError("release metadata already contains a manifest")
    metadata = "packageFormat=1\n" + metadata
    metadata += "\n" + BEGIN + "\n" + json.dumps({"format": 1, "files": files}, separators=(",", ":")) + "\n" + END + "\n"
    release = metadata.encode()
    if len(release) > 1024 * 1024:
        raise ValueError("release metadata exceeds its limit")
    if sum(file["size"] for file in files) + len(release) > 512 * 1024 * 1024:
        raise ValueError("release unpacked size exceeds its limit")
    with destination.open("wb") as output, gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as zipped, tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for file in [{"path": "RELEASE.txt", "size": len(release), "mode": 0o644}, *files]:
            info = tarfile.TarInfo(file["path"])
            info.size, info.mode = file["size"], file["mode"]
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            if file["path"] == "RELEASE.txt":
                archive.addfile(info, io.BytesIO(release))
            else:
                with sources[file["path"]].open("rb") as stream:
                    archive.addfile(info, stream)


def verify_bridge(archive, version, architecture):
    with tarfile.open(archive, "r:gz") as package:
        members = package.getmembers()
        if len(members) != 5 or {member.name for member in members} != CORE | {"RELEASE.txt"} or any(not member.isfile() or member.size > 128 * 1024 * 1024 for member in members):
            raise ValueError("invalid legacy bootstrap archive")
        entry = package.getmember("RELEASE.txt")
        if entry.size > 1024 * 1024:
            raise ValueError("legacy bootstrap metadata exceeds its limit")
        metadata = package.extractfile(entry).read().decode()
        values = {}
        for line in metadata.split("\n\n", 1)[0].splitlines():
            key, value = line.split("=", 1)
            if key in values:
                raise ValueError("duplicate legacy bootstrap metadata")
            values[key] = value
        if values.get("version") != version or values.get("architecture") != architecture or values.get("os") != "linux" or values.get("packageFormat") != "1":
            raise ValueError("legacy bootstrap version or platform mismatch")
        manifest = json.loads(metadata.split(BEGIN + "\n", 1)[1].split("\n" + END, 1)[0])
        if manifest["format"] != 1 or len(manifest["files"]) != 4 or {file["path"] for file in manifest["files"]} != CORE:
            raise ValueError("invalid legacy bootstrap manifest")
        for file in manifest["files"]:
            member = package.getmember(file["path"])
            hasher = hashlib.sha256()
            with package.extractfile(member) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    hasher.update(block)
            if member.mode != file["mode"] or file["mode"] != 0o755 or member.size != file["size"] or hasher.hexdigest() != file["sha256"]:
                raise ValueError("legacy bootstrap manifest mismatch")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--files-dir", type=Path)
    parser.add_argument("--legacy", action="store_true")
    parser.add_argument("--verify-bridge", type=Path)
    parser.add_argument("--version")
    parser.add_argument("--architecture", choices=("amd64", "arm64"))
    args = parser.parse_args()
    if args.verify_bridge:
        if not args.version or not args.architecture:
            parser.error("bridge verification requires version and architecture")
        verify_bridge(args.verify_bridge, args.version, args.architecture)
    else:
        if not args.stage or not args.output:
            parser.error("building an archive requires stage and output")
        build(args.stage, args.output, args.legacy, args.files_dir)
