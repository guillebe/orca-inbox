# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- You need [Orca](https://www.onorca.dev) 1.4.248 or later: the tests run on Orca's own runtime.

## Workflow

1. Fork and clone the repository, then load your copy: `orca plugin dev watch . --json`.
2. Make the change. Keep decisions in `src/model.ts` as pure functions with unit tests; the worker
   and the panel should stay thin I/O around them.
3. Run the checks, all of which must pass:

   ```sh
   orca plugin validate . --json
   orca plugin test . --json
   orca plugin check . --json
   ```

4. Add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
5. Open a pull request that says what changed, why, and how you checked it with a real agent.

## Guidelines

- **Fail open.** If the plugin cannot do its job in time, the agent must be able to ask in its
  terminal as usual. Never leave a question stuck.
- **Never type into a prompt.** Text sent to a terminal ends with Enter; check the agent is not
  `blocked` first.
- **Ask for the least access.** A new capability needs a reason in the pull request and a row in
  the README's access table.
- **Comment the why.** Explain hidden constraints (Orca limits, hook timing), not what the code does.
- **No personal data in fixtures or screenshots.** Use neutral examples such as `acme/web-app`.

## Releasing (maintainers)

1. Move the `Unreleased` notes in `CHANGELOG.md` under the new version.
2. Set `version` in `orca-plugin.json`, commit, and tag it: `git tag -a v0.2.0 -m v0.2.0`.
3. Push the commit and the tag.
