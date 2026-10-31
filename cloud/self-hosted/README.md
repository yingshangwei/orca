# Self-hosted relay

This deployment runs the director, relay cell and desktop token issuer on one server. It uses local signing keys and an enrolled access key for each desktop, without an Orca Cloud account or Google service account. The existing end-to-end encrypted relay protocol and phone credentials are unchanged.

The desktop can select **Orca** (official) or **Self-hosted**. Orca remains the default. Switching preserves the saved self-hosted configuration and existing paired devices, and activates only the selected relay. A self-hosted connection failure does not switch to Orca automatically.

## Prepare the server

Use a public server with Docker Compose, a domain pointing directly to that server, and TCP ports 80 and 443 reachable. Use DNS-only records for this reference deployment. The included Caddy service obtains and renews its HTTPS certificate. The relay's port 8080 stays inside the Compose network. This is a single-server deployment with SQLite; keep its persistent volume when upgrading.

Build the desktop and mobile app from this branch. In the desktop's Mobile connection settings, copy the displayed host public key. The key belongs to that desktop installation's pairing data; do not use a private key or a phone key.

On the server, from the repository root, run with Node.js 24 or later:

```sh
node cloud/self-hosted/setup.mjs \
  --url https://relay.example.com \
  --host-public-key 'BASE64_PUBLIC_KEY_COPIED_FROM_ORCA' \
  --device-name 'My desktop'
```

Replace the example domain and public key. The URL must be an HTTPS origin on the standard port 443, without a trailing slash or path. The command creates `cloud/self-hosted/generated/` with restricted permissions. It writes the desktop access key to `desktop-credentials.txt` and stores only its SHA-256 hash in the server authentication file. It never prints the access key. It refuses to overwrite an existing generated directory.

```sh
cd cloud/self-hosted
docker compose up --build -d
docker compose ps
curl --fail https://relay.example.com/ready
```

The one-shot `relay-init` container copies the authentication file into the persistent volume with permissions for the unprivileged relay process. The relay starts after that copy; Caddy starts when the relay is healthy. No official deployment repository or Terraform is needed.

The generated configuration enables `ORCA_RELAY_SELF_HOSTED_TRUST_PRIVATE_PROXY=true`. It accepts one client-IP header from a private or loopback socket peer, so limits apply per client instead of to the Caddy container. The Caddyfile explicitly replaces that header with the actual peer address, following [Caddy's header handling](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers). Keep port 8080 private; adding a CDN or another proxy requires adapting this trust boundary. The option defaults to false for direct deployments and cannot change cloud-mode behavior.

For a native deployment with a reverse proxy on the same server, set `ORCA_RELAY_BIND_HOST=127.0.0.1` to keep the relay listener on loopback. Leaving this variable unset preserves the existing listener behavior used by Compose and cloud deployments.

To build an Android app that can be installed alongside the official app, run `ORCA_MOBILE_SELF_HOSTED_BUILD=1 npx expo prebuild --platform android --no-install` from `mobile/`, then build the release APK with both `ORCA_MOBILE_SELF_HOSTED_BUILD=1` and `EXPO_PUBLIC_ORCA_SELF_HOSTED_BUILD=1`. This variant is named **Orca Selfhost** and uses `com.stably.orca.mobile.selfhost`. It omits the official Firebase configuration; use it with the self-hosted relay, which does not provide the official push gateway. Sign local releases with your own Android signing key. The default build keeps its existing package and notification configuration.

The self-hosted desktop and mobile build accept relay cell addresses only when they exactly match the configured director origin. A director response cannot redirect a relay socket to another host or port. Phone authorization and end-to-end encryption are still verified by the desktop independently of the relay's outer authentication.

## Connect and switch

1. Read `generated/desktop-credentials.txt` locally on the server. In the desktop's Mobile settings choose Self-hosted, enter the relay URL and access key, and save. The desktop stores the key using the operating system's protected secret storage; it does not return it to the settings UI.
2. Generate a relay QR code and scan it with the mobile app built from this branch. The phone learns the relay URL from the QR code. It does not receive the desktop access key.
3. To use the official service, select Orca and use the existing Orca login. Scan its QR once if that backend has not been paired before. The mobile app keeps the two connections separately and shows the relay hostnames when needed to distinguish them.
4. When switching back, open the matching saved phone connection. A previously paired phone retains its credentials; switching providers does not revoke them.

The normal protocol expiration still applies: successful connections renew the phone's 30-day resume credential. An unused backend whose credential expires, a revoked device, or cleared desktop/mobile data can require another scan. Both the desktop and mobile build must include this change to retain separate entries for the same desktop across backends. Older mobile builds may merge them by desktop public key.

Self-hosted mode disables Orca's official push gateway. Foreground remote access works; background OS push notifications are not supplied by this deployment. Selecting Orca restores the existing official push behavior. Other optional Orca features, such as account sync, are outside the relay provider switch.

## Persistence and maintenance

Back up `generated/` and the `relay_data` volume together, with the relay stopped for a consistent SQLite backup. The database stores phone credential hashes and assignments. Recreating containers preserves those records; deleting volumes or regenerating keys does not.

Authentication configuration is loaded at startup. To revoke a desktop's ability to obtain new relay tokens, remove its entry from `generated/auth.json` and recreate both `relay-init` and `relay` (the auth file must retain at least one enrolled desktop). For a one-desktop installation, stop the relay while replacing its access key. A restart also ends existing connections. Do not remove the data volume when rotating only an access key.

```sh
docker compose up -d --force-recreate relay-init relay
```

Self-hosted mode requires `ORCA_RELAY_AUTH_MODE=self-hosted`, `ORCA_RELAY_SELF_HOSTED_AUTH_FILE`, `ORCA_RELAY_PUBLIC_URL`, and `ORCA_RELAY_ASSIGNMENT_SIGNING_KEY`. It supports the `combined` role only. It serves public verification keys at `/.well-known/jwks.json`, accepts desktop token requests at `/v1/self-hosted/token`, and disables the official `/v1/admin/*` API. Do not expose the generated files through a web server.

## Local verification

```sh
node --test cloud/self-hosted/setup.test.mjs
cd cloud
pnpm --filter @orca-cloud/relay test src/self-hosted-relay-auth.test.ts src/config.test.ts src/relay-readiness.test.ts
pnpm --filter @orca-cloud/relay typecheck
```

The integration test uses a real local HTTP/WebSocket relay and SQLite: it enrolls a desktop, completes the host key proof, pairs a phone, restarts the server, reconnects with the saved resume credential, forwards bytes and renews the credential. Requests to external authentication services are rejected by the test harness. A real public deployment still needs its own DNS, certificate and phone-network check.

See [implementation validation](./VALIDATION.md) for the checks completed on this branch and the remaining deployment checks.
