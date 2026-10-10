#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s (--bundle FILE | --release-url HTTPS_URL) --sha256 TRUSTED_HEX [--expected-version VERSION]\n' "$0" >&2
  exit 2
}

bundle=''
release_url=''
expected_digest=''
expected_version=''
while (($#)); do
  case "$1" in
    --bundle|--release-url|--sha256|--expected-version)
      (($# >= 2)) || usage
      case "$1" in
        --bundle) bundle=$2 ;;
        --release-url) release_url=$2 ;;
        --sha256) expected_digest=$2 ;;
        --expected-version) expected_version=$2 ;;
      esac
      shift 2 ;;
    *) usage ;;
  esac
done
[[ $(id -u) -eq 0 ]] || { printf 'Run this updater as root.\n' >&2; exit 1; }
[[ -n $bundle && -z $release_url || -z $bundle && -n $release_url ]] || usage
[[ $expected_digest =~ ^[0-9a-fA-F]{64}$ ]] || usage
expected_digest=$(printf '%s' "$expected_digest" | tr '[:upper:]' '[:lower:]')
[[ -z $release_url || $release_url == https://* ]] || usage
for command_name in sha256sum tar curl systemctl runuser flock realpath stat; do
  command -v "$command_name" >/dev/null || { printf 'Missing required tool: %s\n' "$command_name" >&2; exit 1; }
done
case "$(uname -m)" in
  x86_64) architecture=amd64 ;;
  aarch64) architecture=arm64 ;;
  *) printf 'Unsupported CPU architecture.\n' >&2; exit 1 ;;
esac
[[ $(dpkg --print-architecture) == "$architecture" ]] || { printf 'CPU and package architecture disagree.\n' >&2; exit 1; }

application_dir=/usr/local/libexec/xdrive
binary="$application_dir/xdrive"
candidate="$binary.candidate"
configuration=/etc/xdrive/config.toml
proxy_mode_file=/etc/xdrive/proxy-mode
proxy_mode=caddy
if [[ -f $proxy_mode_file && ! -L $proxy_mode_file ]]; then proxy_mode=$(cat -- "$proxy_mode_file"); fi
[[ $proxy_mode == caddy || $proxy_mode == nginx ]] || { printf 'Unknown installed proxy mode.\n' >&2; exit 1; }
if [[ $proxy_mode == caddy ]]; then
  command -v caddy >/dev/null || { printf 'Missing required tool: caddy\n' >&2; exit 1; }
  site=/etc/caddy/Caddyfile.d/xdrive.caddy
  proxy_service=caddy
else
  command -v nginx >/dev/null || { printf 'Missing required tool: nginx\n' >&2; exit 1; }
  site=/etc/nginx/conf.d/xdrive-upstream.inc
  nginx_site=/etc/nginx/conf.d/xdrive.conf
  proxy_service=nginx
fi
installed_updater=/usr/local/libexec/xdrive/upgrade.sh
installed_uninstaller=/usr/local/libexec/xdrive/uninstall.sh
[[ -x $binary && -x $installed_updater && -f $configuration && -f $site && -f /etc/systemd/system/xdrive.service ]] || {
  printf 'No matching script-managed XDrive installation was found.\n' >&2
  exit 1
}
# Reject redirection before opening locks, entering maintenance or writing
# candidates/backups. The installed command symlink is not used by this helper.
for managed_path in "$application_dir" "${application_dir%/*}" "$binary" "$configuration" "$site" "$installed_updater" "$installed_uninstaller" "$proxy_mode_file" /etc/systemd/system/xdrive.service /var/backups/xdrive /run/xdrive-upgrade.lock; do
  [[ ! -L $managed_path && $(realpath -m -- "$managed_path") == "$managed_path" ]] || {
    printf 'Managed upgrade paths must be canonical and must not be symlinked. No upgrade changes were made.\n' >&2
    exit 1
  }
