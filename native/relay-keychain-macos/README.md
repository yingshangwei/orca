# Relay keychain helper

The desktop uses this macOS helper only for self-hosted relay credentials. It never reads
the existing Orca Safe Storage item or other account credentials. Every operation disables
Security.framework user interaction before opening the default keychain and fails when it
cannot proceed without a dialog. The desktop also limits the helper process to two seconds.

`get-or-create` creates a random 32-byte key in the dedicated
`com.stablyai.orca.mobile-relay` / `sealing-key-v1` item. `read` never creates or replaces an
item. The key travels through a captured pipe to the desktop, which reuses Orca's existing
authenticated AES-256-GCM sealing code. Only ciphertext is written to the relay configuration.
The helper refuses to print the key directly to a terminal. `status` returns no key material.

Build with `pnpm run build:relay-keychain-macos`. The universal executable is packaged in
`Contents/MacOS/orca-relay-keychain` and signed with the app's signing identity. Keep that
signing identity stable across local upgrades so the existing item can recognize the helper.
If the identity changes or the keychain locks, operations fail without prompting; the stored
ciphertext remains intact. Existing safeStorage ciphertext still uses the existing guarded
reader. Linux and Windows retain their existing SecretStore.
