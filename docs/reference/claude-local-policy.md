# Local Claude connection policy

This fork launches Claude through the local Claude installation and its loopback gateway configuration. Orca can select a model and effort, but does not select managed Claude accounts, change connection settings or environment, or start Claude on SSH/WSL runtimes.

Orca native-pane Agent Teams are disabled because their tmux shim prepends a directory to PATH. The wrapper, launch planner, and host preparation reject this mode before creating a team or starting Claude. Existing live terminal adoption does not recreate the team. Restarting an old native-pane team may stop its old terminal before the new launch is refused.

Normal local Claude launches and the explicit in-process teammate mode remain available. The `orca claude-teams` wrapper is disabled even with an in-process argument; use the normal Claude launch with in-process mode instead.

Upstream account routing, connection overrides, automatic Claude settings/hooks installation and native-pane team tests describe behavior this fork deliberately restricts. Keep their exact differences visible in validation results; do not silently skip whole suites.

Structured sessions validate the resolved Claude home against the final child environment before spawning. Orca does not inject `CLAUDE_CONFIG_DIR` to make a mismatched home work. When native-chat shell inheritance is disabled and the local CLI depends on that variable, include it in the allowed inherited variables.
