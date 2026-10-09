"""Installer completion regression using the actual locally compiled XDrive CLI.

Host/package/systemd commands are confined stubs, not Linux deployment evidence.
The installer, archive extraction, generated files and setup-token CLI run for real.
"""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from release_archive_fixture import observe_extraction, replace_member_type


ROOT = Path(__file__).resolve().parents[1]


class InstallCompletionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix="xdrive-install-cli-")
        cls.addClassCleanup(cls.build.cleanup)
        cls.binary = Path(cls.build.name) / "xdrive"
        subprocess.run(["go", "build", "-ldflags", "-X main.version=v1.3.1-rc.fixture",
                        "-o", str(cls.binary), "./cmd/xdrive"], cwd=ROOT, check=True)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xdrive-install-completion-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.commands = self.root / "commands"
        self.commands.mkdir()
        source = (ROOT / "scripts/install.sh").read_text()
        for prefix in ["/usr/local", "/etc", "/run", "/var/lib", "/var/backups"]:
            source = source.replace(prefix, str(self.root) + prefix)
        self.script = self.root / "install.sh"
        self.script.write_text(source)
        (self.root / "etc/caddy").mkdir(parents=True)
        (self.root / "etc/nginx/conf.d").mkdir(parents=True)
        (self.root / "usr/local/bin").mkdir(parents=True)
        (self.root / "etc/systemd/system").mkdir(parents=True)
        (self.root / "etc/caddy/Caddyfile").write_text(":80 { respond \"fixture\" }\n")
        self.caddy_before = (self.root / "etc/caddy/Caddyfile").read_bytes()
        (self.root / "etc/os-release").write_text('ID=debian\nVERSION_ID="12"\n')
        stage = self.root / "stage"
        stage.mkdir()
        shutil.copy2(self.binary, stage / "xdrive")
        for name in ["install.sh", "upgrade.sh", "uninstall.sh"]:
            shutil.copy2(ROOT / "scripts" / name, stage / name)
        (stage / "RELEASE.txt").write_text("version=v1.3.1-rc.fixture\nos=linux\narchitecture=amd64\n")
        self.bundle = self.root / "release.tar.gz"
        with tarfile.open(self.bundle, "w:gz") as archive:
            for path in stage.iterdir():
                archive.add(path, arcname=path.name)
        stubs = {
            "id": '[[ ${1:-} == -u ]] && { printf "0\\n"; exit 0; }; exit 1',
            "uname": 'printf "x86_64\\n"',
            "dpkg": 'printf "amd64\\n"',
            "realpath": 'python3 -c \'import os,sys; print(os.path.realpath(sys.argv[-1]))\' "$@"',
            "sha256sum": 'printf "%064d  fixture\\n" 0',
            "ss": "exit 0",
            "systemctl": '''if [[ $* == 'is-active --quiet caddy' && ${TEST_CADDY_ACTIVE:-1} == 0 ]]; then exit 1; fi
if [[ $* == 'is-active --quiet nginx' ]]; then [[ ${TEST_NGINX_ACTIVE:-0} == 1 ]]; exit; fi
if [[ $* == 'reload caddy' ]]; then
  printf 'reload\\n' >> "$TEST_RELOAD_LOG"
  [[ ${TEST_FAIL_RELOAD_ALWAYS:-0} == 0 ]] || exit 1
  if [[ ${TEST_FAIL_RELOAD:-0} == 1 && ! -e $TEST_RELOAD_FAILED ]]; then
    touch "$TEST_RELOAD_FAILED"; exit 1
  fi
fi
if [[ $* == 'enable --now caddy' && ${TEST_FAIL_CADDY_START:-0} == 1 ]]; then exit 1; fi
if [[ $* == 'enable --now xdrive' ]]; then
"$TEST_BINARY" migrate --config "$TEST_CONFIG" >/dev/null
fi''',
            "curl": "exit 0",
            "caddy": '[[ ${TEST_FAIL_CADDY_VALIDATE:-0} == 0 ]]',
            "nginx": '''if [[ $* == '-T' ]]; then
  printf 'include %s/etc/nginx/conf.d/*.conf;\\n' "$TEST_ROOT"
  if [[ -n ${TEST_NGINX_SERVER_NAMES:-} ]]; then printf '%s\\n' "$TEST_NGINX_SERVER_NAMES"; fi
  exit 0
fi
[[ $* == '-t' ]] || exit 98
printf 'nginx-test\\n' >> "$TEST_RELOAD_LOG"
[[ ${TEST_FAIL_NGINX_TEST:-0} == 0 ]]''',
            "certbot": '''[[ $1 == certonly ]] || exit 98
printf '%s\\n' "$*" >> "$TEST_CERTBOT_LOG"
mkdir -p "$TEST_LE_LIVE/drive.invalid"
printf 'fixture certificate\\n' > "$TEST_LE_LIVE/drive.invalid/fullchain.pem"
printf 'fixture key\\n' > "$TEST_LE_LIVE/drive.invalid/privkey.pem"''',
            "useradd": "exit 0",
            "chown": "exit 0",
            "runuser": '''[[ $1 == -u && $2 == xdrive && $3 == -- ]] || exit 99
shift 3
if [[ -n ${TEST_CLI_OUTPUT:-} ]]; then printf '%s\\n' "$TEST_CLI_OUTPUT"; exit 0; fi
"$@" | tee "$TEST_SETUP_CAPTURE"''',
        }
        for name, body in stubs.items():
            path = self.commands / name
            path.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + body + "\n")
            path.chmod(0o755)
        # Retain real confined mkdir/copy/mode changes; only unavailable owner
        # identities are ignored by this portable harness.
        path = self.commands / "install"
        path.write_text("""#!/usr/bin/env python3
import os,pathlib,shutil,sys
args=sys.argv[1:]; directories=False; mode=0o755; values=[]
while args:
    arg=args.pop(0)
    if arg=='-d': directories=True
    elif arg in ('-m','-o','-g'):
        value=args.pop(0)
        if arg=='-m': mode=int(value,8)
    else: values.append(arg)
if directories:
    for value in values: pathlib.Path(value).mkdir(parents=True,exist_ok=True); os.chmod(value,mode)
else:
    assert len(values)==2
    shutil.copyfile(*values); os.chmod(values[-1],mode)
""")
        path.chmod(0o755)
        self.capture = self.root / "setup-output"
        self.environment = dict(os.environ, PATH=str(self.commands) + ":" + os.environ["PATH"],
                                TEST_SETUP_CAPTURE=str(self.capture), TEST_BINARY=str(self.binary),
                                TEST_RELOAD_LOG=str(self.root / "reload.log"), TEST_RELOAD_FAILED=str(self.root / "reload-failed"),
                                TEST_CONFIG=str(self.root / "etc/xdrive/config.toml"), TEST_ROOT=str(self.root),
                                TEST_CERTBOT_LOG=str(self.root / "certbot.log"), TEST_LE_LIVE=str(self.root / "etc/letsencrypt/live"))

    def run_script(self, output=None, proxy="caddy", tls_args=(), **changes):
        environment = dict(self.environment, **changes)
        if output is not None:
            environment["TEST_CLI_OUTPUT"] = output
        return subprocess.run(["bash", str(self.script), "--bundle", str(self.bundle), "--sha256", "0" * 64,
                               "--domain", "drive.invalid", "--proxy", proxy, *tls_args,
                               "--username", "admin", "--data-dir", str(self.root / "var/lib/xdrive")], env=environment,
                              capture_output=True, text=True, timeout=30)

    def test_actual_cli_token_becomes_exact_https_setup_link_without_explanation(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        emitted = self.capture.read_text()
        token = re.fullmatch(r"Open /setup#([A-Za-z0-9_-]+) within 24 hours to configure XDrive\.\n", emitted)[1]
        self.assertIn("https://drive.invalid/setup#" + token + "\n", result.stdout)
        self.assertNotIn("within 24 hours", result.stdout)
        self.assertTrue((self.root / "var/lib/xdrive/xdrive.db").is_file())
        self.assertTrue((self.root / "etc/systemd/system/xdrive.service").is_file())

    def test_nginx_mode_installs_isolated_vhost_and_uses_certbot_without_touching_other_sites(self):
        other_site = self.root / "etc/nginx/conf.d/original-site.conf"
        other_site.write_text("server { server_name existing.example.com; }\n")
        original = other_site.read_bytes()
        result = self.run_script(proxy="nginx", tls_args=("--tls-email", "admin@example.invalid"), TEST_NGINX_ACTIVE="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        site = (self.root / "etc/nginx/conf.d/xdrive.conf").read_text()
        upstream = (self.root / "etc/nginx/conf.d/xdrive-upstream.inc").read_text()
        self.assertIn("server_name drive.invalid;", site)
        self.assertIn("return 308 https://$host$request_uri;", site)
        self.assertIn("ssl_certificate " + str(self.root / "etc/letsencrypt/live/drive.invalid/fullchain.pem"), site)
        self.assertIn("include " + str(self.root / "etc/nginx/conf.d/xdrive-upstream.inc"), site)
        self.assertIn("proxy_pass http://127.0.0.1:8787;", upstream)
        self.assertIn("proxy_request_buffering off;", upstream)
        self.assertIn("client_max_body_size 32m;", upstream)
        self.assertEqual(other_site.read_bytes(), original)
        self.assertEqual((self.root / "etc/xdrive/proxy-mode").read_text(), "nginx\n")
        self.assertEqual((self.root / "etc/xdrive/tls-mode").read_text(), "certbot\n")
        self.assertTrue((self.root / "etc/letsencrypt/renewal-hooks/deploy/xdrive-nginx-reload").is_file())
        self.assertFalse((self.root / "etc/caddy/Caddyfile.d/xdrive.caddy").exists())
        self.assertIn("https://drive.invalid/setup#", result.stdout)

    def test_nginx_failure_removes_only_xdrive_site_files(self):
        other_site = self.root / "etc/nginx/conf.d/original-site.conf"
        other_site.write_text("server { server_name existing.example.com; }\n")
        original = other_site.read_bytes()
        result = self.run_script(proxy="nginx", tls_args=("--tls-email", "admin@example.invalid"),
                                 TEST_NGINX_ACTIVE="1", TEST_FAIL_NGINX_TEST="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(other_site.read_bytes(), original)
        self.assertFalse((self.root / "etc/nginx/conf.d/xdrive.conf").exists())
        self.assertFalse((self.root / "etc/nginx/conf.d/xdrive-upstream.inc").exists())
        self.assertFalse((self.root / "etc/letsencrypt/renewal-hooks/deploy/xdrive-nginx-reload").exists())

    def test_nonregular_archive_member_rejects_before_extraction_or_installation(self):
        original = self.bundle.read_bytes()
        extracted = observe_extraction(self.root, self.commands)
        target = self.root / "outside"
        target.write_bytes(b"outside-preserved")
        for name, kind in [(name, kind) for name in ["RELEASE.txt", "xdrive", "install.sh", "upgrade.sh", "uninstall.sh"]
                           for kind in [tarfile.DIRTYPE, tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE]]:
            with self.subTest(name=name, kind=kind):
                self.bundle.write_bytes(original)
                replace_member_type(self.bundle, name, kind, target)
                result = self.run_script()
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("invalid file types", result.stderr)
                self.assertFalse(extracted.exists(), "tar extraction ran before member validation")
                self.assertFalse((self.root / "usr/local/libexec/xdrive").exists())
                self.assertFalse((self.root / "var/lib/xdrive").exists())
                self.assertEqual(target.read_bytes(), b"outside-preserved")

    def test_missing_fragment_is_rejected_instead_of_printing_a_false_link(self):
        result = self.run_script("unrecognized-output")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not extract setup token", result.stderr)
        self.assertNotIn("https://drive.invalid/setup#", result.stdout)

    def test_invalid_token_character_is_not_silently_truncated(self):
        result = self.run_script("Open /setup#valid_prefix!invalid within 24 hours to configure XDrive.")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not extract setup token", result.stderr)
        self.assertNotIn("https://drive.invalid/setup#", result.stdout)

    def assert_caddy_config_restored_and_data_retained(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / "etc/caddy/Caddyfile").read_bytes(), self.caddy_before)
        self.assertFalse((self.root / "etc/caddy/Caddyfile.d/xdrive.caddy").exists())
        self.assertTrue((self.root / "var/lib/xdrive/xdrive.db").is_file())
        self.assertTrue((self.root / "usr/local/libexec/xdrive/xdrive").is_file())
        self.assertNotIn("https://drive.invalid/setup#", result.stdout)
        self.assertFalse(self.capture.exists())

    def test_caddy_reload_failure_restores_existing_config_and_reloads_it(self):
        result = self.run_script(TEST_FAIL_RELOAD="1")
        self.assert_caddy_config_restored_and_data_retained(result)
        self.assertEqual((self.root / "reload.log").read_text(), "reload\nreload\n")
        self.assertIn("could not activate", result.stderr)

    def test_caddy_start_failure_restores_existing_config_without_false_setup_link(self):
        result = self.run_script(TEST_CADDY_ACTIVE="0", TEST_FAIL_CADDY_START="1")
        self.assert_caddy_config_restored_and_data_retained(result)
        self.assertFalse((self.root / "reload.log").exists())
        self.assertIn("could not activate", result.stderr)

    def test_caddy_validation_failure_restores_existing_config(self):
        result = self.run_script(TEST_FAIL_CADDY_VALIDATE="1")
        self.assert_caddy_config_restored_and_data_retained(result)
        self.assertIn("Caddy rejected", result.stderr)

    def test_failed_recovery_reload_keeps_original_config_and_reports_failure(self):
        result = self.run_script(TEST_FAIL_RELOAD_ALWAYS="1")
        self.assert_caddy_config_restored_and_data_retained(result)
        self.assertEqual((self.root / "reload.log").read_text(), "reload\nreload\n")
        self.assertIn("Could not reload the prior Caddy configuration", result.stderr)

    def test_existing_import_is_preserved_when_caddy_activation_fails(self):
        main = self.root / "etc/caddy/Caddyfile"
        main.write_text(main.read_text() + 'import ' + str(self.root / 'etc/caddy/Caddyfile.d') + '/*\n')
        self.caddy_before = main.read_bytes()
        unrelated = self.root / "etc/caddy/Caddyfile.d/other.caddy"
        unrelated.parent.mkdir(parents=True)
        unrelated.write_bytes(b'other.invalid { respond "unrelated" }\n')
        result = self.run_script(TEST_FAIL_RELOAD="1")
        self.assert_caddy_config_restored_and_data_retained(result)
        self.assertEqual(unrelated.read_bytes(), b'other.invalid { respond "unrelated" }\n')


if __name__ == "__main__":
    unittest.main()