done
if [[ $proxy_mode == caddy ]]; then
  for managed_path in /etc/caddy/Caddyfile "$site"; do
    [[ ! -L $managed_path && $(realpath -m -- "$managed_path") == "$managed_path" ]] || {
      printf 'Managed Caddy paths must be canonical and must not be symlinked. No upgrade changes were made.\n' >&2; exit 1;
    }
  done
else
  for managed_path in /etc/nginx/conf.d "$nginx_site" "$site"; do
    [[ ! -L $managed_path && $(realpath -m -- "$managed_path") == "$managed_path" ]] || {
      printf 'Managed Nginx paths must be canonical and must not be symlinked. No upgrade changes were made.\n' >&2; exit 1;
    }
  done
  [[ -f $nginx_site && $(stat -c '%u' -- "$nginx_site") == 0 && -f $site && $(stat -c '%u' -- "$site") == 0 ]] || { printf 'The managed Nginx site or upstream include is missing or unsafe.\n' >&2; exit 1; }
  systemctl is-active --quiet nginx && nginx -t || { printf 'Nginx must be active and valid before an upgrade.\n' >&2; exit 1; }
fi
[[ ! -e $candidate && ! -L $candidate ]] || { printf 'A previous upgrade candidate still exists; inspect it before retrying.\n' >&2; exit 1; }
[[ ! -e $installed_updater.candidate && ! -L $installed_updater.candidate ]] || { printf 'A previous updater candidate still exists; inspect it before retrying.\n' >&2; exit 1; }
[[ ! -e $installed_uninstaller.candidate && ! -L $installed_uninstaller.candidate ]] || { printf 'A previous uninstaller candidate still exists.\n' >&2; exit 1; }
systemctl is-active --quiet xdrive || { printf 'XDrive must be healthy before an upgrade.\n' >&2; exit 1; }
systemctl is-active --quiet "$proxy_service" || { printf '%s must be active before an upgrade.\n' "$proxy_service" >&2; exit 1; }
curl --fail --silent --max-time 2 --output /dev/null http://127.0.0.1:8787/readyz || {
  printf 'The existing XDrive service did not pass readiness.\n' >&2; exit 1;
}
database_path=$(sed -n 's/^database_path = "\([^"]*\)"$/\1/p' "$configuration")
data_dir=${database_path%/xdrive.db}
[[ $data_dir =~ ^/[A-Za-z0-9/_-]+$ && $database_path == "$data_dir/xdrive.db" &&
   -f $database_path && ! -L $database_path && $(realpath -m -- "$data_dir") == "$data_dir" ]] || {
  printf 'Cannot safely identify the installed database path.\n' >&2; exit 1;
}
configuration_dir=${configuration%/*}
rollback_hold="$configuration_dir/.xdrive-upgrade-rollback-hold"
[[ -d $configuration_dir && ! -L $configuration_dir &&
   $(stat -c '%u:%G:%a' -- "$configuration_dir") == '0:xdrive:750' ]] || {
  printf 'The XDrive config directory must be root:xdrive mode 0750 so the rollback hold cannot be removed by the service user.\n' >&2
  exit 1
}
[[ ! -e $rollback_hold && ! -L $rollback_hold ]] || {
  printf 'An upgrade rollback hold remains from an interrupted update. Keep XDrive in maintenance and inspect the matching database/binary pair before clearing it.\n' >&2
  exit 1
}
if [[ $proxy_mode == caddy ]]; then
  site_address=$(awk 'NF && $1 !~ /^#/ { print $1; exit }' "$site")
  [[ $site_address =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]] || {
    printf 'Cannot identify the installed Caddy domain.\n' >&2; exit 1;
  }
fi
operation_lock=/run/xdrive-upgrade.lock
[[ ! -L $operation_lock && $(realpath -m -- "$operation_lock") == "$operation_lock" &&
   ( ! -e $operation_lock || -f $operation_lock ) ]] || {
  printf 'Unsafe upgrade operation lock. No upgrade changes were made.\n' >&2; exit 1;
}
[[ ! -e $operation_lock || $(stat -c '%u' -- "$operation_lock") == 0 ]] || {
  printf 'Upgrade operation lock must be root-owned. No upgrade changes were made.\n' >&2; exit 1;
}
# flock does not need lock-file contents; preserve existing bytes on open.
umask 077
exec 9>>"$operation_lock"
flock -n 9 || { printf 'Another upgrade is already running.\n' >&2; exit 1; }

temporary_dir=$(mktemp -d)
temporary_dir=$(cd "$temporary_dir" && pwd -P)
site_changed=false
service_stopped=false
rollback_needed=false
rollback_dir=''
rollback_hold_created=false
candidate_dir=''
previous_dir=''
failed_dir=''
old_directory_moved=false
release_accepted=false

restore_site() {
  if [[ $site_changed == true ]]; then
    cp -p "$temporary_dir/site.before-upgrade" "$site" || return 1
    validate_proxy || return 1
    systemctl reload "$proxy_service" || return 1
    site_changed=false
  fi
}

validate_proxy() {
  if [[ $proxy_mode == caddy ]]; then
    caddy validate --config /etc/caddy/Caddyfile
  else
    nginx -t
  fi
}

wait_ready() {
  for attempt in {1..25}; do
    if curl --fail --silent --max-time 2 --output /dev/null http://127.0.0.1:8787/readyz; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restore_binary_and_database() {
  systemctl stop xdrive || return 1
  rm -f "$database_path-wal" "$database_path-shm" || return 1
  rollback_temp=$(mktemp "${database_path}.rollback-XXXXXXXX") || return 1
  cp -- "$rollback_dir/db.sqlite.snapshot" "$rollback_temp" || return 1
  chown xdrive:xdrive "$rollback_temp" || return 1
  chmod 0600 "$rollback_temp" || return 1
  mv -f "$rollback_temp" "$database_path" || return 1
  if [[ $old_directory_moved == true ]]; then
    # Restore the complete application tree, including resources and helpers.
    if [[ -d $application_dir ]]; then
      failed_dir=$(mktemp -d "${application_dir%/*}/.xdrive-failed-XXXXXXXX") || return 1
      rmdir "$failed_dir" || return 1
      mv "$application_dir" "$failed_dir" || return 1
    fi
    mv "$previous_dir" "$application_dir" || return 1
    old_directory_moved=false
    "$temporary_dir/package-reader" release-package sync-directory --root "${application_dir%/*}" || return 1
  fi
  systemctl start xdrive || return 1
  service_stopped=false
  wait_ready
}

clear_rollback_hold() {
  [[ $rollback_hold_created == true && -f $rollback_hold && ! -L $rollback_hold ]] || return 1
  rm -- "$rollback_hold" || return 1
  rollback_hold_created=false
}

on_exit() {
  result=$?
  trap - EXIT
  set +e
  rollback_recovered=false
  if [[ $result -ne 0 && $rollback_needed == true ]]; then
    printf 'Upgrade failed before public traffic was enabled; restoring database and binary.\n' >&2
    if restore_binary_and_database; then
      rollback_recovered=true
    else
      printf 'Rollback service needs manual attention. The public proxy remains in maintenance mode.\n' >&2
      site_changed=false
    fi
  elif [[ $result -ne 0 && $service_stopped == true ]]; then
    if systemctl start xdrive && wait_ready; then
      service_stopped=false
      rollback_recovered=true
    else
      printf 'Existing service could not restart. The public proxy remains in maintenance mode.\n' >&2
      site_changed=false
    fi
  fi
  if [[ $rollback_hold_created == true && $rollback_recovered == true ]]; then
    if ! clear_rollback_hold; then
      printf 'Could not clear the upgrade rollback hold. XDrive remains in maintenance; inspect the matched database/binary pair before manual recovery.\n' >&2
      site_changed=false
    fi
  fi
  if [[ $site_changed == true ]]; then
    if ! restore_site; then
      if [[ $proxy_mode == caddy ]]; then
        printf 'Could not restore the Caddy site; inspect %s.\n' "$site" >&2
      else
        printf 'Could not restore the Nginx upstream include; inspect %s.\n' "$site" >&2
      fi
    fi
  fi
  if [[ -n ${rollback_temp:-} ]]; then rm -f "$rollback_temp"; fi
  rm -f "$candidate"
  rm -f "$installed_updater.candidate"
  rm -f "$installed_uninstaller.candidate"
  if [[ -n $candidate_dir && -d $candidate_dir ]]; then rm -rf "$candidate_dir"; fi
  # Keep the previous directory if recovery failed; the rollback hold stays too.
  if [[ -n $previous_dir && -d $previous_dir && ( $release_accepted == true || $rollback_recovered == true ) ]]; then rm -rf "$previous_dir"; fi
  if [[ -n $failed_dir && -d $failed_dir && $rollback_recovered == true ]]; then rm -rf "$failed_dir"; fi
  rm -rf "$temporary_dir"
  exit "$result"
}
trap on_exit EXIT

archive="$temporary_dir/release.tar.gz"
if [[ -n $bundle ]]; then
  cp -- "$bundle" "$archive"
else
  curl --fail --location --proto '=https' --tlsv1.2 --max-filesize 134217728 --output "$archive" "$release_url"
fi
actual_digest=$(sha256sum "$archive" | awk '{ print $1 }')
[[ $actual_digest == "$expected_digest" ]] || { printf 'Release SHA-256 mismatch.\n' >&2; exit 1; }
# The archive checksum is already trusted. Before extracting the bootstrap
# executable, reject links/special files, duplicate names and unsafe paths.
if ! LC_ALL=C tar -tvzf "$archive" | LC_ALL=C awk '
  BEGIN { valid = 1 }
  substr($0, 1, 1) != "-" { valid = 0 }
  END { exit (!valid || NR < 5 || NR > 4097) }
'; then
  printf 'Release archive has invalid file types or exceeds its bounds.\n' >&2
  exit 1
fi
if ! LC_ALL=C tar -tzf "$archive" | LC_ALL=C awk '
  {
    if ($0 !~ /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/ || length($0) > 240 || seen[$0]++) exit 1
    count = split($0, parts, "/")
    for (i=1; i<=count; i++) if (parts[i] == "." || parts[i] == "..") exit 1
  }
  END { if (!seen["xdrive"] || !seen["install.sh"] || !seen["upgrade.sh"] || !seen["uninstall.sh"] || !seen["RELEASE.txt"]) exit 1 }
'; then
  printf 'Release archive has unsafe, duplicate or missing paths.\n' >&2
  exit 1
fi
# Extract only the authenticated bootstrap executable to a literal output file.
# It validates the complete manifest before writing any package resource.
tar -xOzf "$archive" xdrive > "$temporary_dir/package-reader"
chmod 0755 "$temporary_dir/package-reader"
mkdir "$temporary_dir/package"
"$temporary_dir/package-reader" release-package prepare --archive "$archive" \
  --root "$temporary_dir/package" --architecture "$architecture"
package_dir="$temporary_dir/package"
grep -Fxq 'os=linux' "$package_dir/RELEASE.txt" || { printf 'Release is not for Linux.\n' >&2; exit 1; }
grep -Fxq "architecture=$architecture" "$package_dir/RELEASE.txt" || { printf 'Release architecture mismatch.\n' >&2; exit 1; }
release_version=$(sed -n 's/^version=//p' "$package_dir/RELEASE.txt")
[[ $release_version =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || { printf 'Release version is invalid.\n' >&2; exit 1; }
[[ -z $expected_version || $release_version == "$expected_version" ]] || {
  printf 'Release metadata does not match the approved update version.\n' >&2; exit 1;
}
binary_version=$("$package_dir/xdrive" version)
[[ $binary_version == "xdrive $release_version ("* ]] || { printf 'Release metadata and binary version disagree.\n' >&2; exit 1; }
old_version=$("$binary" version)
old_release=${old_version#xdrive }
old_release=${old_release%% *}
[[ $old_release =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || {
  printf 'Installed binary has no release version; use a supervised migration.\n' >&2; exit 1;
}
dpkg --compare-versions "${release_version#v}" gt "${old_release#v}" || {
  printf 'The selected release must be newer than the installed version.\n' >&2; exit 1;
}

"$temporary_dir/package-reader" release-package check-installed --root "$application_dir"
[[ $(stat -c '%u' -- "$application_dir") == 0 && $(stat -c '%u' -- "${application_dir%/*}") == 0 ]] || {
  printf 'The application directory and its parent must be root-owned.\n' >&2; exit 1;
}
# Stage on the same filesystem as the installed tree for directory publication.
candidate_dir=$(mktemp -d "${application_dir%/*}/.xdrive-candidate-XXXXXXXX")
cp -pR "$package_dir/." "$candidate_dir/"
chmod 0755 "$candidate_dir"
chown -R root:root "$candidate_dir"
"$temporary_dir/package-reader" release-package sync-tree --root "$candidate_dir"
previous_dir=$(mktemp -d "${application_dir%/*}/.xdrive-previous-XXXXXXXX")
rmdir "$previous_dir"
install -d -m 0750 -o root -g xdrive /var/backups/xdrive
rollback_dir=$(mktemp -d /var/backups/xdrive/upgrade-XXXXXXXX)
chmod 0700 "$rollback_dir"
cp -pR "$application_dir" "$rollback_dir/application.old"
"$temporary_dir/package-reader" release-package sync-tree --root "$rollback_dir/application.old"
cp -p "$binary" "$rollback_dir/xdrive.old"
cp -p "$installed_updater" "$rollback_dir/upgrade.sh.old"
if [[ -f $installed_uninstaller && ! -L $installed_uninstaller ]]; then
  cp -p "$installed_uninstaller" "$rollback_dir/uninstall.sh.old"
fi
cp -p "$site" "$temporary_dir/site.before-upgrade"
if [[ $proxy_mode == caddy ]]; then
  cat > "$site" <<EOF
$site_address {
  respond "XDrive is being upgraded" 503
}
EOF
else
  cat > "$site" <<'EOF'
default_type text/plain;
return 503 "XDrive is being upgraded";
EOF
fi
site_changed=true
validate_proxy
systemctl reload "$proxy_service"

systemctl stop xdrive
service_stopped=true
install -m 0640 -o root -g xdrive /dev/null "$rollback_hold"
rollback_hold_created=true
"$candidate_dir/xdrive" snapshot-db --config "$configuration" "$rollback_dir/db.sqlite.snapshot"
rollback_needed=true
runuser -u xdrive -- "$candidate_dir/xdrive" migrate --config "$configuration"
runuser -u xdrive -- "$candidate_dir/xdrive" doctor --config "$configuration"
# The service is stopped and public writes remain blocked. Either the complete
# new tree becomes active, or the old tree and database are restored together.
mv "$application_dir" "$previous_dir"
old_directory_moved=true
mv "$candidate_dir" "$application_dir"
candidate_dir=''
"$temporary_dir/package-reader" release-package sync-directory --root "${application_dir%/*}"
systemctl start xdrive
service_stopped=false
if ! wait_ready; then
  printf 'New service did not pass readiness.\n' >&2
  exit 1
fi
# Public writes are still blocked by the managed proxy. Once readiness and updater
# installation succeed, the candidate becomes accepted; a later proxy error
# must not roll back a service that may soon perform normal background cleanup.
rollback_needed=false
release_accepted=true
if ! clear_rollback_hold; then
  printf 'Could not clear the upgrade rollback hold. XDrive remains in maintenance for manual recovery.\n' >&2
  site_changed=false
  exit 1
fi
restore_site
printf 'Upgrade to %s completed. Pre-migration binary and database snapshot: %s\n' "$release_version" "$rollback_dir"
