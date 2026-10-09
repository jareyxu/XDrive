"""Portable upgrade state transitions with real confined file replacements.

Relocate absolute paths in a script copy. Stub systemd/Caddy/users, and use small
executable release fixtures that simulate schema changes. These are not actual
SQLite migrations, Linux deployment, HTTPS or crash/power-loss acceptance.
"""
import hashlib
import os
from pathlib import Path
import signal
import subprocess
import tarfile
import tempfile
import unittest
from release_archive_fixture import observe_extraction, replace_member_type


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xdrive-upgrade-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        source = (Path(__file__).resolve().parents[1] / "scripts/upgrade.sh").read_text()
        for prefix in ["/usr/local", "/etc", "/run", "/var/backups"]:
            source = source.replace(prefix, str(self.root) + prefix)
        self.script = self.root / "upgrade.sh"
        self.script.write_text(source)
        self.binary = self.root / "usr/local/libexec/xdrive/xdrive"
        self.configuration = self.root / "etc/xdrive/config.toml"
        self.site = self.root / "etc/caddy/Caddyfile.d/xdrive.caddy"
        self.database = self.root / "data/xdrive.db"
        self.rollback_hold = self.root / "etc/xdrive/.xdrive-upgrade-rollback-hold"
        self.state = self.root / "service-state"
        for path in [self.binary, self.configuration, self.site, self.database, self.root / "run/lock", self.root / "etc/systemd/system/xdrive.service"]:
            path.parent.mkdir(parents=True, exist_ok=True)
        (self.root / "etc/systemd/system/xdrive.service").write_text("managed unit fixture\n")
        self.configuration.write_text('database_path = "' + str(self.database) + '"\n')
        self.site.write_text('drive.invalid {\n  reverse_proxy 127.0.0.1:8787\n}\n')
        self.site_before = self.site.read_bytes()
        self.database.write_text("old-schema\n")
        self.state.write_text("old\n")
        self.binary.write_text('#!/usr/bin/env bash\n# old fixture\nprintf "xdrive v1.3.0 (fixture)\\n"\n')
        self.binary.chmod(0o755)
        self.old_binary = self.binary.read_bytes()
        for helper in ["upgrade.sh", "uninstall.sh"]:
            path = self.binary.parent / helper
            path.write_text("old " + helper + "\n")
            path.chmod(0o755)
        self.release = self.root / "release"
        self.release.mkdir()
        candidate = self.release / "xdrive"
        candidate.write_text('''#!/usr/bin/env bash
set -eu
printf "binary %s\\n" "$*" >> "$TEST_LOG"
case "$1" in
  version) printf "xdrive v1.3.1 (fixture)\\n" ;;
  snapshot-db) [[ -f "$TEST_HOLD" ]] || exit 77; cp "$TEST_DB" "${@: -1}" ;;
  migrate) printf "new-schema\\n" > "$TEST_DB"; [[ ${TEST_FAIL_MIGRATE:-0} == 0 ]] ;;
  doctor) [[ -f "$TEST_HOLD" && ${TEST_FAIL_DOCTOR:-0} == 0 ]] && python3 -c 'import os,sys; raise SystemExit((os.stat(sys.argv[1]).st_mode & 0o777) != 0o640)' "$TEST_HOLD" ;;
  *) exit 99 ;;
esac
''')
        candidate.chmod(0o755)
        self.new_binary = candidate.read_bytes()
        (self.release / "RELEASE.txt").write_text("os=linux\narchitecture=amd64\nversion=v1.3.1\n")
        for helper in ["install.sh", "upgrade.sh", "uninstall.sh"]:
            (self.release / helper).write_text("new " + helper + "\n")
        self.bundle = self.root / "release.tar.gz"
        with tarfile.open(self.bundle, "w:gz") as archive:
            for name in ["RELEASE.txt", "install.sh", "uninstall.sh", "upgrade.sh", "xdrive"]:
                archive.add(self.release / name, arcname=name)
        self.digest = hashlib.sha256(self.bundle.read_bytes()).hexdigest()
        self.commands = self.root / "commands"
        self.commands.mkdir()
        stubs = {
            "realpath": 'python3 -c \'import os,sys; print(os.path.realpath(sys.argv[-1]))\' "$@"',
            "id": 'printf "0\\n"',
            "uname": 'printf "x86_64\\n"',
            "dpkg": 'if [[ $1 == --print-architecture ]]; then printf "amd64\\n"; fi',
            "flock": "exit 0",
            "stat": 'if [[ $2 == %u ]]; then printf "%s\\n" "${TEST_LOCK_OWNER:-0}"; elif [[ $2 == %u:%G:%a ]]; then printf "%s:%s:%s\\n" "${TEST_CONFIG_DIR_OWNER:-0}" "${TEST_CONFIG_DIR_GROUP:-xdrive}" "${TEST_CONFIG_DIR_MODE:-750}"; else exit 99; fi',
            "sleep": "exit 0",
            "chown": '[[ ${TEST_FAIL_ROLLBACK:-0} == 0 ]]',
            "runuser": 'shift 3; exec "$@"',
            "install": '''args=()
directory=0
directory_mode=755
while (($#)); do
  case "$1" in
    -m) directory_mode=$2; shift 2 ;;
    -o|-g) shift 2 ;;
    -d) directory=1; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
if [[ $directory == 1 ]]; then
  mkdir -p "${args[@]}"
  chmod "$directory_mode" "${args[@]}"
  exit
fi
cp "${args[@]}"
chmod "$directory_mode" "${args[${#args[@]}-1]}"''',
            "systemctl": '''printf "systemctl %s\\n" "$*" >> "$TEST_LOG"
case "$1" in
  is-active) [[ ${@: -1} == caddy || $(cat "$TEST_STATE") != stopped ]] ;;
  stop) printf "stopped\\n" > "$TEST_STATE" ;;
  start)
    [[ ! -e "$TEST_HOLD" ]] || printf "rollback hold present at service start\\n" >> "$TEST_LOG"
    if grep -q 'old fixture' "$TEST_BINARY"; then printf "old\\n" > "$TEST_STATE";
    else
      [[ ${TEST_FAIL_START:-0} == 0 ]] || exit 1
      printf "new\\n" > "$TEST_STATE"
    fi ;;
  reload)
    if ! grep -q 'being upgraded' "$TEST_SITE" && [[ ${TEST_FAIL_PROXY_RESTORE:-0} == 1 ]]; then exit 1; fi ;;
  *) exit 99 ;;
esac''',
            "caddy": '''printf "caddy %s\\n" "$*" >> "$TEST_LOG"
if ! grep -q 'being upgraded' "$TEST_SITE" && [[ ${TEST_FAIL_PROXY_VALIDATE:-0} == 1 ]]; then exit 1; fi''',
            "curl": '''state=$(cat "$TEST_STATE")
printf "ready %s\\n" "$state" >> "$TEST_LOG"
[[ $state != stopped ]] || exit 1
if [[ $state == new ]]; then
  if [[ ${TEST_KILL_UPDATER_AT_READY:-0} == 1 ]]; then kill -KILL "$PPID"; exit 0; fi
  [[ -f "$TEST_HOLD" && ${TEST_FAIL_READY:-0} == 0 ]] && grep -q new-schema "$TEST_DB";
else grep -q old-schema "$TEST_DB"; fi''',
        }
        for name, body in stubs.items():
            path = self.commands / name
            path.write_text("#!/usr/bin/env bash\nset -eu\n" + body + "\n")
            path.chmod(0o755)
        self.environment = dict(os.environ, PATH=str(self.commands) + ":" + os.environ["PATH"], TEST_LOG=str(self.root / "commands.log"),
                                TEST_DB=str(self.database), TEST_HOLD=str(self.rollback_hold), TEST_STATE=str(self.state), TEST_BINARY=str(self.binary), TEST_SITE=str(self.site))

    def run_script(self, digest=None, **environment):
        return subprocess.run(["bash", str(self.script), "--bundle", str(self.bundle), "--sha256", digest or self.digest.upper()],
                              env=dict(self.environment, **environment), capture_output=True, text=True, timeout=25)

    def assert_rolled_back(self):
        self.assertEqual(self.database.read_text(), "old-schema\n")
        self.assertEqual(self.binary.read_bytes(), self.old_binary)
        for helper in ["upgrade.sh", "uninstall.sh"]:
            self.assertEqual((self.binary.parent / helper).read_text(), "old " + helper + "\n")
        self.assertEqual(self.state.read_text(), "old\n")
        self.assertEqual(self.site.read_bytes(), self.site_before)
        self.assertFalse(Path(str(self.binary) + ".candidate").exists())
        self.assertFalse(self.rollback_hold.exists())

    def test_dangling_candidates_reject_before_maintenance_and_preserve_links(self):
        for name in ["xdrive.candidate", "upgrade.sh.candidate", "uninstall.sh.candidate"]:
            with self.subTest(path=name):
                candidate = self.binary.parent / name
                target = self.root / "missing-candidate-target"
                candidate.symlink_to(target)
                result = self.run_script()
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertTrue(candidate.is_symlink())
                self.assertFalse(target.exists())
                self.assertEqual(self.binary.read_bytes(), self.old_binary)
                self.assertEqual(self.database.read_text(), "old-schema\n")
                self.assertEqual(self.site.read_bytes(), self.site_before)
                log = self.root / "commands.log"
                self.assertNotIn("systemctl stop", log.read_text() if log.exists() else "")
                candidate.unlink()

    def test_redirected_backup_directory_rejects_before_maintenance(self):
        path = self.root / "var/backups/xdrive"
        path.parent.mkdir(parents=True, exist_ok=True)
        target = self.root / "redirected-backups"
        target.mkdir()
        path.symlink_to(target, target_is_directory=True)
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertTrue(path.is_symlink())
        self.assertEqual(list(target.iterdir()), [])
        self.assertEqual(self.database.read_text(), "old-schema\n")
        self.assertEqual(self.site.read_bytes(), self.site_before)
        log = self.root / "commands.log"
        self.assertNotIn("systemctl stop", log.read_text() if log.exists() else "")

    def test_stale_upgrade_rollback_hold_rejects_before_maintenance(self):
        self.rollback_hold.write_text("interrupted upgrade\n")
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rollback hold remains", result.stderr)
        self.assertEqual(self.rollback_hold.read_text(), "interrupted upgrade\n")
        self.assertEqual(self.database.read_text(), "old-schema\n")
        self.assertEqual(self.binary.read_bytes(), self.old_binary)
        self.assertEqual(self.site.read_bytes(), self.site_before)
        log = self.root / "commands.log"
        self.assertNotIn("systemctl stop", log.read_text() if log.exists() else "")

    def test_service_writable_config_directory_rejects_before_maintenance(self):
        result = self.run_script(TEST_CONFIG_DIR_MODE="770")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rollback hold cannot be removed by the service user", result.stderr)
        self.assert_rolled_back()
        log = self.root / "commands.log"
        self.assertNotIn("systemctl stop", log.read_text() if log.exists() else "")

    def test_killed_updater_during_candidate_readiness_retains_hold_and_maintenance(self):
        result = self.run_script(TEST_KILL_UPDATER_AT_READY="1")
        self.assertEqual(result.returncode, -signal.SIGKILL, result.stdout + result.stderr)
        self.assertTrue(self.rollback_hold.is_file())
        self.assertEqual(self.rollback_hold.stat().st_mode & 0o777, 0o640)
        self.assertEqual(self.database.read_text(), "new-schema\n")
        self.assertEqual(self.state.read_text(), "new\n")
        self.assertIn("being upgraded", self.site.read_text())

        retry = self.run_script()
        self.assertNotEqual(retry.returncode, 0)
        self.assertIn("rollback hold remains", retry.stderr)
        self.assertTrue(self.rollback_hold.is_file())
        self.assertEqual(self.database.read_text(), "new-schema\n")
        self.assertIn("being upgraded", self.site.read_text())

    def test_redirected_existing_site_rejects_without_modifying_target(self):
        target = self.root / "external-site"
        self.site.rename(target)
        self.site.symlink_to(target)
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertEqual(target.read_bytes(), self.site_before)
        self.assertTrue(self.site.is_symlink())
        self.assertEqual(self.database.read_text(), "old-schema\n")
        log = self.root / "commands.log"
        self.assertNotIn("systemctl stop", log.read_text() if log.exists() else "")

    def test_success_activates_new_pair_and_preserves_old_snapshot(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.database.read_text(), "new-schema\n")
        self.assertEqual(self.binary.read_bytes(), self.new_binary)
        self.assertEqual(self.state.read_text(), "new\n")
        self.assertEqual(self.site.read_bytes(), self.site_before)
        log = self.root / "commands.log"
        self.assertIn("rollback hold present at service start", log.read_text())
        self.assertFalse(self.rollback_hold.exists())
        snapshots = list((self.root / "var/backups/xdrive").glob("upgrade-*/db.sqlite.snapshot"))
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0].read_text(), "old-schema\n")
        self.assertEqual((snapshots[0].parent / "xdrive.old").read_bytes(), self.old_binary)
        self.assertEqual((self.binary.parent / "upgrade.sh").read_text(), "new upgrade.sh\n")

    def test_nginx_mode_switches_only_its_upstream_include_for_maintenance(self):
        self.root.joinpath("etc/xdrive/proxy-mode").write_text("nginx\n")
        self.site = self.root / "etc/nginx/conf.d/xdrive-upstream.inc"
        self.site.parent.mkdir(parents=True, exist_ok=True)
        self.site.write_text("proxy_pass http://127.0.0.1:8787;\nproxy_buffering off;\n")
        self.site_before = self.site.read_bytes()
        self.environment["TEST_SITE"] = str(self.site)
        self.root.joinpath("etc/nginx/conf.d/xdrive.conf").write_text("server_name drive.invalid;\n")
        nginx = self.commands / "nginx"
        nginx.write_text('''#!/usr/bin/env bash
[[ $* == '-t' ]] || exit 98
printf "nginx validate\\n" >> "$TEST_LOG"
if ! grep -q 'being upgraded' "$TEST_SITE" && [[ ${TEST_FAIL_PROXY_VALIDATE:-0} == 1 ]]; then exit 1; fi
''')
        nginx.chmod(0o755)
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.site.read_bytes(), self.site_before)
        self.assertEqual(self.database.read_text(), "new-schema\n")
        self.assertIn("nginx validate", (self.root / "commands.log").read_text())
        self.assertIn("reload nginx", (self.root / "commands.log").read_text())
        self.assertNotIn("caddy validate", (self.root / "commands.log").read_text())

    def test_backup_parent_remains_service_traversable_and_rollback_snapshot_private(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        backup_root = self.root / "var/backups/xdrive"
        snapshots = list(backup_root.glob("upgrade-*/db.sqlite.snapshot"))
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(backup_root.stat().st_mode & 0o777, 0o750)
        self.assertEqual(snapshots[0].parent.stat().st_mode & 0o777, 0o700)

    def test_regular_operation_lock_is_not_truncated(self):
        lock = self.root / "run/xdrive-upgrade.lock"
        lock.write_bytes(b"existing-lock-bytes")
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(lock.read_bytes(), b"existing-lock-bytes")

    def test_nonregular_operation_lock_rejects_before_maintenance(self):
        lock = self.root / "run/xdrive-upgrade.lock"
        for kind in ["fifo", "directory"]:
            with self.subTest(kind=kind):
                if kind == "fifo": os.mkfifo(lock)
                else: lock.mkdir()
                result = self.run_script()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Unsafe upgrade operation lock", result.stderr)
                self.assert_rolled_back()
                if kind == "directory": lock.rmdir()
                else: lock.unlink()

    def test_nonroot_operation_lock_owner_rejects_without_truncating(self):
        lock = self.root / "run/xdrive-upgrade.lock"
        lock.write_bytes(b"unowned-lock-bytes")
        result = self.run_script(TEST_LOCK_OWNER="1234")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("root-owned", result.stderr)
        self.assertEqual(lock.read_bytes(), b"unowned-lock-bytes")
        self.assert_rolled_back()

    def test_other_database_basename_rejects_before_service_or_data_changes(self):
        self.configuration.write_text('database_path = "' + str(self.database.parent / "other.db") + '"\n')
        (self.database.parent / "other.db").write_text("old-schema\n")
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cannot safely identify", result.stderr)
        self.assert_rolled_back()
        log = self.root / "commands.log"
        self.assertNotIn("systemctl stop", log.read_text() if log.exists() else "")

    def test_database_symlink_rejects_before_service_or_data_changes(self):
        real = self.database.parent / "original-db"
        self.database.rename(real)
        self.database.symlink_to(real)
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cannot safely identify", result.stderr)
        self.assertTrue(self.database.is_symlink())
        self.assertEqual(real.read_text(), "old-schema\n")
        self.assert_rolled_back()
        log = self.root / "commands.log"
        self.assertNotIn("systemctl stop", log.read_text() if log.exists() else "")

    def test_database_parent_symlink_rejects_before_service_or_data_changes(self):
        parent = self.database.parent
        real = self.root / "original-data"
        parent.rename(real)
        parent.symlink_to(real, target_is_directory=True)
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cannot safely identify", result.stderr)
        self.assertTrue(parent.is_symlink())
        self.assert_rolled_back()
        log = self.root / "commands.log"
        self.assertNotIn("systemctl stop", log.read_text() if log.exists() else "")

    def test_partial_migration_failure_restores_old_pair(self):
        result = self.run_script(TEST_FAIL_MIGRATE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("restoring database and binary", result.stderr)
        self.assert_rolled_back()

    def test_doctor_failure_restores_old_pair(self):
        result = self.run_script(TEST_FAIL_DOCTOR="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_rolled_back()

    def test_new_service_start_failure_restores_old_pair(self):
        result = self.run_script(TEST_FAIL_START="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_rolled_back()

    def test_new_readiness_failure_restores_old_pair(self):
        result = self.run_script(TEST_FAIL_READY="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_rolled_back()

    def test_failed_rollback_keeps_maintenance_and_requires_manual_attention(self):
        result = self.run_script(TEST_FAIL_MIGRATE="1", TEST_FAIL_ROLLBACK="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("manual attention", result.stderr)
        self.assertIn("being upgraded", self.site.read_text())
        self.assertEqual(self.state.read_text(), "stopped\n")
        self.assertTrue(self.rollback_hold.is_file())
        self.assertTrue(list((self.root / "var/backups/xdrive").glob("upgrade-*/db.sqlite.snapshot")))

    def test_proxy_reload_failure_after_acceptance_does_not_rollback_new_pair(self):
        result = self.run_script(TEST_FAIL_PROXY_RESTORE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.database.read_text(), "new-schema\n")
        self.assertEqual(self.binary.read_bytes(), self.new_binary)
        self.assertFalse(self.rollback_hold.exists())
        self.assertIn("Could not restore the Caddy site", result.stderr)

    def test_proxy_validation_failure_is_reported_after_acceptance(self):
        result = self.run_script(TEST_FAIL_PROXY_VALIDATE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.database.read_text(), "new-schema\n")
        self.assertEqual(self.binary.read_bytes(), self.new_binary)
        self.assertFalse(self.rollback_hold.exists())
        self.assertIn("Could not restore the Caddy site", result.stderr)

    def test_bad_digest_changes_neither_service_nor_data(self):
        result = self.run_script(digest="0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA-256 mismatch", result.stderr)
        self.assert_rolled_back()
        log = self.root / "commands.log"
        self.assertNotIn("systemctl stop", log.read_text() if log.exists() else "")

    def test_nonregular_archive_member_rejects_before_maintenance(self):
        original = self.bundle.read_bytes()
        extracted = observe_extraction(self.root, self.commands)
        target = self.root / "outside"
        target.write_bytes(b"outside-preserved")
        for name, kind in [(name, kind) for name in ["RELEASE.txt", "xdrive", "install.sh", "upgrade.sh", "uninstall.sh"]
                           for kind in [tarfile.DIRTYPE, tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE]]:
            with self.subTest(name=name, kind=kind):
                self.bundle.write_bytes(original)
                replace_member_type(self.bundle, name, kind, target)
                self.digest = hashlib.sha256(self.bundle.read_bytes()).hexdigest()
                result = self.run_script()
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("invalid file types", result.stderr)
                self.assertFalse(extracted.exists(), "tar extraction ran before member validation")
                self.assert_rolled_back()
                self.assertEqual(target.read_bytes(), b"outside-preserved")
                log = self.root / "commands.log"
                self.assertNotIn("systemctl stop", log.read_text() if log.exists() else "")


if __name__ == "__main__":
    unittest.main()
