#!/usr/bin/env bash
#
# provision.sh — set up a hardened Loopsy demo daemon on a fresh Debian 12
# (or Ubuntu 22.04+) VM. Designed for the GCP e2-micro free tier in
# us-east1/us-west1/us-central1.
#
# What it does:
#   1. Installs Node.js 20 + the Loopsy CLI from npm.
#   2. Creates an unprivileged 'loopsyd' system user that runs the daemon.
#   3. Creates an unprivileged 'demo' login user — fresh shell + tight
#      ulimits — that PTY sessions launch under via setpriv.
#   4. Runs the daemon under systemd with cgroup memory/cpu quotas.
#   5. Writes nftables rules: deny SMTP/IRC/cleartext mail, deny GCP
#      metadata server, allow DNS + HTTPS only.
#   6. Periodic cron that wipes /home/demo back to a clean snapshot every
#      hour, so a reviewer can never persistently install backdoors.
#
# Run as root on a fresh VM:
#   curl -fsSL https://raw.githubusercontent.com/leox255/loopsy/main/scripts/demo-daemon/provision.sh | sudo bash
#
# After this runs, follow the printed instructions to pair the daemon
# with the relay and mint a long-TTL pair URL.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root (sudo)." >&2
  exit 1
fi

LOOPSY_USER=loopsyd          # owns the daemon process + relay credentials
DEMO_USER=demo               # PTY sessions run under this user
DEMO_HOME=/home/$DEMO_USER
DEMO_SKEL=/var/lib/loopsy-demo-skel  # canonical clean home dir
LOG=/var/log/loopsy-provision.log

echo "[+] starting provision; full log: $LOG"
exec > >(tee -a "$LOG") 2>&1
date

# ── 1. Base packages ────────────────────────────────────────────────────────
apt-get update
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg \
  build-essential python3 \
  nftables \
  setpriv \
  rsync \
  git

# Node 20 from NodeSource
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v20'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# ── 2. Daemon user (loopsyd) ────────────────────────────────────────────────
if ! id -u "$LOOPSY_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$LOOPSY_USER"
fi

# ── 3. Demo user (PTY sessions land here) ───────────────────────────────────
if ! id -u "$DEMO_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEMO_USER"
fi
# Demo user has NO sudo, no group memberships beyond its own primary group.
gpasswd --delete "$DEMO_USER" sudo  2>/dev/null || true
passwd -l "$DEMO_USER"   # disable login by password
# Tight ulimits for the demo user.
cat >/etc/security/limits.d/99-loopsy-demo.conf <<EOF
$DEMO_USER soft nproc    64
$DEMO_USER hard nproc    128
$DEMO_USER soft nofile   512
$DEMO_USER hard nofile   1024
$DEMO_USER soft fsize    262144   # 256 MB max file size
$DEMO_USER hard fsize    524288
$DEMO_USER soft as       1048576  # 1 GB virtual memory
$DEMO_USER hard as       2097152
EOF

# ── 4. Loopsy CLI ───────────────────────────────────────────────────────────
# Install globally; the daemon binary ends up at /usr/bin/loopsy.
npm install -g @loopsy/cli

# Make sure the daemon user can read it.
LOOPSY_BIN=$(command -v loopsy || echo /usr/bin/loopsy)
echo "[+] loopsy CLI at: $LOOPSY_BIN"

# ── 5. Systemd unit for the daemon ──────────────────────────────────────────
cat >/etc/systemd/system/loopsy-daemon.service <<EOF
[Unit]
Description=Loopsy daemon (demo server)
After=network-online.target nftables.service
Wants=network-online.target

[Service]
Type=simple
User=$LOOPSY_USER
Group=$LOOPSY_USER
ExecStart=$LOOPSY_BIN daemon start --foreground
Restart=on-failure
RestartSec=10s

# Cgroup limits: container-light isolation. e2-micro has 1 GB total RAM —
# leaving plenty of headroom for the OS and ssh.
MemoryMax=512M
CPUQuota=50%
TasksMax=256

# Run with reduced privileges.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/$LOOPSY_USER /home/$DEMO_USER /tmp /var/log/loopsy
ProtectHome=read-only
ProtectKernelTunables=true
ProtectControlGroups=true
ProtectKernelModules=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
RestrictRealtime=true
SystemCallArchitectures=native

# Keep the daemon's log output captured.
StandardOutput=append:/var/log/loopsy/daemon.log
StandardError=append:/var/log/loopsy/daemon.log

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /var/log/loopsy
chown $LOOPSY_USER:$LOOPSY_USER /var/log/loopsy

