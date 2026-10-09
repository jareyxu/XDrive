#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: uninstall.sh [--dry-run] [--delete-data --confirm-data-dir ABSOLUTE_PATH]

Default: remove only the script-managed XDrive service, binary, configuration
and proxy site. Retain encrypted data, backups, Caddy/Nginx, certificates and
the xdrive OS account.
Deleting data is irreversible and requires both explicit options. Backups are
never deleted by this command. Run on the installed Linux host as root.
EOF
  exit 2
}
fail() { printf '%s\n' "$1" >&2; exit 1; }
dry_run=false
delete_data=false
confirmed_dir=''
while (($#)); do
  case "$1" in
    --dry-run) dry_run=true; shift ;;
    --delete-data) delete_data=true; shift ;;
    --confirm-data-dir) (($# >= 2)) || usage; confirmed_dir=$2; shift 2 ;;
    *) usage ;;
  esac
done
[[ $delete_data == true && -n $confirmed_dir || $delete_data == false && -z $confirmed_dir ]] || usage
[[ $(id -u) -eq 0 ]] || fail 'Run the uninstaller as root.'
[[ $(uname -s) == Linux ]] || fail 'Uninstall is only supported on the installed Linux host.'
for command_name in systemctl realpath flock findmnt stat getent; do
  command -v "$command_name" >/dev/null || fail "Missing required tool: $command_name"
done
configuration=/etc/xdrive/config.toml
unit=/etc/systemd/system/xdrive.service
proxy_mode_file=/etc/xdrive/proxy-mode
proxy_mode=caddy
if [[ -f $proxy_mode_file && ! -L $proxy_mode_file ]]; then proxy_mode=$(cat -- "$proxy_mode_file"); fi
[[ $proxy_mode == caddy || $proxy_mode == nginx ]] || fail 'Unknown installed proxy mode.'
tls_mode_file=/etc/xdrive/tls-mode
renew_hook=/etc/letsencrypt/renewal-hooks/deploy/xdrive-nginx-reload
if [[ $proxy_mode == caddy ]]; then
  command -v caddy >/dev/null || fail 'Caddy is required to uninstall this XDrive deployment.'
  site=/etc/caddy/Caddyfile.d/xdrive.caddy
  proxy_site_dir=/etc/caddy/Caddyfile.d
  proxy_main_config=/etc/caddy/Caddyfile
else
  command -v nginx >/dev/null || fail 'Nginx is required to uninstall this XDrive deployment.'
  site=/etc/nginx/conf.d/xdrive-upstream.inc
  nginx_site=/etc/nginx/conf.d/xdrive.conf
  proxy_site_dir=/etc/nginx/conf.d
  renew_hook=/etc/letsencrypt/renewal-hooks/deploy/xdrive-nginx-reload
fi
binary=/usr/local/libexec/xdrive/xdrive
launcher=/usr/local/bin/xdrive
for path in "$configuration" "$unit" "$binary"; do
  [[ -f $path && ! -L $path && $(realpath -m -- "$path") == "$path" && $(stat -c '%u' "$path") == 0 ]] || fail "Missing or unsafe installation file: $path"
done
if [[ $proxy_mode == caddy ]]; then
  [[ -f $site && ! -L $site && $(realpath -m -- "$site") == "$site" && $(stat -c '%u' "$site") == 0 ]] || fail "Missing or unsafe installation file: $site"
fi
for path in /etc/xdrive /etc/systemd/system "$proxy_site_dir" "$site" /usr/local/libexec/xdrive /usr/local/bin; do
  [[ $(realpath -m -- "$path") == "$path" ]] || fail "Symlinked installation path: $path"
done
if [[ $proxy_mode == nginx ]]; then
  for path in "$nginx_site" "$site"; do
    [[ ! -L $path && $(realpath -m -- "$path") == "$path" ]] || fail 'Managed Nginx paths must be canonical and must not be symlinked.'
  done
  nginx_site_exists=false
  nginx_upstream_exists=false
  if [[ -e $nginx_site ]]; then
    [[ -f $nginx_site && $(stat -c '%u' -- "$nginx_site") == 0 ]] || fail 'The managed Nginx site is unsafe.'
    nginx_site_exists=true
  fi
  if [[ -e $site ]]; then
    [[ -f $site && $(stat -c '%u' -- "$site") == 0 ]] || fail 'The managed Nginx upstream include is unsafe.'
    nginx_upstream_exists=true
  fi
  [[ $nginx_site_exists == "$nginx_upstream_exists" ]] || fail 'Only one managed Nginx site file exists; inspect it before uninstalling.'
  nginx_proxy_files_present=$nginx_site_exists
  [[ -f $tls_mode_file && ! -L $tls_mode_file && $(stat -c '%u' -- "$tls_mode_file") == 0 ]] || fail 'The Nginx TLS mode marker is missing or unsafe.'
  tls_mode=$(cat -- "$tls_mode_file")
  [[ $tls_mode == certbot || $tls_mode == external ]] || fail 'Unknown installed TLS mode.'
  if [[ $tls_mode == certbot && -e $renew_hook ]]; then
    [[ ! -L $renew_hook && -f $renew_hook && $(stat -c '%u' -- "$renew_hook") == 0 ]] || fail 'The XDrive Certbot deploy hook is unsafe.'
    cmp -s "$renew_hook" <(printf '#!/bin/sh\nset -eu\nnginx -t\nsystemctl reload nginx\n') || fail 'The XDrive Certbot deploy hook has been modified; inspect it before uninstalling.'
  fi
  if [[ $nginx_proxy_files_present == true ]]; then
    systemctl is-active --quiet nginx && nginx -t || fail 'Nginx must be active and valid before uninstalling XDrive.'
  fi
else
  [[ $(realpath -m -- /etc/caddy/Caddyfile) == /etc/caddy/Caddyfile ]] || fail 'Symlinked Caddy configuration path.'
fi
[[ -L $launcher && $(readlink "$launcher") == "$binary" ]] || fail 'The xdrive launcher is not managed by this installation.'
operation_lock=/run/xdrive-upgrade.lock
[[ ! -L $operation_lock && $(realpath -m -- "$operation_lock") == "$operation_lock" &&
   ( ! -e $operation_lock || -f $operation_lock ) ]] || fail 'Unsafe uninstall operation lock.'
[[ ! -e $operation_lock || $(stat -c '%u' -- "$operation_lock") == 0 ]] || fail 'Uninstall operation lock must be root-owned.'
umask 077
exec 9>>"$operation_lock"
flock -n 9 || fail 'Another upgrade or uninstall is running.'

# Recognize the installer layout without executing configuration as shell code.
database=$(sed -n 's/^database_path = "\([^"]*\)"$/\1/p' "$configuration")
storage=$(sed -n 's/^storage_path = "\([^"]*\)"$/\1/p' "$configuration")
secret=$(sed -n 's/^secret_path = "\([^"]*\)"$/\1/p' "$configuration")
data_dir=${database%/xdrive.db}
[[ $data_dir =~ ^/[A-Za-z0-9/_-]+$ && $database == "$data_dir/xdrive.db" && $storage == "$data_dir/objects" && $secret == "$data_dir/server.secret" ]] || fail 'Cannot identify a single installer-managed data directory.'
case "$data_dir" in
  /var/lib/*|/srv/*|/mnt/*|/data/*|/opt/*) ;;
  *) fail 'Unsafe data directory.' ;;
esac
[[ -d $data_dir && $(realpath -m -- "$data_dir") == "$data_dir" ]] || fail 'Data directory is absent or has symlinked parents.'
[[ $(getent passwd xdrive | cut -d: -f6) == "$data_dir" ]] || fail 'The xdrive account belongs to a different data directory.'
grep -Fxq 'User=xdrive' "$unit" && grep -Fxq "WorkingDirectory=$data_dir" "$unit" &&
  grep -Fxq 'ExecStart=/usr/local/libexec/xdrive/xdrive serve --config /etc/xdrive/config.toml' "$unit" || fail 'The service unit does not match the installer layout.'
[[ $(systemctl show xdrive --property=FragmentPath --value) == "$unit" ]] || fail 'The active service uses a different unit.'
check_mounts() {
  # Reject nested mount/bind points; --one-file-system alone cannot detect a
  # bind mount backed by the same filesystem. Never follow internal symlinks.
  mounts=$(findmnt -rn -o TARGET) || fail 'Cannot inspect mount boundaries.'
  while IFS= read -r mount; do
    [[ $mount != "$data_dir" && $mount != "$data_dir/"* ]] || fail 'Data directory contains a mount point; detach it before data deletion.'
  done <<< "$mounts"
}
if [[ $delete_data == true ]]; then
  [[ $confirmed_dir == "$data_dir" ]] || fail 'Confirmation must exactly match the installed data directory.'
  check_mounts
fi
printf 'XDrive uninstall: data directory %s will be %s.\n' "$data_dir" "$([[ $delete_data == true ]] && printf deleted || printf retained)"
printf 'Backups, proxy packages, certificates and the xdrive OS account will be retained.\n'
[[ $dry_run == false ]] || exit 0

temporary_dir=$(mktemp -d)
site_removed=false
nginx_site_removed=false
renew_hook_removed=false
finished=false
on_exit() {
  result=$?
  trap - EXIT
  if [[ $result -ne 0 && $site_removed == true && $finished == false ]]; then
    cp -p "$temporary_dir/xdrive.proxy" "$site" || true
    if [[ $proxy_mode == caddy ]]; then
      caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy || true
    else
      nginx -t && systemctl reload nginx || true
    fi
    printf 'Uninstall failed. Inspect the service and retained configuration before retrying.\n' >&2
  fi
  if [[ $result -ne 0 && $nginx_site_removed == true && $finished == false ]]; then
    cp -p "$temporary_dir/xdrive.nginx" "$nginx_site" || true
    nginx -t && systemctl reload nginx || true
    printf 'Uninstall failed. The XDrive Nginx site was restored where possible.\n' >&2
  fi
  if [[ $result -ne 0 && $renew_hook_removed == true && $finished == false ]]; then
    install -m 0755 -o root -g root "$temporary_dir/xdrive-nginx-reload" "$renew_hook" || true
  fi
  rm -rf "$temporary_dir"
  exit "$result"
}
trap on_exit EXIT
if [[ $proxy_mode == caddy ]]; then
  cp -p "$site" "$temporary_dir/xdrive.proxy"
  rm -- "$site"
  site_removed=true
  caddy validate --config /etc/caddy/Caddyfile
  if systemctl is-active --quiet caddy; then systemctl reload caddy; fi
else
  if [[ $nginx_proxy_files_present == true ]]; then
    cp -p "$site" "$temporary_dir/xdrive.proxy"
    cp -p "$nginx_site" "$temporary_dir/xdrive.nginx"
    rm -- "$site"
    site_removed=true
    rm -- "$nginx_site"
    nginx_site_removed=true
    nginx -t
    systemctl reload nginx
  fi
  if [[ $tls_mode == certbot && -e $renew_hook ]]; then
    cp -p "$renew_hook" "$temporary_dir/xdrive-nginx-reload"
    rm -- "$renew_hook"
    renew_hook_removed=true
  fi
fi
systemctl disable --now xdrive
if systemctl is-active --quiet xdrive; then fail 'XDrive is still active; no application files or data were removed.'; fi
# Revalidate the deletion target after service stop. It is never inferred from
# the caller's confirmation, and rm does not traverse symlinked contents.
if [[ $delete_data == true ]]; then
  [[ $(realpath -m -- "$data_dir") == "$data_dir" && -d $data_dir ]] || fail 'Data directory changed during uninstall.'
  check_mounts
  rm -rf --one-file-system -- "$data_dir"
fi
rm -- "$unit" "$configuration" "$launcher" "$binary"
if [[ -f $proxy_mode_file ]]; then rm -- "$proxy_mode_file"; fi
if [[ $proxy_mode == nginx ]]; then rm -- "$tls_mode_file"; fi
for helper in upgrade.sh uninstall.sh; do
  path="/usr/local/libexec/xdrive/$helper"
  if [[ -f $path && ! -L $path && $(stat -c '%u' "$path") == 0 ]]; then rm -- "$path"; fi
done
# Remove only empty application directories; never recursively remove unknown
# configuration or helper files that an administrator may have added.
rmdir /etc/xdrive /usr/local/libexec/xdrive 2>/dev/null || true
systemctl daemon-reload
systemctl reset-failed xdrive 2>/dev/null || true
finished=true
printf 'XDrive removed. Data %s; backups retained.\n' "$([[ $delete_data == true ]] && printf deleted || printf retained)"
