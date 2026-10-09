#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: install.sh (--bundle FILE | --release-url HTTPS_URL) --sha256 HEX \
  [--domain DOMAIN] [--proxy auto|caddy|nginx] [--tls-email EMAIL | --tls-cert FILE --tls-key FILE] \
  --username ADMIN --data-dir ABSOLUTE_PATH

Run as root on Ubuntu 24.04 or Debian 12 (amd64/arm64). Supply the expected
archive SHA-256 from a trusted release announcement; a digest downloaded beside
an untrusted archive does not authenticate that archive. When --domain is omitted
on an interactive terminal, the installer prompts for it. Nginx mode adds an
isolated site and obtains a Let's Encrypt certificate unless existing TLS files
are supplied.
EOF
  exit 2
}

bundle=''
release_url=''
expected_digest=''
domain=''
proxy_mode='auto'
tls_email=''
tls_cert=''
tls_key=''
admin_username=''
data_dir=''
while (($#)); do
  case "$1" in
    --bundle|--release-url|--sha256|--domain|--proxy|--tls-email|--tls-cert|--tls-key|--username|--data-dir)
      (($# >= 2)) || usage
      case "$1" in
        --bundle) bundle=$2 ;;
        --release-url) release_url=$2 ;;
        --sha256) expected_digest=$2 ;;
        --domain) domain=$2 ;;
        --proxy) proxy_mode=$2 ;;
        --tls-email) tls_email=$2 ;;
        --tls-cert) tls_cert=$2 ;;
        --tls-key) tls_key=$2 ;;
        --username) admin_username=$2 ;;
        --data-dir) data_dir=$2 ;;
      esac
      shift 2 ;;
    *) usage ;;
  esac
done
[[ $(id -u) -eq 0 ]] || { printf 'Run this installer as root.\n' >&2; exit 1; }
[[ -n $bundle && -z $release_url || -z $bundle && -n $release_url ]] || usage
[[ $expected_digest =~ ^[0-9a-fA-F]{64}$ ]] || usage
if [[ -z $domain ]]; then
  [[ -t 0 ]] || usage
  read -r -p 'XDrive domain (for example drive.example.com): ' domain
