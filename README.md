# Projects

Browse your community's projects, repositories and linked channels in Buzz 1.0.

Buzz 1.0 can open a repository from a link, but it has no page that lists them.
This plugin adds one, with a folder-based file browser.

## Getting started

1. Open **Projects** in the sidebar.
2. Choose a repository to browse its file tree, README and commits.
3. Press `/` to find a file by name, then use the arrow keys and Return.

Pull requests and issues open in Buzz's built-in repository page.

## Install

In Buzz, open **Settings → Plugins → Manage plugins**, add the repository
`nickhenggeler/buzz-projects-plugin`, then review and install it.

Or open this link on a Mac:

```sh
open 'buzz://plugin-install?repository=nickhenggeler%2Fbuzz-projects-plugin&ref=main'
```

## Limits

- Projects is read-only. It can't create or edit projects yet.
- Buzz gives each repository read about 12 seconds, so large repositories or slow
  servers can fail to load. Use **Try again** if that happens.
- Markdown support covers common formatting. Images and raw HTML aren't shown.
- There is no syntax highlighting yet.

## Development

The plugin is one dependency-free file, `plugin.js`, with no build step.
Run the tests on macOS with `tests/run.sh`.

To try the interface with sample data, serve this folder and open
`tests/preview.html`. It runs the real plugin with a fake community, and adding
`?delay=4600` simulates a slow server.

## License

Apache-2.0
