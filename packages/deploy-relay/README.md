# @loopsy/deploy-relay

One-command Cloudflare Workers deploy for the [Loopsy](https://github.com/leox255/loopsy) relay.

## What it does

Deploys a Loopsy relay Worker (with Durable Object for device sessions) to your own Cloudflare account on the free tier. Generates a fresh `PAIR_TOKEN_SECRET` and saves the relay URL to `~/.loopsy/relay.json` so the daemon can find it.

## Usage

```bash
npx @loopsy/deploy-relay
```

That's it. The CLI will:

1. Prompt for a worker name (default: `loopsy-relay-<random>`).
2. Optionally prompt for a custom domain (zone must already be on your CF account).
3. Run `wrangler deploy` — opens your browser for OAuth on first run.
4. Set the `PAIR_TOKEN_SECRET` (piped via stdin so it never lands on your clipboard).
5. Save the deployed URL to `~/.loopsy/relay.json`.

### Non-interactive

```bash
npx @loopsy/deploy-relay --worker-name my-relay --domain relay.example.com -y
```

### After deploy

```bash
# On your Mac:
loopsy relay configure https://my-relay.<your-cf-subdomain>.workers.dev
loopsy mobile pair --ttl 600

# On your phone:
# open https://my-relay.<your-cf-subdomain>.workers.dev/app
# scan the QR shown in the terminal, enter the 4-digit code
```

## Cost

Free. Cloudflare Workers free tier covers 100k requests/day; a single user typically uses far fewer. SQLite-backed Durable Objects are also free-tier eligible.

If you exceed the free tier, Cloudflare will email you before charging.

## Security notes

- The `PAIR_TOKEN_SECRET` is generated fresh per deploy with `crypto.randomBytes(32)`.
- It is set via `wrangler secret put` with stdin piping — the secret never appears in process args or shell history.
- The config file at `~/.loopsy/relay.json` is written `chmod 600`.
- See [SECURITY.md](https://github.com/leox255/loopsy/blob/main/SECURITY.md) in the main repo for the full threat model.

## License

Apache-2.0