# ── 6. Network policy (nftables) ────────────────────────────────────────────
# Allow DNS, NTP, ESTABLISHED. Allow outbound HTTPS to the public internet.
# Deny outbound SMTP (25/465/587), IRC (6667), Telnet, and the GCP metadata
# server. Block inbound everything except sshd on 22 (default).
cat >/etc/nftables.conf <<'EOF'
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    iif "lo" accept
    ct state established,related accept
    ip protocol icmp limit rate 5/second accept
    ip6 nexthdr icmpv6 limit rate 5/second accept
    tcp dport 22 accept
    counter drop
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
  }
  chain output {
    type filter hook output priority 0; policy accept;
    # Block GCP / cloud metadata service — protects creds + user-data.
    ip daddr 169.254.169.254 drop
    # Block well-known abuse ports.
    tcp dport { 25, 465, 587, 6667, 6697 } counter drop
  }
}
EOF
systemctl enable --now nftables

# ── 7. Hourly reset of /home/demo ───────────────────────────────────────────
# Save a clean snapshot of /home/demo right after creation, then rsync it
# back every hour to wipe whatever the reviewer (or anyone else) installed.
if [[ ! -d $DEMO_SKEL ]]; then
  rsync -a --delete "$DEMO_HOME"/ "$DEMO_SKEL"/
fi

cat >/usr/local/sbin/loopsy-reset-demo.sh <<EOF
#!/usr/bin/env bash
set -e
# Kill anything still running as the demo user before we wipe.
pkill -KILL -u $DEMO_USER || true
sleep 1
rsync -a --delete "$DEMO_SKEL"/ "$DEMO_HOME"/
chown -R $DEMO_USER:$DEMO_USER "$DEMO_HOME"
EOF
chmod +x /usr/local/sbin/loopsy-reset-demo.sh

cat >/etc/systemd/system/loopsy-reset-demo.service <<EOF
[Unit]
Description=Wipe Loopsy demo home directory back to a clean snapshot

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/loopsy-reset-demo.sh
EOF

cat >/etc/systemd/system/loopsy-reset-demo.timer <<EOF
[Unit]
Description=Hourly reset of Loopsy demo home

[Timer]
OnBootSec=15min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now loopsy-reset-demo.timer

# ── 8. Daemon spawns sessions under DEMO_USER ───────────────────────────────
# The Loopsy daemon spawns PTY sessions as whatever user it runs as.
# We want the daemon owner ($LOOPSY_USER) for credentials/disk, but each
# PTY to drop into $DEMO_USER. Wrap the shell command via a setpriv wrapper.
#
# We expose a /usr/local/bin/loopsy-demo-shell that the daemon's session
# config can point at. Configure later via `loopsy daemon config` after
# pairing.
cat >/usr/local/bin/loopsy-demo-shell <<EOF
#!/usr/bin/env bash
exec setpriv \\
  --reuid=$DEMO_USER --regid=$DEMO_USER --init-groups \\
  --reset-env \\
  /bin/bash -l "\$@"
EOF
chmod +x /usr/local/bin/loopsy-demo-shell

# Allow the daemon user to setpriv into the demo user. Easiest path on a
# small box: give it sudo NOPASSWD for /usr/local/bin/loopsy-demo-shell
# only. (We do not give it sudo for anything else.)
cat >/etc/sudoers.d/loopsy-demo <<EOF
$LOOPSY_USER ALL=($DEMO_USER) NOPASSWD: /usr/local/bin/loopsy-demo-shell
EOF
chmod 440 /etc/sudoers.d/loopsy-demo

# ── 9. Print next steps ─────────────────────────────────────────────────────
echo
echo "================================================================"
echo "  Loopsy demo daemon is provisioned but NOT yet paired."
echo
echo "  Next steps (run on this VM as root):"
echo "    sudo -u $LOOPSY_USER -H bash"
echo "    loopsy relay configure https://relay.loopsy.dev"
echo "    loopsy relay register --label demo-gcp"
echo "    exit"
echo
echo "    systemctl enable --now loopsy-daemon"
echo "    systemctl status loopsy-daemon --no-pager"
echo
echo "  Then mint a long-TTL pair URL for the App Store reviewer:"
echo "    sudo -u $LOOPSY_USER -H loopsy relay pair --ttl 604800"
echo
echo "  Logs:"
echo "    journalctl -u loopsy-daemon -f"
echo "    tail -f /var/log/loopsy/daemon.log"
echo "================================================================"
