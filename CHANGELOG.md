# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Answer from the agent's terminal as well as the panel: the agent restates the question with
  numbered options, and the Inbox thread closes on its own once you reply there.
- An "Other" field on every question, for an answer of your own.
- The agent's state (working, waiting, blocked) beside each open thread.
- A warning when a thread's session is closed, with sending disabled.
- **Clear closed** in the Closed tab; closed threads older than 7 days are removed on their own.
- Threads grouped by workspace when several workspaces have open threads.

### Changed

- The back button reads "← Inbox" instead of using an upward chevron.
- Thread layout: the session text is shown in full on its own line, sections are separated, and
  option descriptions show under each option.

## [0.1.0] - 2026-11-10

### Added

- Capture Claude Code `AskUserQuestion` calls as question threads, answered from the panel.
- Capture `ExitPlanMode` calls as plan threads: approve, or request changes with feedback.
- Threads for agents blocked in their terminal, closed when the agent moves on.
- Session title and workspace on every thread, and **Go to session** to jump to the agent.
- Status bar count, desktop notifications, and a setting to switch each capture off.
- Safeguards: fail open past 1.5 s, no replies into a blocked prompt, rollback when a reply is not
  delivered, dedupe of retried calls, and text caps under Orca's render limits.

[Unreleased]: https://github.com/guillebe/orca-inbox/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/guillebe/orca-inbox/releases/tag/v0.1.0
