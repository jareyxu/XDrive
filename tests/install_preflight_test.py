"""Portable installer preflight checks, not Linux/systemd deployment evidence.

Relocate a copy's installation paths into a disposable directory. Commands that
inspect the host are stubbed; stop at mktemp before archive or installation work.
Production has no test bypass. The original command order and port checks run.
"""
import os
import pty
from pathlib import Path
import subprocess
import tempfile
import unittest


class InstallPreflightTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xdrive-install-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        source = (Path(__file__).resolve().parents[1] / "scripts/install.sh").read_text()
        for prefix in ["/usr/local", "/etc", "/run", "/var/lib", "/var/backups"]:
            source = source.replace(prefix, str(self.root) + prefix)
        self.script = self.root / "install.sh"
        self.script.write_text(source)
        release = self.root / "etc/os-release"
        release.parent.mkdir(parents=True)
        release.write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
        self.data = self.root / "var/lib/xdrive"
        self.commands = self.root / "commands"
        self.commands.mkdir()
        stubs = {
            "id": 'if [[ ${1:-} == -u ]]; then printf "0\\n"; else exit 1; fi',
            "uname": 'printf "x86_64\\n"',
            "dpkg": 'printf "amd64\\n"',
            "realpath": 'python3 -c \'import os,sys; print(os.path.realpath(sys.argv[-1]))\' "$@"',
            "sha256sum": "exit 99",
            "ss": 'printf "%s\\n" "${TEST_LISTENERS:-}"; exit "${TEST_SS_EXIT:-0}"',
            "systemctl": '''printf "systemctl %s\\n" "$*" >> "$TEST_LOG"
if [[ $* == 'is-active --quiet nginx' ]]; then [[ ${TEST_NGINX_ACTIVE:-0} == 1 ]]; exit; fi
[[ $* == 'is-active --quiet caddy' ]] || exit 99
[[ ${TEST_CADDY_ACTIVE:-1} == 1 ]]''',
            "nginx": '''if [[ $* == '-T' ]]; then
  printf 'include %s/etc/nginx/conf.d/*.conf;\\n' "$TEST_ROOT"
  if [[ -n ${TEST_NGINX_SERVER_NAMES:-} ]]; then printf '%s\\n' "$TEST_NGINX_SERVER_NAMES"; fi
  exit 0
fi
[[ $* == '-t' ]]''',
            "mktemp": 'printf "preflight-complete\\n" >> "$TEST_LOG"; exit 78',
        }
        for name in ["install", "useradd", "apt-get", "curl", "chown", "chmod"]:
            stubs[name] = 'printf "MUTATION %s\\n" "$0 $*" >> "$TEST_LOG"; exit 99'
        for name, body in stubs.items():
            path = self.commands / name
            path.write_text("#!/usr/bin/env bash\nset -eu\n" + body + "\n")
            path.chmod(0o755)
        (self.root / "etc/nginx/conf.d").mkdir(parents=True)
        self.environment = dict(os.environ, PATH=str(self.commands) + ":" + os.environ["PATH"], TEST_LOG=str(self.root / "commands.log"), TEST_ROOT=str(self.root))

    def run_script(self, proxy="caddy", **environment):
        return subprocess.run(["bash", str(self.script), "--bundle", str(self.root / "release.tar.gz"), "--sha256", "a" * 64,
                               "--domain", "drive.invalid", "--proxy", proxy, *(["--tls-email", "admin@example.invalid"] if proxy == "nginx" else []),
                               "--username", "admin", "--data-dir", str(self.data)],
                              env=dict(self.environment, **environment), capture_output=True, text=True, timeout=10)

    def run_interactive_script(self, user_input, **environment):
        command = ["bash", str(self.script), "--bundle", str(self.root / "release.tar.gz"), "--sha256", "a" * 64,
                   "--username", "admin", "--data-dir", str(self.data)]
        master, slave = pty.openpty()
        try:
            process = subprocess.Popen(command, env=dict(self.environment, **environment), stdin=slave,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            os.close(slave)
            slave = -1
            os.write(master, user_input.encode())
            stdout, stderr = process.communicate(timeout=10)
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        finally:
            if slave >= 0:
                os.close(slave)
            os.close(master)

    def assert_no_installation(self):
        log = self.root / "commands.log"
        self.assertNotIn("MUTATION", log.read_text() if log.exists() else "")
        self.assertFalse(self.data.exists())
        self.assertFalse((self.root / "etc/xdrive").exists())
        self.assertFalse((self.root / "usr/local").exists())

    def test_dangling_managed_entries_reject_before_archive_or_changes(self):
        for relative in ["etc/xdrive/config.toml", "etc/systemd/system/xdrive.service",
                         "usr/local/libexec/xdrive/xdrive", "usr/local/bin/xdrive",
                         "etc/caddy/Caddyfile.d/xdrive.caddy"]:
            with self.subTest(path=relative):
                path = self.root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                target = self.root / "missing-target"
                path.symlink_to(target)
                result = self.run_script()
                self.assertEqual(result.returncode, 1, result.stderr)
                log = self.root / "commands.log"
                self.assertNotIn("preflight-complete", log.read_text() if log.exists() else "")
                self.assertTrue(path.is_symlink())
                self.assertFalse(target.exists())
                path.unlink()

    def test_redirected_managed_directory_rejects_before_archive_or_changes(self):
        for relative in ["etc/xdrive", "usr/local/libexec/xdrive", "etc/caddy/Caddyfile.d"]:
            with self.subTest(path=relative):
                path = self.root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                target = self.root / "redirected-directory"
                target.mkdir(exist_ok=True)
                path.symlink_to(target, target_is_directory=True)
                result = self.run_script()
                self.assertEqual(result.returncode, 1, result.stderr)
                log = self.root / "commands.log"
                self.assertNotIn("preflight-complete", log.read_text() if log.exists() else "")
                self.assertEqual(list(target.iterdir()), [])
                path.unlink()

    def test_backend_port_rejects_ipv4_ipv6_and_wildcard_before_changes(self):
        for address in ["127.0.0.1:8787", "0.0.0.0:8787", "[::1]:8787", "*:8787"]:
            with self.subTest(address=address):
                result = self.run_script(TEST_LISTENERS="LISTEN 0 128 " + address + " *:*")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("backend port 8787", result.stderr)
                self.assert_no_installation()

    def test_failed_port_inspection_rejects_even_with_empty_output(self):
        result = self.run_script(TEST_SS_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not inspect", result.stderr)
        self.assert_no_installation()

    def test_inactive_caddy_rejects_occupied_public_port(self):
        result = self.run_script(TEST_CADDY_ACTIVE="0", TEST_LISTENERS="LISTEN 0 128 [::]:443 *:*")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Port 80 or 443", result.stderr)
        self.assert_no_installation()

    def test_existing_caddy_can_keep_public_ports(self):
        result = self.run_script(TEST_LISTENERS="LISTEN 0 128 0.0.0.0:80 *:*\nLISTEN 0 128 [::]:443 *:*")
        self.assertEqual(result.returncode, 78, result.stderr)
        self.assertIn("preflight-complete", (self.root / "commands.log").read_text())
        self.assert_no_installation()

    def test_active_nginx_is_supported_without_stopping_its_listeners(self):
        result = self.run_script(proxy="nginx", TEST_NGINX_ACTIVE="1",
                                 TEST_LISTENERS="LISTEN 0 511 0.0.0.0:80 *:*\nLISTEN 0 511 0.0.0.0:443 *:*")
        self.assertEqual(result.returncode, 78, result.stderr)
        self.assertIn("preflight-complete", (self.root / "commands.log").read_text())
        self.assert_no_installation()

    def test_interactive_domain_and_tls_email_prompt_auto_selects_active_nginx(self):
        result = self.run_interactive_script("drive.example.invalid\nadmin@example.invalid\n",
                                             TEST_NGINX_ACTIVE="1",
                                             TEST_LISTENERS="LISTEN 0 511 0.0.0.0:80 *:*\nLISTEN 0 511 0.0.0.0:443 *:*")
        self.assertEqual(result.returncode, 78, result.stdout + result.stderr)
        self.assertIn("XDrive domain", result.stderr)
        self.assertIn("Email for Let's Encrypt certificate", result.stderr)
        self.assertIn("preflight-complete", (self.root / "commands.log").read_text())
        self.assert_no_installation()

    def test_nginx_domain_collision_rejects_before_any_installation_changes(self):
        result = self.run_script(proxy="nginx", TEST_NGINX_ACTIVE="1",
                                 TEST_NGINX_SERVER_NAMES="server_name drive.invalid;")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("already appears in an Nginx server_name", result.stderr)
        self.assert_no_installation()

    def test_free_ports_and_unrelated_ports_reach_archive_stage(self):
        for active in ["0", "1"]:
            with self.subTest(active=active):
                result = self.run_script(TEST_CADDY_ACTIVE=active, TEST_LISTENERS="LISTEN 0 128 127.0.0.1:18787 *:*")
                self.assertEqual(result.returncode, 78, result.stderr)
                self.assert_no_installation()


if __name__ == "__main__":
    unittest.main()