fi
[[ $domain =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ && $domain != *..* && ${#domain} -le 253 ]] || usage
IFS=. read -r -a domain_labels <<< "$domain"
for label in "${domain_labels[@]}"; do
  [[ ${#label} -le 63 && $label != -* && $label != *- ]] || usage
done
[[ $proxy_mode == auto || $proxy_mode == caddy || $proxy_mode == nginx ]] || usage
[[ -z $tls_email || $tls_email =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || usage
[[ -z $tls_cert && -z $tls_key || -n $tls_cert && -n $tls_key ]] || usage
[[ $admin_username =~ ^[A-Za-z0-9._-]{1,128}$ ]] || usage
[[ $data_dir =~ ^/[A-Za-z0-9/_-]+$ && $data_dir != / && $data_dir != */ ]] || usage
[[ -z $release_url || $release_url == https://* ]] || usage
case "$data_dir" in
  /var/lib/*|/srv/*|/mnt/*|/data/*|/opt/*) ;;
  *) printf 'Choose a data directory under /var/lib, /srv, /mnt, /data, or /opt.\n' >&2; exit 1 ;;
esac
[[ $(realpath -m -- "$data_dir") == "$data_dir" ]] || {
  printf 'Data directory must be canonical and must not contain symlinked parents.\n' >&2
  exit 1
}

# Check even absent leaf paths: -e alone overlooks dangling links. All managed
# paths must stay under their literal, root-administered directories.
for managed_path in /etc/xdrive /etc/systemd/system /usr/local/libexec/xdrive /usr/local/bin /etc/caddy/Caddyfile.d /etc/caddy/Caddyfile; do
  [[ ! -L $managed_path && $(realpath -m -- "$managed_path") == "$managed_path" ]] || {
    printf 'Managed installation paths must be canonical and must not be symlinked. No installation changes were made.\n' >&2
    exit 1
  }
done

os_id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"' | head -n 1)
os_version=$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"' | head -n 1)
if [[ ! ($os_id == ubuntu && $os_version == 24.04 || $os_id == debian && $os_version == 12) ]]; then
  printf 'Supported systems: Ubuntu 24.04 and Debian 12 only. Found %s %s.\n' "$os_id" "$os_version" >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) architecture=amd64 ;;
  aarch64) architecture=arm64 ;;
  *) printf 'Unsupported CPU architecture.\n' >&2; exit 1 ;;
esac
[[ $(dpkg --print-architecture) == "$architecture" ]] || { printf 'CPU and package architecture disagree.\n' >&2; exit 1; }
command -v systemctl >/dev/null || { printf 'systemd is required.\n' >&2; exit 1; }
command -v sha256sum >/dev/null || { printf 'sha256sum is required.\n' >&2; exit 1; }
command -v tar >/dev/null || { printf 'tar is required.\n' >&2; exit 1; }
command -v curl >/dev/null || { printf 'curl is required.\n' >&2; exit 1; }
command -v ss >/dev/null || { printf 'ss is required to check ports 80 and 443.\n' >&2; exit 1; }
if [[ $proxy_mode == auto ]]; then
  if systemctl is-active --quiet nginx; then proxy_mode=nginx
  elif systemctl is-active --quiet caddy; then proxy_mode=caddy
  else proxy_mode=caddy
  fi
fi
if [[ $proxy_mode == nginx && -z $tls_email && -z $tls_cert && -t 0 ]]; then
  read -r -p "Email for Let's Encrypt certificate: " tls_email
fi
if [[ $proxy_mode == nginx && -z $tls_email && -z $tls_cert ]]; then
  printf 'Nginx mode needs --tls-email for automatic HTTPS or both --tls-cert and --tls-key.\n' >&2
  exit 2
fi
if [[ $proxy_mode != nginx && ( -n $tls_email || -n $tls_cert || -n $tls_key ) ]]; then
  printf 'TLS email/certificate options are valid only with --proxy nginx.\n' >&2
  exit 2
fi
listeners=$(ss -H -ltn) || { printf 'Could not inspect listening TCP ports. No installation changes were made.\n' >&2; exit 1; }
if printf '%s\n' "$listeners" | awk '{ print $4 }' | grep -Eq ':8787$'; then
  printf 'The XDrive backend port 8787 is already in use. No installation changes were made.\n' >&2
  exit 1
fi
[[ ! -e /etc/xdrive/config.toml && ! -L /etc/xdrive/config.toml && ! -e /etc/systemd/system/xdrive.service && ! -L /etc/systemd/system/xdrive.service && ! -e /usr/local/libexec/xdrive/xdrive && ! -L /usr/local/libexec/xdrive/xdrive && ! -e /usr/local/bin/xdrive && ! -L /usr/local/bin/xdrive ]] || {
  printf 'An XDrive installation already exists. Use the upgrade procedure; this installer will not overwrite it.\n' >&2
  exit 1
}
if [[ $proxy_mode == caddy ]]; then
[[ ! -e /etc/caddy/Caddyfile.d/xdrive.caddy && ! -L /etc/caddy/Caddyfile.d/xdrive.caddy ]] || {
  printf 'An XDrive Caddy site already exists; inspect it before installing.\n' >&2
  exit 1
}
fi
if [[ -e $data_dir ]]; then
  [[ -d $data_dir && -z $(find "$data_dir" -mindepth 1 -maxdepth 1 -print -quit) ]] || {
    printf 'The data directory must be absent or empty.\n' >&2
    exit 1
  }
fi
if id xdrive >/dev/null 2>&1; then
  existing_home=$(getent passwd xdrive | cut -d: -f6)
  [[ $existing_home == "$data_dir" ]] || { printf 'Existing xdrive OS user belongs to another data directory.\n' >&2; exit 1; }
fi
if [[ $proxy_mode == nginx ]]; then
  nginx_site=/etc/nginx/conf.d/xdrive.conf
  nginx_upstream=/etc/nginx/conf.d/xdrive-upstream.inc
  [[ ! -L /etc/nginx/conf.d && $(realpath -m -- /etc/nginx/conf.d) == /etc/nginx/conf.d ]] || {
    printf 'Nginx conf.d must be a canonical directory. No installation changes were made.\n' >&2; exit 1;
  }
  [[ ! -L $nginx_site && $(realpath -m -- "$nginx_site") == "$nginx_site" ]] || {
    printf 'The managed Nginx site path must be canonical and must not be symlinked. No installation changes were made.\n' >&2; exit 1;
  }
  [[ ! -e $nginx_site ]] || { printf 'An XDrive Nginx site already exists; inspect it before installing.\n' >&2; exit 1; }
  [[ ! -L $nginx_upstream && $(realpath -m -- "$nginx_upstream") == "$nginx_upstream" && ! -e $nginx_upstream ]] || {
    printf 'The XDrive Nginx upstream include already exists or is unsafe. No installation changes were made.\n' >&2; exit 1;
  }
  [[ ! -e /etc/xdrive/proxy-mode && ! -L /etc/xdrive/proxy-mode ]] || {
    printf 'An XDrive proxy mode marker already exists. No installation changes were made.\n' >&2; exit 1;
  }
  [[ ! -e /etc/xdrive/tls-mode && ! -L /etc/xdrive/tls-mode ]] || {
    printf 'An XDrive TLS mode marker already exists. No installation changes were made.\n' >&2; exit 1;
  }
  command -v nginx >/dev/null || { printf 'Nginx mode requires nginx.\n' >&2; exit 1; }
  systemctl is-active --quiet nginx || { printf 'Nginx must be active for --proxy nginx.\n' >&2; exit 1; }
  nginx -t || { printf 'The existing Nginx configuration is invalid. No installation changes were made.\n' >&2; exit 1; }
  nginx_dump=$(nginx -T 2>&1) || { printf 'Could not inspect the active Nginx configuration.\n' >&2; exit 1; }
  printf '%s\n' "$nginx_dump" | grep -Eq 'include[[:space:]]+/etc/nginx/conf\.d/\*\.conf;' || {
    printf 'Nginx does not include /etc/nginx/conf.d/*.conf; refusing to edit the existing main configuration.\n' >&2; exit 1;
  }
  domain_conflict=$(printf '%s\n' "$nginx_dump" | awk -v domain="$domain" '$1 == "server_name" { for (i=2; i<=NF; i++) { gsub(/[;{}]/,"",$i); if ($i == domain) found=1 } } END { print found+0 }')
  if [[ $domain_conflict == 1 ]]; then
    printf 'The requested domain already appears in an Nginx server_name directive. No installation changes were made.\n' >&2; exit 1
  fi
  if [[ -n $tls_cert ]]; then
    [[ $tls_cert =~ ^/[A-Za-z0-9/_.-]+$ && $tls_key =~ ^/[A-Za-z0-9/_.-]+$ && -r $tls_cert && -r $tls_key ]] || {
      printf 'TLS certificate and key must be readable absolute paths. No installation changes were made.\n' >&2; exit 1;
    }
    command -v openssl >/dev/null || { printf 'openssl is required to validate supplied TLS files.\n' >&2; exit 1; }
    openssl x509 -in "$tls_cert" -noout -checkhost "$domain" >/dev/null 2>&1 || {
      printf 'The supplied certificate does not cover the requested domain.\n' >&2; exit 1;
    }
    cert_public=$(openssl x509 -in "$tls_cert" -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')
    key_public=$(openssl pkey -in "$tls_key" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}')
    [[ -n $cert_public && $cert_public == "$key_public" ]] || { printf 'The supplied TLS certificate and key do not match.\n' >&2; exit 1; }
  else
    renew_hook=/etc/letsencrypt/renewal-hooks/deploy/xdrive-nginx-reload
    [[ ! -L /etc/letsencrypt/renewal-hooks/deploy && $(realpath -m -- /etc/letsencrypt/renewal-hooks/deploy) == /etc/letsencrypt/renewal-hooks/deploy ]] || {
      printf 'The Certbot deploy-hook directory must be canonical.\n' >&2; exit 1;
    }
    [[ ! -L $renew_hook && ! -e $renew_hook ]] || { printf 'The XDrive Certbot deploy hook already exists.\n' >&2; exit 1; }
  fi
fi
if [[ $proxy_mode == caddy ]] && ! systemctl is-active --quiet caddy; then
  if printf '%s\n' "$listeners" | awk '{ print $4 }' | grep -Eq ':(80|443)$'; then
    printf 'Port 80 or 443 is already in use while Caddy is inactive.\n' >&2
    exit 1
  fi
fi

temporary_dir=$(mktemp -d)
nginx_site_created=false
nginx_upstream_created=false
renew_hook_created=false
nginx_install_complete=false
cleanup_install() {
  result=$?
  trap - EXIT
  if [[ $result -ne 0 && $proxy_mode == nginx && ( $nginx_site_created == true || $nginx_upstream_created == true ) && $nginx_install_complete == false ]]; then
    rm -f -- "$nginx_site"
    if [[ $nginx_upstream_created == true ]]; then rm -f -- "$nginx_upstream"; fi
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx || printf 'Could not reload Nginx after removing the incomplete XDrive site; inspect nginx -t and systemctl status nginx.\n' >&2
    else
      printf 'Could not validate Nginx after removing the incomplete XDrive site; inspect %s.\n' "$nginx_site" >&2
    fi
  fi
  if [[ $result -ne 0 && $renew_hook_created == true && $nginx_install_complete == false ]]; then
    rm -f -- "$renew_hook"
  fi
  rm -rf "$temporary_dir"
  exit "$result"
}
trap cleanup_install EXIT
archive="$temporary_dir/release.tar.gz"
if [[ -n $bundle ]]; then
  cp -- "$bundle" "$archive"
else
  curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "$release_url"
fi
actual_digest=$(sha256sum "$archive" | awk '{ print $1 }')
expected_digest=$(printf '%s' "$expected_digest" | tr '[:upper:]' '[:lower:]')
[[ $actual_digest == "$expected_digest" ]] || { printf 'Release SHA-256 mismatch. No installation changes were made.\n' >&2; exit 1; }
# Inspect types before extracting as root. The name allowlist alone admits
# links and special files; post-extraction checks are too late for confinement.
if ! LC_ALL=C tar -tvzf "$archive" | LC_ALL=C awk '
  BEGIN { valid = 1 }
  substr($0, 1, 1) != "-" { valid = 0 }
  END { exit (!valid || NR != 5) }
'; then
  printf 'Release archive has invalid file types. No installation changes were made.\n' >&2
  exit 1
fi
archive_members=$(tar -tzf "$archive" | LC_ALL=C sort)
[[ $archive_members == $'RELEASE.txt\ninstall.sh\nuninstall.sh\nupgrade.sh\nxdrive' ]] || { printf 'Release archive has unexpected paths.\n' >&2; exit 1; }
tar -C "$temporary_dir" -xzf "$archive"
[[ -f $temporary_dir/xdrive && ! -L $temporary_dir/xdrive && -f $temporary_dir/upgrade.sh && ! -L $temporary_dir/upgrade.sh && -f $temporary_dir/uninstall.sh && ! -L $temporary_dir/uninstall.sh && -f $temporary_dir/RELEASE.txt && ! -L $temporary_dir/RELEASE.txt ]] || {
  printf 'Release archive has invalid file types.\n' >&2; exit 1;
}
grep -Fxq 'os=linux' "$temporary_dir/RELEASE.txt" || { printf 'Release is not for Linux.\n' >&2; exit 1; }
grep -Fxq "architecture=$architecture" "$temporary_dir/RELEASE.txt" || { printf 'Release architecture mismatch.\n' >&2; exit 1; }
release_version=$(sed -n 's/^version=//p' "$temporary_dir/RELEASE.txt")
[[ $release_version =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || { printf 'Release version is invalid.\n' >&2; exit 1; }
binary_version=$("$temporary_dir/xdrive" version)
[[ $binary_version == "xdrive $release_version ("* ]] || { printf 'Release metadata and binary version disagree.\n' >&2; exit 1; }
printf '%s\n' "$binary_version"

if [[ $proxy_mode == caddy ]]; then
if ! command -v caddy >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl --fail --location --proto '=https' --tlsv1.2 --silent \
    https://dl.cloudsmith.io/public/caddy/stable/gpg.key | \
    gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl --fail --location --proto '=https' --tlsv1.2 --silent \
    https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    -o /etc/apt/sources.list.d/caddy-stable.list
  chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
fi
systemctl cat caddy.service >/dev/null || { printf 'Caddy systemd service is required.\n' >&2; exit 1; }
[[ -f /etc/caddy/Caddyfile ]] || { printf 'Caddy must use an /etc/caddy/Caddyfile configuration.\n' >&2; exit 1; }
fi

if ! id xdrive >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$data_dir" --no-create-home --shell /usr/sbin/nologin xdrive
fi
install -d -m 0700 -o xdrive -g xdrive "$data_dir"
install -d -m 0750 -o root -g xdrive /etc/xdrive
install -d -m 0755 -o root -g root /usr/local/libexec/xdrive
install -m 0755 -o root -g root "$temporary_dir/xdrive" /usr/local/libexec/xdrive/xdrive
install -m 0755 -o root -g root "$temporary_dir/upgrade.sh" /usr/local/libexec/xdrive/upgrade.sh
install -m 0755 -o root -g root "$temporary_dir/uninstall.sh" /usr/local/libexec/xdrive/uninstall.sh
ln -s /usr/local/libexec/xdrive/xdrive /usr/local/bin/xdrive
cat > /etc/xdrive/config.toml <<EOF
listen_addr = "127.0.0.1:8787"
database_path = "$data_dir/xdrive.db"
storage_path = "$data_dir/objects"
secret_path = "$data_dir/server.secret"
username = "$admin_username"
quota_bytes = 10737418240
min_free_disk_bytes = 3221225472
text_preview_limit = 20971520
video_blob_fallback_limit = 268435456
zip_memory_fallback_limit = 536870912
backup_warn_after_days = 30
object_put_max_bytes = 16777216
upload_expiry = "24h"
trash_retention = "720h"
session_idle_timeout = "12h"
setup_token_ttl = "24h"
metadata_keep_versions = 5
maintenance_reserve_bytes = 8388608
EOF
chown root:xdrive /etc/xdrive/config.toml
chmod 0640 /etc/xdrive/config.toml
printf '%s\n' "$proxy_mode" > "$temporary_dir/proxy-mode"
install -m 0644 -o root -g root "$temporary_dir/proxy-mode" /etc/xdrive/proxy-mode
if [[ $proxy_mode == nginx ]]; then
  if [[ -n $tls_cert ]]; then tls_mode=external; else tls_mode=certbot; fi
  printf '%s\n' "$tls_mode" > "$temporary_dir/tls-mode"
  install -m 0644 -o root -g root "$temporary_dir/tls-mode" /etc/xdrive/tls-mode
fi
cat > /etc/systemd/system/xdrive.service <<EOF
[Unit]
Description=XDrive encrypted private drive
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=xdrive
Group=xdrive
WorkingDirectory=$data_dir
ExecStart=/usr/local/libexec/xdrive/xdrive serve --config /etc/xdrive/config.toml
Restart=on-failure
RestartSec=3s
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$data_dir
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 /etc/systemd/system/xdrive.service
systemctl daemon-reload
systemctl enable --now xdrive
for attempt in {1..30}; do
  if systemctl is-active --quiet xdrive && curl --fail --silent --max-time 2 --output /dev/null http://127.0.0.1:8787/readyz; then break; fi
  if ((attempt == 30)); then
    printf 'XDrive failed its readiness check; inspect journalctl -u xdrive. Data was retained.\n' >&2
    exit 1
  fi
  sleep 1
done

if [[ $proxy_mode == caddy ]]; then
  install -d -m 0755 /etc/caddy/Caddyfile.d
  snippet=/etc/caddy/Caddyfile.d/xdrive.caddy
  [[ ! -e $snippet && ! -L $snippet ]] || { printf 'Caddy already has an XDrive site snippet.\n' >&2; exit 1; }
  cat > "$snippet" <<EOF
$domain {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8787
}
EOF
  chmod 0644 "$snippet"
  if ! grep -Fxq 'import /etc/caddy/Caddyfile.d/*' /etc/caddy/Caddyfile; then
    cp -p /etc/caddy/Caddyfile "$temporary_dir/Caddyfile.before-xdrive"
    printf '\nimport /etc/caddy/Caddyfile.d/*\n' >> /etc/caddy/Caddyfile
  fi
  restore_caddy_configuration() {
    rm -f "$snippet" || return 1
    if [[ -f $temporary_dir/Caddyfile.before-xdrive ]]; then
      cp -p "$temporary_dir/Caddyfile.before-xdrive" /etc/caddy/Caddyfile || return 1
    fi
  }
  if ! caddy validate --config /etc/caddy/Caddyfile; then
    restore_caddy_configuration || printf 'Could not restore the prior Caddy configuration; manual inspection is required.\n' >&2
    printf 'Caddy rejected the generated site. XDrive data and service remain installed for inspection.\n' >&2
    exit 1
  fi
  if systemctl is-active --quiet caddy; then
    if systemctl reload caddy; then caddy_activated=true; else caddy_activated=false; fi
  else
    if systemctl enable --now caddy; then caddy_activated=true; else caddy_activated=false; fi
  fi
  if [[ $caddy_activated == false ]]; then
    if ! restore_caddy_configuration; then
      printf 'Could not restore the prior Caddy configuration; manual inspection is required.\n' >&2
    elif systemctl is-active --quiet caddy; then
      if ! caddy validate --config /etc/caddy/Caddyfile || ! systemctl reload caddy; then
        printf 'Could not reload the prior Caddy configuration; inspect journalctl -u caddy.\n' >&2
      fi
    fi
    printf 'Caddy could not activate the generated site. XDrive data and service remain installed for inspection.\n' >&2
    exit 1
  fi
else
  if [[ -z $tls_cert ]]; then
    if ! command -v certbot >/dev/null; then
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y certbot
    fi
    install -d -m 0755 -o root -g root /var/lib/letsencrypt/.well-known/acme-challenge
    cat > "$nginx_site" <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $domain;

  location ^~ /.well-known/acme-challenge/ {
    root /var/lib/letsencrypt;
    default_type text/plain;
  }
  location / { return 503; }
}
EOF
    chmod 0644 "$nginx_site"
    nginx_site_created=true
    nginx -t
    systemctl reload nginx
    if ! certbot certonly --webroot --webroot-path /var/lib/letsencrypt \
      --non-interactive --agree-tos --keep-until-expiring \
      --cert-name "$domain" --email "$tls_email" --domain "$domain"; then
      printf 'Could not obtain the HTTPS certificate. Check DNS, public port 80 and Certbot output; the existing Nginx site was preserved.\n' >&2
      exit 1
    fi
    tls_cert="/etc/letsencrypt/live/$domain/fullchain.pem"
    tls_key="/etc/letsencrypt/live/$domain/privkey.pem"
    [[ -r $tls_cert && -r $tls_key ]] || { printf 'Certbot did not create the expected certificate files.\n' >&2; exit 1; }
    renew_hook=/etc/letsencrypt/renewal-hooks/deploy/xdrive-nginx-reload
    install -d -m 0755 -o root -g root "${renew_hook%/*}"
    cat > "$temporary_dir/xdrive-nginx-reload" <<'EOF'
#!/bin/sh
set -eu
nginx -t
systemctl reload nginx
EOF
    install -m 0755 -o root -g root "$temporary_dir/xdrive-nginx-reload" "$renew_hook"
    renew_hook_created=true
  fi
  cat > "$temporary_dir/nginx-xdrive.conf" <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $domain;

  location ^~ /.well-known/acme-challenge/ {
    root /var/lib/letsencrypt;
    default_type text/plain;
  }
  location / { return 308 https://\$host\$request_uri; }
}

server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name $domain;

  ssl_certificate $tls_cert;
  ssl_certificate_key $tls_key;
  location / {
    include /etc/nginx/conf.d/xdrive-upstream.inc;
  }
}
EOF
  cat > "$temporary_dir/nginx-xdrive-upstream.inc" <<'EOF'
client_max_body_size 32m;
proxy_pass http://127.0.0.1:8787;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_request_buffering off;
proxy_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
EOF
  install -m 0644 -o root -g root "$temporary_dir/nginx-xdrive-upstream.inc" "$nginx_upstream"
  nginx_upstream_created=true
  install -m 0644 -o root -g root "$temporary_dir/nginx-xdrive.conf" "$nginx_site"
  nginx_site_created=true
  if ! nginx -t || ! systemctl reload nginx; then
    printf 'Nginx could not activate the XDrive site. Its site file will be removed and the prior Nginx configuration reloaded.\n' >&2
    exit 1
  fi
fi

# The proxy route is now active. If setup-token output parsing fails, leave the
# working installation intact so an administrator can issue a fresh token.
nginx_install_complete=true

setup_output=$(runuser -u xdrive -- /usr/local/libexec/xdrive/xdrive setup-token --config /etc/xdrive/config.toml)
if [[ $setup_output =~ ^Open[[:space:]]/setup#([A-Za-z0-9_-]+)([[:space:]]|$) ]]; then
  setup_token=${BASH_REMATCH[1]}
else
  printf 'Could not extract setup token; run xdrive setup-token as the xdrive user.\n' >&2
  exit 1
fi
printf 'XDrive installed. Once DNS points to this host and HTTPS is ready, open:\nhttps://%s/setup#%s\n' "$domain" "$setup_token"
nginx_install_complete=true
