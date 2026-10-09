"""Portable script behavior tests; not a Linux/systemd installation rehearsal.

Fixed absolute installation paths in a test copy are relocated into an isolated
directory. System commands are stubbed; filesystem removals are real and confined
to that directory. Production has no environment switch or test-only bypass.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class UninstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xdrive-uninstall-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        source = (Path(__file__).resolve().parents[1] / "scripts/uninstall.sh").read_text()
        for prefix in ["/usr/local", "/etc", "/run", "/var/lib", "/var/backups"]:
            source = source.replace(prefix, str(self.root) + prefix)
        self.script = self.root / "uninstall.sh"
        self.script.write_text(source)
        self.data = self.root / "var/lib/xdrive"
        self.configuration = self.root / "etc/xdrive/config.toml"
        self.unit = self.root / "etc/systemd/system/xdrive.service"
        self.site = self.root / "etc/caddy/Caddyfile.d/xdrive.caddy"
        self.binary = self.root / "usr/local/libexec/xdrive/xdrive"
        self.launcher = self.root / "usr/local/bin/xdrive"
        self.backup = self.root / "var/backups/xdrive/snapshot"
        for path in [self.configuration, self.unit, self.site, self.binary, self.launcher, self.backup, self.root / "run/lock"]:
            path.parent.mkdir(parents=True, exist_ok=True)
        self.data.mkdir(parents=True)
        for name in ["xdrive.db", "server.secret", "objects/file"]:
            path = self.data / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"retained-encrypted-fixture")
        self.configuration.write_text(f'database_path = "{self.data}/xdrive.db"\nstorage_path = "{self.data}/objects"\nsecret_path = "{self.data}/server.secret"\n')
        self.unit.write_text(f"User=xdrive\nWorkingDirectory={self.data}\nExecStart={self.binary} serve --config {self.configuration}\n")
        self.site.write_text("drive.invalid { reverse_proxy 127.0.0.1:8787 }\n")
        self.binary.write_text("binary fixture")
        for name in ["upgrade.sh", "uninstall.sh"]:
            (self.binary.parent / name).write_text("helper fixture")
        self.launcher.symlink_to(self.binary)
        self.backup.write_text("backup fixture")
        self.commands = self.root / "commands"
        self.commands.mkdir()
        stubs = {
            "id": "printf '0\\n'",
            "uname": "printf 'Linux\\n'",
            "stat": 'if [[ ${@: -1} == */xdrive-upgrade.lock ]]; then printf "%s\\n" "${TEST_LOCK_OWNER:-0}"; else printf "0\\n"; fi',
            "flock": "exit 0",
            "getent": 'printf "xdrive:x:1900:1900::%s:/usr/sbin/nologin\\n" "${TEST_HOME}"',
            "findmnt": 'printf "%s\\n" "${TEST_MOUNT:-/}"',
            "realpath": 'python3 -c \'import os,sys; print(os.path.realpath(sys.argv[-1]))\' "$@"',
            "caddy": 'printf "caddy %s\\n" "$*" >> "$TEST_LOG"; [[ ${TEST_CADDY_FAIL:-0} == 0 ]]',
            "nginx": '''printf "nginx %s\\n" "$*" >> "$TEST_LOG"
[[ $* == '-t' ]] || exit 98
[[ ${TEST_NGINX_FAIL:-0} == 0 ]]''',
            "systemctl": '''printf "systemctl %s\\n" "$*" >> "$TEST_LOG"
case "$1" in
  show) printf '%s\\n' "$TEST_UNIT" ;;
  reload) [[ ${TEST_NGINX_RELOAD_FAIL:-0} == 0 ]] ;;
  disable) if [[ ${TEST_STOP_FAIL:-0} == 1 ]]; then exit 1; fi; touch "$TEST_STOPPED" ;;
  is-active) if [[ ${@: -1} == xdrive && -f $TEST_STOPPED ]]; then exit 3; fi ;;
esac''',
            # Darwin rm lacks GNU --one-file-system; mount guarding is exercised
            # separately. The remaining actual rm receives only relocated paths.
            "rm": '''args=()
for arg in "$@"; do [[ $arg == --one-file-system ]] || args+=("$arg"); done
/bin/rm "${args[@]}"''',
        }
        for name, body in stubs.items():
            path = self.commands / name
            path.write_text("#!/usr/bin/env bash\nset -eu\n" + body + "\n")
            path.chmod(0o755)
        self.environment = dict(os.environ, PATH=str(self.commands) + ":" + os.environ["PATH"], TEST_LOG=str(self.root / "commands.log"), TEST_UNIT=str(self.unit), TEST_STOPPED=str(self.root / "stopped"), TEST_HOME=str(self.data))

    def run_script(self, *args, **environment):
        return subprocess.run(["bash", str(self.script), *args], env=dict(self.environment, **environment), capture_output=True, text=True, timeout=10)

    def use_nginx_mode(self):
        caddy_site = self.root / "etc/caddy/Caddyfile.d/xdrive.caddy"
        caddy_site.unlink()
        (self.configuration.parent / "proxy-mode").write_text("nginx\n")
        (self.configuration.parent / "tls-mode").write_text("external\n")
        conf_dir = self.root / "etc/nginx/conf.d"
        conf_dir.mkdir(parents=True, exist_ok=True)
        self.site = conf_dir / "xdrive-upstream.inc"
        self.site.write_text("proxy_pass http://127.0.0.1:8787;\nproxy_buffering off;\n")
        self.nginx_site = conf_dir / "xdrive.conf"
        self.nginx_site.write_text("server_name drive.invalid;\n")

    def test_default_preserves_data_and_backups(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.data / "objects/file").exists())
        self.assertTrue(self.backup.exists())
        self.assertFalse(self.unit.exists())
        self.assertFalse(self.configuration.exists())
        self.assertFalse(self.site.exists())
        self.assertFalse(self.binary.exists())
        self.assertFalse(self.launcher.is_symlink())
        log = (self.root / "commands.log").read_text()
        self.assertLess(log.index("caddy validate"), log.index("disable --now xdrive"))
        self.assertIn("daemon-reload", log)

    def test_nginx_uninstall_removes_only_xdrive_vhost_and_upstream_include(self):
        self.use_nginx_mode()
        other_site = self.root / "etc/nginx/conf.d/original-site.conf"
        other_site.write_text("server_name existing.example.com;\n")
        original = other_site.read_bytes()
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(other_site.read_bytes(), original)
        self.assertFalse(self.site.exists())
        self.assertFalse(self.nginx_site.exists())
        self.assertFalse((self.configuration.parent / "proxy-mode").exists())
        self.assertFalse((self.configuration.parent / "tls-mode").exists())
        self.assertTrue((self.data / "objects/file").exists())
        log = (self.root / "commands.log").read_text()
        self.assertIn("nginx -t", log)
        self.assertIn("systemctl reload nginx", log)
        self.assertNotIn("caddy validate", log)

    def test_partial_nginx_install_can_be_uninstalled_after_site_files_were_rolled_back(self):
        self.use_nginx_mode()
        self.site.unlink()
        self.nginx_site.unlink()
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.binary.exists())
        self.assertFalse(self.configuration.exists())
        self.assertTrue((self.data / "objects/file").exists())
        log = (self.root / "commands.log").read_text()
        self.assertNotIn("nginx -t", log)
        self.assertNotIn("systemctl reload nginx", log)

    def test_nginx_reload_failure_restores_managed_proxy_files_without_stopping_xdrive(self):
        self.use_nginx_mode()
        include_before = self.site.read_bytes()
        vhost_before = self.nginx_site.read_bytes()
        result = self.run_script(TEST_NGINX_RELOAD_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.site.read_bytes(), include_before)
        self.assertEqual(self.nginx_site.read_bytes(), vhost_before)
        self.assertTrue(self.configuration.exists())
        self.assertFalse((self.root / "stopped").exists())

    def test_symlinked_operation_lock_rejects_without_truncating_external_file(self):
        victim = self.root / "outside-lock-target"
        victim.write_bytes(b"outside-lock-bytes")
        lock = self.root / "run/xdrive-upgrade.lock"
        lock.symlink_to(victim)
        result = self.run_script()
        self.assertEqual(victim.read_bytes(), b"outside-lock-bytes")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(lock.is_symlink())
        self.assertTrue(self.binary.exists())
        self.assertTrue(self.site.exists())
        self.assertFalse((self.root / "stopped").exists())

    def test_regular_operation_lock_is_not_truncated(self):
        lock = self.root / "run/xdrive-upgrade.lock"
        lock.write_bytes(b"existing-lock-bytes")
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(lock.read_bytes(), b"existing-lock-bytes")

    def test_nonregular_operation_lock_rejects_without_stopping_service(self):
        lock = self.root / "run/xdrive-upgrade.lock"
        for kind in ["fifo", "directory", "dangling-link"]:
            with self.subTest(kind=kind):
                if kind == "fifo": os.mkfifo(lock)
                elif kind == "directory": lock.mkdir()
                else: lock.symlink_to(self.root / "missing-lock")
                result = self.run_script()
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertIn("Unsafe uninstall operation lock", result.stderr)
                self.assertTrue(self.binary.exists())
                self.assertFalse((self.root / "stopped").exists())
                if kind == "directory": lock.rmdir()
                else: lock.unlink()

    def test_nonroot_operation_lock_owner_rejects_without_truncating(self):
        lock = self.root / "run/xdrive-upgrade.lock"
        lock.write_bytes(b"unowned-lock-bytes")
        result = self.run_script(TEST_LOCK_OWNER="1234")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("root-owned", result.stderr)
        self.assertEqual(lock.read_bytes(), b"unowned-lock-bytes")
        self.assertTrue(self.binary.exists())

    def test_explicit_delete_removes_only_data_and_preserves_external_symlink_target(self):
        outside = self.root / "keep-me"
        outside.write_text("outside fixture")
        (self.data / "linked-file").symlink_to(outside)
        result = self.run_script("--delete-data", "--confirm-data-dir", str(self.data))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.data.exists())
        self.assertTrue(self.backup.exists())
        self.assertTrue(outside.exists())

    def test_missing_or_incorrect_confirmation_changes_nothing(self):
        for args in [("--delete-data",), ("--confirm-data-dir", str(self.data)), ("--delete-data", "--confirm-data-dir", "/")]:
            with self.subTest(args=args):
                self.assertNotEqual(self.run_script(*args).returncode, 0)
                self.assertTrue(self.site.exists())
                self.assertTrue(self.binary.exists())
                self.assertTrue(self.data.exists())

    def test_dry_run_changes_nothing(self):
        result = self.run_script("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.unit.exists())
        self.assertTrue(self.site.exists())
        self.assertFalse((self.root / "stopped").exists())

    def test_mountpoint_rejection_precedes_mutation(self):
        for mount in [str(self.data), str(self.data / "objects")]:
            result = self.run_script("--delete-data", "--confirm-data-dir", str(self.data), TEST_MOUNT=mount)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("mount point", result.stderr)
            self.assertTrue(self.site.exists())

    def test_symlinked_data_root_is_rejected(self):
        target = self.root / "actual-data"
        self.data.rename(target)
        self.data.symlink_to(target, target_is_directory=True)
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.site.exists())
        self.assertTrue(target.exists())

    def test_redirected_unit_parent_preserves_external_unit_and_installation(self):
        original = self.unit.parent
        external = self.root / "external-units"
        original.rename(external)
        original.symlink_to(external, target_is_directory=True)
        result = self.run_script()
        self.assertTrue((external / "xdrive.service").exists(), "external unit was deleted")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.binary.exists())
        self.assertTrue(self.site.exists())
        self.assertFalse((self.root / "stopped").exists())

    def test_redirected_launcher_parent_preserves_external_launcher_and_installation(self):
        original = self.launcher.parent
        external = self.root / "external-launchers"
        original.rename(external)
        original.symlink_to(external, target_is_directory=True)
        result = self.run_script()
        self.assertTrue((external / "xdrive").is_symlink(), "external launcher was deleted")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.binary.exists())
        self.assertTrue(self.site.exists())
        self.assertFalse((self.root / "stopped").exists())

    def test_unrelated_account_and_unit_are_rejected(self):
        result = self.run_script(TEST_HOME="/home/unrelated")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.site.exists())
        self.unit.write_text("User=another-user\n")
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertTrue(self.site.exists())

    def test_failed_proxy_validation_restores_site_and_never_stops_drive(self):
        before = self.site.read_bytes()
        result = self.run_script(TEST_CADDY_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.site.read_bytes(), before)
        self.assertFalse((self.root / "stopped").exists())
        self.assertTrue(self.binary.exists())

    def test_failed_stop_preserves_configuration_and_restores_site(self):
        before = self.site.read_bytes()
        result = self.run_script(TEST_STOP_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.site.read_bytes(), before)
        self.assertTrue(self.configuration.exists())
        self.assertTrue(self.data.exists())


if __name__ == "__main__":
    unittest.main()
