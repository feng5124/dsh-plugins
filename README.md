# dsh-plugins

Community plugins for [DeepSeek Harness (DSH)](https://deepseek.com).

| Package | What it does |
|---|---|
| [`packages/dsh-smart-mail`](packages/dsh-smart-mail) | Multi-account IMAP/SMTP send & read tools plus whitelist-only headless wake on new mail (QQ/163/Gmail/Outlook presets, custom servers, authorization-code auth). Zero runtime dependencies. |
| [`packages/dsh-plugin-headless-sessions-panel`](packages/dsh-plugin-headless-sessions-panel) | Sidebar panel that lists running/recent headless DSH sessions and exports each as readable Markdown, with open-into-workspace actions. The session scanner ships inside the package. |

## Install

Inside DSH, either install from the package name (after publishing to npm):

```
plugin_manager install_bundle target=dsh-smart-mail
plugin_manager install_bundle target=dsh-plugin-headless-sessions-panel
```

or install a local checkout by directory, or add this repository's market index
to the Plugins → Discover tab (experimental "Custom plugin markets").

## Releasing

See the release runbook in the publishing workspace (`dsh-market-publish/RUNBOOK.md`):
staged packages → npm publish or git tag → `generator.mjs` builds the format-1
market index → validated by the official validator → committed to the `gh-pages`
branch, served at `https://feng5124.github.io/dsh-plugins/index.json`.

## License

MIT — see [LICENSE](LICENSE).
