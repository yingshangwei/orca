# Implementation validation — 2026-10-27

Implemented on `codex/selfhost-relay`, based on `57ecdc2ca289`. This is source and local validation; the existing installed Orca app and public servers were not replaced or deployed.

## Passed

- Desktop `pnpm tc` passed all four projects. The initial focused regression run passed 43 files / 375 tests. After review fixes, the affected eight files passed another 54 tests, including issued and in-flight QR invalidation, preserving paired devices, backend ownership, protected configuration, and recovery from corrupt settings.
- Mobile application `pnpm typecheck` passed. Pairing, host persistence, overlay validation and backend labels passed the focused regression suites. The final recovery fixture change passed all 15 tests in that file.
- Cloud `pnpm build` passed. The official relay/config/readiness regression run passed 65 tests. The self-hosted auth, client admission and configuration run passed 22 tests. Setup generation passed two Node tests.
- The self-hosted integration test uses real HTTP, WebSocket and SQLite: desktop enrollment and key proof, phone pairing, server restart, saved-credential resume, byte forwarding and credential renewal. Its external authentication fetch is blocked. Admission tests verify clients behind the included private proxy do not all share one unauthenticated-connection limit.
- A hidden Electron instance using an isolated home and user-data directory passed the settings test: corrupt-config recovery, invalid-URL rejection, saving, switching to Orca and back, retained configuration, and no saved access-key readback. It asserts all app windows stay hidden. The OS secret-store adapter is replaced only inside this disposable test process to avoid keychain prompts; store tests separately exercise encryption failures and preserving sealed data.
- The changed-code quality gate reported zero findings, including type assertions, React and design-system checks.
- Localization extraction, the runtime English catalog check and localization coverage passed. `git diff --check` passed.

## Known validation limits

- The full mobile **test** typecheck is already failing on the base commit. With the same dependencies, the base produced 571 diagnostics and this branch produced 540. Comparing diagnostics while ignoring moved line numbers found no new diagnostics. This is distinct from the passing mobile application typecheck and runtime tests.
- Docker is not available on this machine. The Compose YAML was parsed and its private backend port, secret initialization and startup dependencies checked, but the image and Compose deployment were not run.
- Public DNS, Caddy certificate issuance, a deployed server and a physical phone on a public network remain unverified. This branch's desktop and mobile apps must be built and installed before both backend entries can be retained on a real phone.
- Self-hosted mode does not supply background APNs/FCM push notifications. It turns off the official desktop push service; an already submitted request may finish during a switch. Foreground relay traffic uses the selected backend, and a failure never silently selects Orca.
