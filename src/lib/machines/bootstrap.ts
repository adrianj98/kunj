// The script a new machine runs as root at every boot (GCE: the startup-script metadata) to become a
// kunj machine: Docker, Node, kunj, and `kunj serve --allow-pairing` on its internal address as a
// systemd unit. Idempotent, so an image that already has everything only rewrites the unit and
// starts it. Provider-visible and in the instance's metadata: it never carries a secret.
// docs/specs/cloud-machines.md, "Bootstrap".

import { MachineError } from './provider';

export const KUNJ_PACKAGE = /^(kunj@[0-9A-Za-z.+-]{1,40}|github:[A-Za-z0-9_.-]{1,60}\/[A-Za-z0-9_.-]{1,60}#[A-Za-z0-9_.\/-]{1,80})$/;

/** What a machine installs for this kunj: the same version from npm; a dev build takes main. */
export function defaultKunjPackage(version: string): string {
  return version === '1.0.0' || !/^[0-9]+\.[0-9]+\.[0-9]+/.test(version) ? 'github:adrianj98/kunj#main' : `kunj@${version}`;
}

export interface BootstrapOptions {
  /** `kunj@<version>` or `github:<owner>/<repo>#<ref>` */
  kunjPackage: string;
  port: number;
  pairWindowMinutes: number;
}

export function bootstrapScript(opts: BootstrapOptions): string {
  if (!KUNJ_PACKAGE.test(opts.kunjPackage) || opts.kunjPackage.includes('..')) {
    throw new MachineError(`machine.kunjPackage "${opts.kunjPackage}" is not kunj@<version> or github:<owner>/<repo>#<ref>.`, 'bad-machine-config');
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new MachineError(`Bad serve port ${opts.port}.`, 'bad-machine-config');
  const window = Math.max(1, Math.round(opts.pairWindowMinutes));
  // Every value above is checked against a pattern without quotes or spaces, so single quotes hold it
  return `#!/bin/bash
# Written by kunj (src/lib/machines/bootstrap.ts). Log: /var/log/kunj-bootstrap.log
set -euo pipefail
exec >>/var/log/kunj-bootstrap.log 2>&1
echo "=== kunj bootstrap $(date -u +%FT%TZ)"
export DEBIAN_FRONTEND=noninteractive HOME=/root
KUNJ_PACKAGE='${opts.kunjPackage}'
PORT='${opts.port}'
PAIR_WINDOW='${window}'

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
command -v git >/dev/null 2>&1 || apt-get install -y git
command -v tmux >/dev/null 2>&1 || apt-get install -y tmux

id kunj >/dev/null 2>&1 || useradd --create-home --shell /bin/bash kunj
usermod -aG docker kunj

if [ "$(cat /etc/kunj-package 2>/dev/null || true)" != "$KUNJ_PACKAGE" ] || ! command -v kunj >/dev/null 2>&1; then
  case "$KUNJ_PACKAGE" in
    github:*)
      spec="\${KUNJ_PACKAGE#github:}"
      repo="\${spec%%#*}"
      ref="\${spec#*#}"
      rm -rf /opt/kunj-src
      git clone --depth 1 --branch "$ref" "https://github.com/$repo.git" /opt/kunj-src
      cd /opt/kunj-src
      npm ci --no-audit --no-fund
      npm run build
      tarball="$(npm pack --silent | tail -1)"
      npm install -g "/opt/kunj-src/$tarball"
      cd /
      rm -rf /opt/kunj-src
      ;;
    *)
      npm install -g "$KUNJ_PACKAGE"
      ;;
  esac
  echo "$KUNJ_PACKAGE" > /etc/kunj-package
fi

IP="$(hostname -I | awk '{print $1}')"
cat > /etc/systemd/system/kunj-serve.service <<UNIT
[Unit]
Description=kunj serve (cloud machine)
After=docker.service network-online.target
Requires=docker.service

[Service]
User=kunj
Group=docker
Environment=HOME=/home/kunj
WorkingDirectory=/home/kunj
ExecStart=$(command -v kunj) serve --listen $IP:$PORT --allow-remote-listen --allow-pairing --pair-window $PAIR_WINDOW
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable kunj-serve
systemctl restart kunj-serve
echo "=== kunj bootstrap done $(date -u +%FT%TZ)"
`;
}
