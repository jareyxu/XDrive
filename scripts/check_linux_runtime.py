#!/usr/bin/env python3
"""Optional isolated Linux test execution; never installs or deploys XDrive.

Requires Go, a running Docker daemon and an already-present native Linux image.
Only disposable compiled inputs are mounted, read-only. No user data is mounted.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ("config", "cryptofmt", "db", "sqlitevfs", "storage", "backup", "server", "cmd/xdrive")
CRYPTO_FIXTURES = ("crypto-v1.json", "crypto-v2.json", "crypto-aead.json", "crypto-encoding.json")
CLI_SMOKE_TESTS = (
    "TestBackupCommandHonorsCancellationContext",
    "TestServeListenFailureStopsCleanupLoop",
    "TestInspectBackupCommandPrintsVerifiedSummary",
    "TestInspectBackupCommandAcceptsExplicitHistoricalGeneration",
    "TestRestoreStagedPreservesSelectedSchemaWithoutMigration",
    "TestRestoreStagedCLIUsesConfiguredDataRoot",
)


def command(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="debian:12-slim")
    parser.add_argument("--output-dir", required=True, type=Path)
    options = parser.parse_args()
    output = options.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    info = json.loads(command(["docker", "info", "--format", "{{json .}}"] ))
    image = json.loads(command(["docker", "image", "inspect", options.image]))[0]
    native = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64", "amd64": "amd64"}.get(info["Architecture"])
    if image["Os"] != "linux" or image["Architecture"] != native:
        raise SystemExit("Image must match the daemon's native Linux architecture")
    report = {
        "schema": 1, "startedUTC": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "image": {key: image.get(key) for key in ("Id", "RepoDigests", "Os", "Architecture")},
        "daemon": {key: info.get(key) for key in ("ServerVersion", "KernelVersion", "OperatingSystem", "Architecture", "NCPU", "MemTotal", "CgroupVersion")},
        "goVersion": command(["go", "version"]), "packages": list(PACKAGES),
        "cliSmokeTests": list(CLI_SMOKE_TESTS),
        "cliSmokeCommands": ["version", "--version", "init", "doctor", "migrate", "setup-token", "backup --verify", "verify-backup", "inspect-backup", "restore-staged", "restore"],
        "limitations": ["Docker Linux VM, not a physical VPS or 1GiB operating system", "No systemd/Caddy/install/upgrade or 25GB disk validation", "Native image architecture only; no other Linux distribution or CPU architecture validation", "Tests use disposable tmpfs, not production filesystem/power-loss certification", "No compiler or race instrumentation inside container; eight CGO-free package suites, with CLI tests selected to avoid nested Go builds"],
        "sourceSHA256": {}, "binarySHA256": {},
    }
    for base in ("internal", "cmd"):
        for path in sorted((ROOT / base).rglob("*")):
            if path.is_file() and path.suffix in (".go", ".sql"):
                report["sourceSHA256"][str(path.relative_to(ROOT))] = digest(path)
    for name in ("go.mod", "go.sum", "scripts/check_linux_runtime.py", *("tests/testdata/" + name for name in CRYPTO_FIXTURES)):
        report["sourceSHA256"][name] = digest(ROOT / name)
    for path in sorted((ROOT / "internal/server/static").rglob("*")):
        if path.is_file():
            report["sourceSHA256"][str(path.relative_to(ROOT))] = digest(path)
    container = "xdrive-runtime-check-" + uuid.uuid4().hex[:12]
    created = False
    try:
        with tempfile.TemporaryDirectory(prefix="xdrive-linux-inputs-") as scratch:
            inputs = Path(scratch)
            inputs.chmod(0o755)
            env = dict(os.environ, CGO_ENABLED="0", GOOS="linux", GOARCH=native)
            for package in PACKAGES:
                folder = inputs / package if package == "cmd/xdrive" else inputs / "internal" / package
                folder.mkdir(parents=True)
                binary = folder / "suite.test"
                source_package = "./" + package if package == "cmd/xdrive" else "./internal/" + package
                subprocess.run(["go", "test", "-c", "-o", str(binary), source_package], cwd=ROOT, env=env, check=True)
                binary.chmod(0o755)
                report["binarySHA256"][package] = digest(binary)
            cli_binary = inputs / "xdrive"
            subprocess.run(["go", "build", "-o", str(cli_binary), "./cmd/xdrive"], cwd=ROOT, env=env, check=True)
            cli_binary.chmod(0o755)
            report["cliBinarySHA256"] = digest(cli_binary)
            fixture_dir = inputs / "tests" / "testdata"
            fixture_dir.mkdir(parents=True)
            for name in CRYPTO_FIXTURES:
                (fixture_dir / name).write_bytes((ROOT / "tests" / "testdata" / name).read_bytes())
            # Asset integrity tests compare compiled embed bytes with the actual
            # build tree. Supply the same immutable snapshot as readonly input.
            shutil.copytree(ROOT / "internal/server/static", inputs / "internal/server/static")
            for name, expected in report["sourceSHA256"].items():
                if digest(ROOT / name) != expected:
                    raise RuntimeError("Source changed during Linux test compilation: " + name)
            # Execute every package even after an earlier package fails, preserving
            # each suite's output and the overall failing status.
            script = "set -eu\nresult=0\ncat /etc/os-release\nuname -a\nid\n"
            for package in PACKAGES:
                script += "printf '\\nPACKAGE " + package + "\\n'\n"
                folder = "/validation/" + package if package == "cmd/xdrive" else "/validation/internal/" + package
                args = " -test.run='" + "|".join(CLI_SMOKE_TESTS) + "'" if package == "cmd/xdrive" else ""
                script += "(cd " + folder + " && ./suite.test -test.v -test.timeout=5m" + args + ") || result=1\n"
            # Exercise the actual statically linked target-architecture CLI in
            # its intended non-root, read-only-rootfs runtime. Capture setup
            # token output in a shell variable and assert only its shape so the
            # disposable credential never enters the retained log.
            script += "\nprintf '\\nCLI SMOKE\\n'\n"
            script += "xdrive=/validation/xdrive\n"
            script += "printf 'CLI STEP version\\n'\n"
            script += "test \"$(\"$xdrive\" version)\" = 'xdrive dev (unknown)'\n"
            script += "test \"$(\"$xdrive\" --version)\" = 'xdrive dev (unknown)'\n"
            script += "base=/tmp/xdrive-cli-smoke\n"
            script += "mkdir -p \"$base/active\" \"$base/staged\" \"$base/restored\"\n"
            script += "export XDRIVE_DATABASE_PATH=\"$base/active/xdrive.db\" XDRIVE_STORAGE_PATH=\"$base/active/objects\" XDRIVE_SECRET_PATH=\"$base/active/server.secret\" XDRIVE_DISK_SAFETY_BYTES=0 XDRIVE_MAINTENANCE_RESERVE_BYTES=0\n"
            script += "printf 'CLI STEP init\\n'\n"
            script += "setup_output=$(\"$xdrive\" init)\nprintf '%s\\n' \"$setup_output\" | grep -Eq '^Open /setup#[A-Za-z0-9_-]+ within 24 hours to configure XDrive\\.$'\n"
            script += "printf 'CLI STEP doctor+migrate+setup-token\\n'\n"
            script += "doctor_output=$(\"$xdrive\" doctor)\nprintf '%s\\n' \"$doctor_output\" | grep -q '^Database: ready'\nprintf '%s\\n' \"$doctor_output\" | grep -q '^Object storage: ready$'\n"
            script += "\"$xdrive\" migrate >/dev/null\nsetup_output=$(\"$xdrive\" setup-token)\nprintf '%s\\n' \"$setup_output\" | grep -Eq '^Open /setup#[A-Za-z0-9_-]+ within 24 hours to configure XDrive\\.$'\n"
            script += "printf 'CLI STEP backup+inspect+verify\\n'\n"
            script += "backup=/tmp/xdrive-cli-smoke-backup\nmkdir -m 700 \"$backup\"\n\"$xdrive\" backup --verify \"$backup\" >/dev/null\n\"$xdrive\" verify-backup \"$backup\"\ninfo=$(\"$xdrive\" inspect-backup \"$backup\")\nprintf '%s\\n' \"$info\" | grep -q '\"objectCount\": 0'\n"
            script += "printf 'CLI STEP restore-staged\\n'\n"
            script += "XDRIVE_DATABASE_PATH=\"$base/staged/xdrive.db\" XDRIVE_STORAGE_PATH=\"$base/staged/objects\" XDRIVE_SECRET_PATH=\"$base/staged/server.secret\" \"$xdrive\" restore-staged \"$backup\" >/dev/null\n"
            script += "printf 'CLI STEP staged restore done\\n'\n"
            script += "XDRIVE_DATABASE_PATH=\"$base/staged/xdrive.db\" XDRIVE_STORAGE_PATH=\"$base/staged/objects\" XDRIVE_SECRET_PATH=\"$base/staged/server.secret\" \"$xdrive\" doctor >/dev/null\n"
            script += "printf 'CLI STEP staged doctor done\\n'\n"
            script += "printf 'CLI STEP restore\\n'\n"
            script += "XDRIVE_DATABASE_PATH=\"$base/restored/xdrive.db\" XDRIVE_STORAGE_PATH=\"$base/restored/objects\" XDRIVE_SECRET_PATH=\"$base/restored/server.secret\" \"$xdrive\" restore \"$backup\" >/dev/null\n"
            script += "printf 'CLI STEP regular restore done\\n'\n"
            script += "XDRIVE_DATABASE_PATH=\"$base/restored/xdrive.db\" XDRIVE_STORAGE_PATH=\"$base/restored/objects\" XDRIVE_SECRET_PATH=\"$base/restored/server.secret\" \"$xdrive\" doctor >/dev/null\nprintf 'CLI SMOKE PASS\\n'\n"
            script += "exit $result\n"
            (inputs / "run.sh").write_text(script)
            command(["docker", "create", "--name", container, "--user", "65532:65532", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--tmpfs", "/tmp:rw,nosuid,nodev,size=768m,mode=1777", "--mount", "type=bind,source=" + str(inputs) + ",target=/validation,readonly", image["Id"], "sh", "/validation/run.sh"])
            created = True
            inspection = json.loads(command(["docker", "inspect", container]))[0]
            host = inspection["HostConfig"]
            report["isolation"] = {key: host.get(key) for key in ("ReadonlyRootfs", "NetworkMode", "CapDrop", "SecurityOpt", "PidsLimit", "NanoCpus", "Memory", "MemorySwap", "Tmpfs")}
            report["user"] = inspection["Config"]["User"]
            report["mounts"] = inspection["Mounts"]
            report["isolationVerified"] = (
                host["ReadonlyRootfs"] and host["NetworkMode"] == "none"
                and "ALL" in host["CapDrop"]
                and "no-new-privileges" in host["SecurityOpt"]
                and host["PidsLimit"] == 128 and host["NanoCpus"] == 1000000000
                and host["Memory"] == 1073741824 and host["MemorySwap"] == 1073741824
                and inspection["Config"]["User"] == "65532:65532"
                and len(inspection["Mounts"]) == 1
                and inspection["Mounts"][0]["Destination"] == "/validation"
                and not inspection["Mounts"][0]["RW"]
            )
            if not report["isolationVerified"]:
                raise RuntimeError("Container isolation differs from required test policy")
            start = time.monotonic()
            with (output / "linux-runtime.log").open("w") as log:
                # Docker's CLI code alone is not the container's test verdict.
                subprocess.run(["docker", "start", "-a", container], stdout=log, stderr=subprocess.STDOUT, timeout=1800, check=False)
            finished = json.loads(command(["docker", "inspect", container]))[0]
            report["state"] = finished["State"]
            report["elapsedSeconds"] = round(time.monotonic() - start, 3)
            raw = (output / "linux-runtime.log").read_text()
            report["logSHA256"] = digest(output / "linux-runtime.log")
            report["suiteResults"] = {}
            for section in re.split(r"\nPACKAGE ", raw)[1:]:
                package, _, body = section.partition("\n")
                report["suiteResults"][package] = {
                    "verdict": "PASS" if re.search(r"^PASS$", body, re.M) else "FAIL",
                    "passedIncludingSubtests": len(re.findall(r"^\s*--- PASS:", body, re.M)),
                    "skippedIncludingHelpers": re.findall(r"^\s*--- SKIP: (\S+)", body, re.M),
                    "failedIncludingSubtests": re.findall(r"^\s*--- FAIL: (\S+)", body, re.M),
                }
            report["cliSmokePassed"] = "CLI SMOKE PASS" in raw
            report["passed"] = finished["State"]["ExitCode"] == 0 and not finished["State"]["OOMKilled"] and not finished["State"]["Running"] and len(report["suiteResults"]) == len(PACKAGES) and all(item["verdict"] == "PASS" for item in report["suiteResults"].values()) and report["cliSmokePassed"]
    except (Exception, KeyboardInterrupt) as error:
        report["passed"] = False
        report["error"] = str(error)
        raise
    finally:
        if created:
            cleanup = subprocess.run(["docker", "rm", "-f", container], capture_output=True, text=True)
            report["ownContainerRemoved"] = cleanup.returncode == 0
            if cleanup.returncode != 0:
                report["passed"] = False
                report["cleanupError"] = cleanup.stderr
        (output / "linux-runtime.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": report["passed"], "cliSmokePassed": report.get("cliSmokePassed", False), "suites": report["suiteResults"], "report": str(output / "linux-runtime.json")}, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
