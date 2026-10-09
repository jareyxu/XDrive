#!/usr/bin/env python3
"""Run the opt-in near-quota backup/verify/restore workload in an isolated Linux container.

Requires Go, a running Docker daemon, and an already-present Linux image. It
creates two temporary host directories for source and backup data; no project
or user data is mounted. The two bind mounts are separate paths but may share
the same physical host filesystem.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BYTES = 10 * 1024 * 1024 * 1024
RESOURCE_SOURCES = (
    "internal/backup/backup.go",
    "internal/backup/backup_resource_test.go",
    "internal/backup/restore_object.go",
    "internal/backup/stream_cache_darwin.go",
    "internal/backup/stream_cache_linux.go",
    "internal/backup/stream_cache_other.go",
    "internal/db/db.go",
    "scripts/backup_resource_check.py",
    "go.mod",
    "go.sum",
)


def command(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def digest(path):
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="debian:12-slim")
    parser.add_argument("--bytes", type=int, default=DEFAULT_BYTES)
    parser.add_argument("--output", type=Path, required=True, help="JSON report path")
    parser.add_argument("--timeout-seconds", type=int, default=7200)
    options = parser.parse_args()
    if options.bytes < 36 or options.bytes > DEFAULT_BYTES:
        parser.error(f"--bytes must be between 36 and {DEFAULT_BYTES}")
    if options.timeout_seconds < 60 or options.timeout_seconds > 14400:
        parser.error("--timeout-seconds must be between 60 and 14400")

    output = options.output if options.output.is_absolute() else ROOT / options.output
    output.parent.mkdir(parents=True, exist_ok=True)
    log_path = output.with_suffix(".log")
    report = {
        "schemaVersion": 1,
        "status": "failed",
        "goalStatus": "active",
        "workload": "isolated near-quota opaque-object backup, full verification, and restore",
        "fixtureBytes": options.bytes,
        "environment": {
            "host": platform.platform(),
            "hostArchitecture": platform.machine(),
            "containerImage": options.image,
            "containerArchitecture": "linux/arm64",
            "cpus": 1,
            "memoryBytes": 1024 * 1024 * 1024,
            "memorySwapBytes": 1024 * 1024 * 1024,
            "network": "none",
            "readOnlyRoot": True,
            "user": "65532:65532",
            "capabilities": "all dropped",
            "sourceAndBackupMounts": "distinct temporary host directories; same physical host filesystem may back both",
        },
        "limits": [
            "Opaque deterministic fixture validates backup byte streaming and checksums, not client-side AEAD validity.",
            "A Docker Desktop container with host bind mounts is not a physical VPS or a provider 25 GB disk.",
            "Opaque fixture bytes test storage integrity, not client-side AEAD or browser upload.",
        ],
        "sourceSha256": {path: digest(ROOT / path) for path in RESOURCE_SOURCES},
        "rawLog": str(log_path),
    }
    container = "xdrive-backup-resource-" + uuid.uuid4().hex[:12]
    created = False
    started_at = time.monotonic()
    try:
        image_info = json.loads(command(["docker", "image", "inspect", options.image]))[0]
        report["environment"]["imageId"] = image_info["Id"]
        report["environment"]["imageOs"] = image_info["Os"]
        report["environment"]["imageArchitecture"] = image_info["Architecture"]
        if image_info["Os"] != "linux" or image_info["Architecture"] != "arm64":
            raise RuntimeError("the already-present image must be Linux ARM64 for the native local Docker VM")

        with tempfile.TemporaryDirectory(prefix="xdrive-backup-resource-bin-") as build_dir, \
                tempfile.TemporaryDirectory(prefix="xdrive-backup-resource-source-") as source_dir, \
                tempfile.TemporaryDirectory(prefix="xdrive-backup-resource-destination-") as destination_dir:
            source_free = shutil.disk_usage(source_dir).free
            destination_free = shutil.disk_usage(destination_dir).free
            required_free = options.bytes + 256 * 1024 * 1024
            report["hostFilesystemCapacity"] = {
                "sourcePathFreeBytesBeforeRun": source_free,
                "backupPathFreeBytesBeforeRun": destination_free,
                "requiredBytesPerPath": required_free,
            }
            if source_free < required_free or destination_free < required_free:
                raise RuntimeError("temporary host filesystem lacks required source/backup free space")
            binary = Path(build_dir) / "backup-resource.test"
            build_env = os.environ.copy()
            build_env.update({"GOOS": "linux", "GOARCH": "arm64", "CGO_ENABLED": "0"})
            subprocess.run(
                ["go", "test", "-c", "-o", str(binary), "./internal/backup"],
                cwd=ROOT,
                env=build_env,
                check=True,
                timeout=options.timeout_seconds,
            )
            report["resourceTestBinarySha256"] = digest(binary)
            docker_args = [
                "docker", "create", "--name", container,
                "--platform", "linux/arm64",
                "--user", "65532:65532",
                "--network", "none",
                "--read-only",
                "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges",
                "--pids-limit", "128",
                "--cpus", "1",
                "--memory", "1g",
                "--memory-swap", "1g",
                "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
                "--mount", f"type=bind,source={source_dir},target=/source",
                "--mount", f"type=bind,source={destination_dir},target=/backup",
                "--mount", f"type=bind,source={binary},target=/backup-resource.test,readonly",
                "--env", "XDRIVE_BACKUP_RESOURCE_E2E=1",
                "--env", f"XDRIVE_BACKUP_RESOURCE_BYTES={options.bytes}",
                "--env", "XDRIVE_BACKUP_RESOURCE_SOURCE=/source",
                "--env", "XDRIVE_BACKUP_RESOURCE_DESTINATION=/backup",
                "--env", "XDRIVE_BACKUP_RESOURCE_REPORT=/source/xdrive-backup-resource-report.json",
                options.image,
                "/backup-resource.test",
                "-test.run=^TestBackupNearQuotaResource$",
                "-test.count=1",
                f"-test.timeout={options.timeout_seconds}s",
                "-test.v",
            ]
            command(docker_args)
            created = True
            inspection = json.loads(command(["docker", "inspect", container]))[0]
            host = inspection["HostConfig"]
            mounts = inspection["Mounts"]
            report["containerIsolation"] = {
                "readOnlyRootfs": host["ReadonlyRootfs"],
                "networkMode": host["NetworkMode"],
                "capDrop": host["CapDrop"],
                "securityOptions": host["SecurityOpt"],
                "pidsLimit": host["PidsLimit"],
                "nanoCpus": host["NanoCpus"],
                "memoryBytes": host["Memory"],
                "memorySwapBytes": host["MemorySwap"],
                "user": inspection["Config"]["User"],
                "mounts": [
                    {"destination": mount["Destination"], "readOnly": not mount["RW"]}
                    for mount in mounts
                ],
            }
            verified_mounts = {
                mount["Destination"]: mount
                for mount in mounts
            }
            report["isolationVerified"] = (
                host["ReadonlyRootfs"]
                and host["NetworkMode"] == "none"
                and "ALL" in host["CapDrop"]
                and "no-new-privileges" in host["SecurityOpt"]
                and host["PidsLimit"] == 128
                and host["NanoCpus"] == 1_000_000_000
                and host["Memory"] == 1_073_741_824
                and host["MemorySwap"] == 1_073_741_824
                and inspection["Config"]["User"] == "65532:65532"
                and set(verified_mounts) == {"/source", "/backup", "/backup-resource.test"}
                and verified_mounts["/source"]["RW"]
                and verified_mounts["/backup"]["RW"]
                and not verified_mounts["/backup-resource.test"]["RW"]
            )
            if not report["isolationVerified"]:
                raise RuntimeError("Docker container isolation or mount policy differs from the required test policy")

            with log_path.open("w") as log:
                subprocess.run(
                    ["docker", "start", "-a", container],
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    timeout=options.timeout_seconds,
                    check=False,
                )
            state = json.loads(command(["docker", "inspect", container]))[0]["State"]
            report["containerState"] = {
                "exitCode": state["ExitCode"],
                "oomKilled": state["OOMKilled"],
                "error": state["Error"],
            }
            test_report = Path(source_dir) / "xdrive-backup-resource-report.json"
            if test_report.exists():
                report["workloadResult"] = json.loads(test_report.read_text())
            report["logSha256"] = digest(log_path)
            report["containerElapsedSeconds"] = round(time.monotonic() - started_at, 3)
            if state["ExitCode"] == 0 and not state["OOMKilled"] and report.get("workloadResult", {}).get("status") == "passed":
                report["functionalWorkloadPassed"] = True
                headroom = report["workloadResult"].get("memoryHeadroomStatus", "unavailable")
                if headroom == "below-container-limit":
                    report["status"] = "passed"
                    report["resourceHeadroomPassed"] = True
                else:
                    report["status"] = "completed-with-memory-limit-pressure"
                    report["resourceHeadroomPassed"] = False
                    report["resourceHeadroomConclusion"] = headroom
            else:
                report["functionalWorkloadPassed"] = False
                report["resourceHeadroomPassed"] = False
                report["error"] = "container or backup workload did not pass"
    except (OSError, subprocess.SubprocessError, RuntimeError, ValueError, KeyError) as error:
        report["error"] = str(error)
    finally:
        if created:
            cleanup = subprocess.run(["docker", "rm", "-f", container], capture_output=True, text=True)
            report["containerRemoved"] = cleanup.returncode == 0
            if cleanup.returncode != 0:
                report["status"] = "failed"
                report["cleanupError"] = cleanup.stderr.strip()
        report["hostElapsedSeconds"] = round(time.monotonic() - started_at, 3)
        output.write_text(json.dumps(report, indent=2) + "\n")

    print(json.dumps({"status": report["status"], "report": str(output), "log": str(log_path)}, indent=2))
    if report["status"] == "passed" and report.get("containerRemoved"):
        return 0
    return 2 if report.get("functionalWorkloadPassed") else 1


if __name__ == "__main__":
    raise SystemExit(main())
