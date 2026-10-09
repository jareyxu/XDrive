#!/usr/bin/env python3
"""Independently stream-check a generated ZIP64 against an expected manifest."""
import hashlib
import json
import os
import sys
import zipfile


def verify(archive, manifest_path):
    with open(manifest_path, encoding="utf-8") as source:
        expected = json.load(source)
    if os.path.getsize(archive) <= 0xFFFFFFFF:
        raise ValueError("archive must exceed the classic ZIP size range")
    checked = []
    with zipfile.ZipFile(archive) as reader:
        infos = reader.infolist()
        if len({item.filename for item in infos}) != len(infos):
            raise ValueError("duplicate ZIP paths")
        if {item.filename for item in infos} != set(expected):
            raise ValueError("archive paths do not match expected paths")
        for info in infos:
            record = expected[info.filename]
            if info.compress_type != zipfile.ZIP_STORED or info.file_size != record["bytes"]:
                raise ValueError("entry format/size mismatch: " + info.filename)
            digest = hashlib.sha256()
            count = 0
            # Reading to EOF also verifies the ZIP reader's independent CRC32.
            with reader.open(info) as entry:
                while True:
                    chunk = entry.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    count += len(chunk)
            if count != record["bytes"] or digest.hexdigest() != record["sha256"]:
                raise ValueError("plaintext hash mismatch: " + info.filename)
            checked.append({"path": info.filename, "bytes": count, "sha256": digest.hexdigest(), "headerOffset": info.header_offset, "extractVersion": info.extract_version})
        if not any(info.file_size > 0xFFFFFFFF and info.extract_version >= 45 for info in infos):
            raise ValueError("large ZIP64 entry missing")
        if not any(info.header_offset > 0xFFFFFFFF for info in infos):
            raise ValueError("no entry exercises a ZIP64 offset")
    return {"archiveBytes": os.path.getsize(archive), "python": sys.version, "entries": checked}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: verify-zip64.py ARCHIVE EXPECTED_JSON")
    print(json.dumps(verify(sys.argv[1], sys.argv[2]), indent=2, ensure_ascii=False))
