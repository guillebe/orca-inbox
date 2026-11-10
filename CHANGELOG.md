# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
