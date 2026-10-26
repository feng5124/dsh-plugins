# dsh-plugins

Community plugins for [DeepSeek Harness (DSH)](https://deepseek.com).

| Package | What it does |
|---|---|
| [`packages/dsh-smart-mail`](packages/dsh-smart-mail) | Multi-account IMAP/SMTP send & read tools, whitelist-only headless wake on new mail, and **same-thread reply continuation**: a reply resumes the original DSH session, interrupting its running turn first, and restores the session when it was archived. Thread resolution follows References/In-Reply-To → `X-DSH-Session` → subject tag. Also ships quiet, rotated activity logging. Zero runtime dependencies. |
| [`packages/dsh-plugin-headless-sessions-panel`](packages/dsh-plugin-headless-sessions-panel) | Sidebar panel that lists running/recent headless DSH sessions and exports each as readable Markdown, with open-into-workspace actions. The session scanner ships inside the package. |

## Mail as a conversation entry point

`dsh-smart-mail` treats a mailbox as a session entry point rather than a notification
feed:

- every outgoing message carries a `[dsh-xxxx]` subject tag, an `X-DSH-Session` header,
  and a recorded `Message-ID`;
- an inbound reply resolves back to its thread (exact `References`/`In-Reply-To` first,
  then the header, then the subject tag — a client that drops one still works);
- a reply into a **running** session replaces that turn (`prompt` with `mode: 'steer'`,
  falling back to `queue` + `cancel` when steering is refused);
- a reply into an **archived** session restores it through the Workspace registry
  (`unarchiveSession`, or the equivalent `enqueueOperation`/`requireState`/`setState`
  write) instead of starting a new session;
- everything else — new senders, non-whitelisted mail, duplicates — never wakes anything,
  and says so in one aggregate log line per poll round.

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
