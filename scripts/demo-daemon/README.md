# Loopsy demo daemon (GCP e2-micro)

A small, hardened, always-on Loopsy daemon that the App Store reviewer (and anyone curious) can pair against — so they can verify the iOS app's full functionality without installing anything on their own machine. Free forever on the GCP e2-micro tier.

## What you get

- A Debian VM running `loopsy daemon start` 24/7.
- Daemon registered to `relay.loopsy.dev` so pair URLs use the public relay.
- Sessions land in a sandboxed `demo` user with tight ulimits, no sudo, and no SSH keys.
- Hourly snapshot reset of `/home/demo` — anything the reviewer (or anyone else) installs is wiped within an hour.
- Outbound firewall blocks SMTP, IRC, GCP metadata, and other abuse vectors.

## One-time provisioning

### 1. Create a free e2-micro VM

GCP free tier permits **one** e2-micro per month in `us-east1`, `us-west1`, or `us-central1`.

In the GCP Console → Compute Engine → VM instances → **Create instance**:

| Field | Value |
| --- | --- |
| Name | `loopsy-demo` |
| Region | `us-central1` (or `us-west1` / `us-east1`) |
| Zone | any |
| Machine type | `e2-micro` (Free tier eligible) |
| Boot disk | Debian 12 (bookworm), 30 GB standard persistent disk |
| Identity & API access | Default service account, no scopes (Allow none) |
| Firewall | leave both HTTP/HTTPS unchecked (we don't need ingress) |

Click **Create**. The VM boots in ~30 seconds.

### 2. Open SSH

GCP Console → VM instances → click `SSH` next to `loopsy-demo`.

### 3. Run the provisioning script

```bash
curl -fsSL https://raw.githubusercontent.com/leox255/loopsy/main/scripts/demo-daemon/provision.sh \
  | sudo bash
```

This installs Node.js, the Loopsy CLI, a `loopsyd` service user, a sandboxed `demo` user, systemd unit, nftables rules, and the hourly reset timer. Takes ~3 minutes.

### 4. Pair the daemon to the relay

Still in the GCP SSH session:

```bash
sudo -u loopsyd -H bash
loopsy relay configure https://relay.loopsy.dev
loopsy relay register --label demo-gcp
exit
sudo systemctl enable --now loopsy-daemon
sudo systemctl status loopsy-daemon --no-pager | head -10
```

You should see `Active: active (running)`.

### 5. Mint the long-TTL pair URL for the reviewer

```bash
sudo -u loopsyd -H loopsy mobile pair --ttl 604800
```

`--ttl 604800` is 7 days — enough to cover Apple's review window. The relay caps it at 7 days because we set `PAIR_TOKEN_MAX_TTL_SEC=604800` on `relay.loopsy.dev` (see `packages/relay/wrangler.toml`); a self-hoster's relay would still cap at 30 minutes by default.

The CLI prints:
- A QR code (ignore — Apple's reviewer pastes the URL directly)
- A line **`Or open this link on your phone: https://relay.loopsy.dev/app#loopsy%3A...`**
- A **4-digit verification code**

Both go into App Store Connect → App Review Information → Notes.

## Tearing it down

After the App Store approval lands, you have options:

```bash
# Option A — keep it running for marketing demos. Just rotate the pair URL:
sudo -u loopsyd -H loopsy phone revoke <reviewer's phone_id>
sudo -u loopsyd -H loopsy mobile pair --ttl 604800

# Option B — shut it down completely (saves a free-tier slot):
sudo systemctl disable --now loopsy-daemon
gcloud compute instances stop loopsy-demo --zone=us-central1-a
```

## Security model

| Threat | Mitigation |
| --- | --- |
| Reviewer (or anyone with the pair URL + SAS) installs persistent backdoor | `/home/demo` reset every hour from a clean snapshot via systemd timer |
| Reviewer pivots to attack other targets | nftables drops outbound SMTP/465/587/IRC; daemon can only reach the relay + DNS |
| Reviewer reads daemon credentials | Daemon runs as `loopsyd`; sessions run as `demo` via setpriv. `demo` cannot read `/home/loopsyd` |
| Reviewer reads cloud metadata (steal GCP service-account token) | nftables drops `169.254.169.254` outbound |
| Resource exhaustion (mining, fork bomb, big files) | Per-user `nproc=128`, `nofile=1024`, `fsize=512M`, plus systemd `MemoryMax=512M`, `CPUQuota=50%`, `TasksMax=256` on the daemon cgroup |
| SAS brute-force on the long-TTL token | Token is single-use; once redeemed (any pair attempt that succeeds), it's burned. SAS is 4 digits → ~10K guesses; even unthrottled, redeeming from a single IP at 1 req/sec takes hours and is visible in Worker logs |
| Long pair-URL TTL leaks | TTL ceiling is 7 days; rotate after every review by running `loopsy mobile pair` again |

## Re-running the script

`provision.sh` is idempotent — running it again on the same VM is safe; it'll patch settings without breaking the running daemon.
