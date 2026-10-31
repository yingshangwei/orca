# Stable signing for local macOS builds

Read this before changing how local (`-local.`) macOS builds are signed, or before treating a
local build's privacy prompts as an app bug.

## Why

A local build is ad hoc signed, so its designated requirement is its cdhash and every rebuild is
a new client to macOS. Folder grants (TCC) stop matching and re-prompt, the
`Orca Terminal Host.app` helper cannot satisfy the app's requirement so the daemon falls back to
the fork (see `macos-daemon-tcc-attribution.md`), and the "Orca Safe Storage" keychain item
answers only the build that created it. `desktop-keychain-guard.ts` keeps local builds away from
that item and stops every `security(1)` launch Orca makes; signing does not change that.

Self-hosted relay credentials use the separate `orca-relay-keychain` native helper. It disables
keychain interaction and stores a new sealing key in its own item. It does not unlock, migrate,
or read the existing Safe Storage item; see `native/relay-keychain-macos/README.md`.

`config/scripts/mac-local-signing.mjs` writes an explicit designated requirement into the app and
its terminal host:

```
identifier "com.stablyai.orca" and certificate leaf = H"<sha1>"
```

Every build signed with the same key satisfies it. `sign` fails unless `codesign -d -r-` prints
exactly that requirement for both bundles; a requirement that merely contains the certificate
(`… or true or certificate leaf = …`) is rejected.

## Commands

```
node config/scripts/mac-local-signing.mjs create          # once per machine
node config/scripts/mac-local-signing.mjs status
node config/scripts/mac-local-signing.mjs plan <Orca.app> # list what sign would touch
node config/scripts/mac-local-signing.mjs sign <Orca.app> # after the electron-builder build
node config/scripts/mac-local-signing.mjs sign <Orca.app> --legacy-app <old Orca.app>  # see below
```

`sign` re-signs innermost code first with `--preserve-metadata=entitlements,flags,runtime`, skips
the same payloads electron-builder skips (orcad template, non-mac ripgrep), and signs the terminal
host with the app's identity. It then requires `codesign --verify --deep --strict`, the exact
requirement on the app and the terminal host, and both satisfying it. It resolves the target's
real path and refuses anything inside `/Applications`, `/System` or `~/Applications`; sign a build
output and install it. The dmg/zip electron-builder produced alongside stay ad hoc.

`codesign` looks identities up through the user keychain search list even when `--keychain` is
given, so `sign` adds the signing keychain to that list for the signing loop only. Afterwards it
removes that one entry from the list as it is then, leaving changes other processes made
meanwhile, and does nothing if the keychain was already listed. It is removed before the keychain
is locked again.

## Compatibility with earlier ad hoc builds

Processes started by an earlier ad hoc build keep that build's cdhash until they exit. When one of
them and a newly signed build both touch a protected folder, differing requirements can make an
existing TCC grant stop matching. Alternating grants are a plausible cause of repeated prompts;
the exact update behavior must be confirmed in the affected runtime.

`--legacy-app` (repeatable, at most four) widens the requirement to exact old builds:

```
identifier "com.stablyai.orca" and (certificate leaf = H"<sha1>" or cdhash H"<old>" …)
```

- Each cdhash is read with `codesign -d` from the given bundle, only after
  `codesign --verify --deep --strict` passed on it and its identifier is `com.stablyai.orca`. Hashes
  are never accepted as text. After signing, every legacy bundle must satisfy the new requirement.
- Pass the old main app bundle that TCC names as `responsible_path` for those processes, not a
  helper. Any directory with `Contents/Info.plist` is accepted, so a renamed copy such as
  `Orca.app.saved` works. Keep that bundle unchanged until its processes exit. Helper processes
  (`com.stablyai.orca.helper`) never satisfy the app requirement, and that is expected. Do not add
  their cdhash.
- Nothing is inherited. The new build still gets its own folder prompt, which the user answers
  normally. The intent is that the row then stores this requirement, so the listed old builds and
  later builds of the same key match it too. Whether `tccd` stores and evaluates it that way for
  running processes is unverified; see the checks below before relying on it.
- If TCC adopts that compatible requirement, a denial made to the new build also covers the
  listed old builds.
- Later builds can drop `--legacy-app` once no listed process remains; they still match a stored
  compatible row through the certificate branch.

Before relying on it on a machine, confirm with the normal prompt flow that after one grant to the
new build, a process whose responsible app is each listed old build reads the folder without a
new prompt (TCC log `AUTHREQ_RESULT` for its pid shows allowed, no `AUTHREQ_PROMPTING`). Never edit
TCC to test it. `codesign --verify -R` against a running pid is not a substitute: it fails for
helpers by design and can fail with `Invalid argument` for a valid app process.

## Key custody

- A dedicated keychain at `~/Library/Application Support/Orca Local Signing/` (or
  `ORCA_LOCAL_SIGNING_DIR`), directory 0700, files 0600, with its own random password. It never
  needs the login keychain or its password. `sign` and `status` refuse the directory or its files if
  they are symlinks, owned by another user, or readable by others.
- The private key is imported non-extractable (`-x`), with `/usr/bin/codesign` as its trusted
  application and the partition list `apple-tool:` only, so codesign uses it without a dialog.
- The certificate is never added to trust settings; code signing does not need a trusted anchor.
- The keychain is in the user search list only while `sign` runs, and locked afterwards.
- Passwords travel over `security -i` stdin or the environment, never argv, and are never printed.

Anyone who can read that directory as the user can sign code that matches this requirement. That
is no wider than today: Orca's RunAsNode fuse already lets any same-user process run script as
Orca. Deleting the directory stops new builds from matching; it does not remove TCC rows that
already store the requirement, and code already signed with the key keeps matching them.

## Limits

A running process keeps the identity it was started with; re-signing on disk does not change it.
Signing removes rebuild churn. It cannot re-attribute running processes; `--legacy-app` only asks
TCC to accept their existing identity as well.
