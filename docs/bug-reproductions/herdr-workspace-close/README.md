# Herdr workspace close

Deleting an imported workspace from Orca's Herdr group must behave like closing that terminal in
Herdr, and a later sync must not bring it back. This note records the source design and the checks
to run; it is not a test result.

## Source behavior

- `RuntimeProjectGroupController.deleteFolderWorkspace` runs the hook before PTY teardown, state
  cleanup and catalog removal. A hook failure leaves all of them untouched.
- `HerdrSyncService.closeFolderWorkspace` shares a queue with `sync()`, so a stale sync save cannot
  overwrite `binding.closed`. The flag is written only after the close is confirmed, so `closed`
  means the source was confirmed closed. A later sync retries a closed binding whose pane is back.
- `closeHerdrTerminal` finds the current pane through the stable `terminal_id`, closes that pane
  only, and trusts the follow-up snapshot over the CLI exit code.
- A binding whose folder is absent from the full catalog is marked `suppressed`, not closed: the
  catalog cannot tell a deletion from lost data, because `normalizeFolderWorkspaces` drops folders
  of a group without `parentPath`. Sync and the status bridge skip it, and Herdr is not touched. A
  folder that is only absent from the visible catalog is left alone.
- `suppressed` is permanent for sync: repairing a group path or restoring the folder does not
  resume the import. Deleting a restored folder still goes through the hook and closes the source.
- Historical bindings with a missing folder only become `suppressed`. This does not close them;
  panes of confirmed historical deletions need a separate decision backed by evidence.
- A project group delete does not pass through the hook. Its bindings become `suppressed` on the
  next sync and their panes stay open in Herdr.
- New sub-groups store the importing pane's `foreground_cwd || cwd` as `parentPath`, so imported
  folders survive the restart normalization. A new pane without a working directory is reported as
  an issue and creates nothing.

## Checks

Use a dedicated Herdr session and an isolated Orca profile.

1. Split one tab into two panes, sync, delete one workspace. The other pane stays; the tab stays.
2. Delete the workspace of the last pane in a tab. The tab disappears.
3. Sync twice, restart Orca, sync again. Nothing is reimported.
4. Stop Herdr, delete a workspace. The delete fails and the row and its terminal tab remain.
5. Delete a project group, sync, restart Orca, sync again. Nothing is reimported and the panes
   stay open in Herdr.
6. Close the only pane of the only Herdr workspace from Orca. Confirm the read-back still answers.
7. Delete an ordinary local folder and an SSH folder. Neither touches Herdr.
8. Sync a pane into a new sub-group and restart Orca. The folder is still listed.
9. Remove a binding's folder from the profile, sync and restart. Nothing is reimported, no status
   appears and the pane stays open. Restore the folder, delete it from Orca, and the pane closes.

Existing imported groups with an empty parent path are repaired through the internal runtime and
persistence methods. An existing nonempty path is preserved; public RPC/IPC update schemas are unchanged.
