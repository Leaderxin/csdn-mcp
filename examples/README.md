# Client examples

Four ready-to-paste configurations for the same MCP server. They differ only in the
file each client reads and in how that client spells a server entry.

> **WARNING — a CSDN cookie is a credential.** `CSDN_COOKIE` contains `UserToken`,
> which is equivalent to a login session for your account. Do not commit a real
> cookie, do not paste one into an issue, and do not share a config file that has
> one filled in. If a cookie leaks, sign out of CSDN in that browser to invalidate
> the old token. `README.md` at the repository root and `CONTRIBUTING.md` say the
> same thing for a reason: automated secret scanning fails the build on it.
>
> **警告：`CSDN_COOKIE` 等同账号登录凭证，切勿提交到仓库或粘贴到公开处。**

## Before you start

1. Build the server. Every example points at the **built** entry point, not the
   TypeScript sources, so a fresh clone needs this first:

   ```bash
   npm ci && npm run build   # produces dist/index.js
   ```

2. Replace the placeholder path `/ABSOLUTE/PATH/TO/csdn-mcp/dist/index.js` with the
   real path to your clone. It must be absolute:
   - macOS / Linux: `/Users/you/code/csdn-mcp/dist/index.js`
   - Windows: `C:/code/csdn-mcp/dist/index.js` (forward slashes are safest in JSON;
     if you use backslashes they must be doubled: `C:\\code\\csdn-mcp\\dist\\index.js`)

3. Replace `PASTE_YOUR_FULL_COOKIE_HEADER_HERE` with the whole `Cookie` header from
   F12 → Network → any `csdn.net` request → Request Headers → Cookie. It has to
   contain `UserToken=`; that cookie is HTTP-only, so `document.cookie` can never
   produce a working value.

4. `node` must be resolvable by the client process. On Windows, a GUI client that
   cannot find `node` needs `"command": "C:/Program Files/nodejs/node.exe"`.

5. Restart the client after editing a config file; none of these clients pick up a
   change live.

## Where each file goes

### `claude-desktop.json` → Claude Desktop

Copy the contents into `claude_desktop_config.json`.

| OS      | Path                                                              |
| ------- | ----------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json`                     |
| Linux   | `~/.config/Claude/claude_desktop_config.json`                     |

If that file already has an `mcpServers` object, merge the `csdn-mcp` key into it
instead of replacing the file.

### `cursor.json` → Cursor

Copy to `.cursor/mcp.json` — either in the project (per-project servers) or in your
home directory (available in every project).

| OS      | Path                             |
| ------- | -------------------------------- |
| macOS   | `~/.cursor/mcp.json`             |
| Windows | `%USERPROFILE%\.cursor\mcp.json` |
| Linux   | `~/.cursor/mcp.json`             |

### `cline.json` → Cline (VS Code extension)

Copy to `cline_mcp_settings.json`:

| OS      | Path                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Windows | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`                     |
| Linux   | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`                     |

Cline owns this file: it writes to it whenever you toggle a server in its MCP panel,
so prefer that panel over hand-editing. The panel may add keys this example does not
show (`timeout`, `type`, per-tool `autoApprove` entries). Keep `autoApprove` empty for
this server — `publish_article`, `delete_article` and `update_article` change real
articles, and auto-approved writes execute before you can review them.

The path above is for the VS Code extension. VSCodium, JetBrains and the Cline CLI
use their own `globalStorage`/config directories; Cline's docs list them.

### `vscode-continue.yaml` → Continue

Continue is the odd one out: its YAML `mcpServers` is a **list**, and each entry
carries a `name`. Save the file as
`<workspace>/.continue/mcpServers/csdn-mcp.yaml`, or append its `mcpServers:` block
(without the `name`/`version`/`schema` header) to the global `config.yaml`:

| OS      | Global config                         |
| ------- | ------------------------------------- |
| macOS   | `~/.continue/config.yaml`             |
| Windows | `%USERPROFILE%\.continue\config.yaml` |
| Linux   | `~/.continue/config.yaml`             |

MCP tools are only available in Continue's **agent** mode. Continue also accepts
Claude/Cursor/Cline JSON files dropped into `.continue/mcpServers/`, so
`claude-desktop.json` from this directory works as well if the YAML shape gives you
trouble.

## How confident are these key names?

- `mcpServers` → `<name>` → `command` / `args` / `env` is the shared stdio shape and
  is the same for Claude Desktop, Cursor and Cline. This is what all four files use.
- Cline additionally understands `disabled`, `autoApprove`, `timeout` and optionally
  `type: "stdio"`. Only `disabled`/`autoApprove` are shown here.
- Continue's `name` (required), `command` (required), `args`, `env`, `cwd` come from
  its `config.yaml` reference.
- Anything beyond those keys is **not** asserted by this repository. Client config
  formats change between releases: if a client rejects one of these files, add the
  server through its own UI and copy back whatever it writes — that file is
  authoritative for your version.

## Verifying it works

The MCP handshake is invisible, so a client that shows no tools gives you nothing to
debug. Run the server by hand instead and check it starts and stays quiet on stdout:

```bash
node dist/index.js
```

It is a stdio server and has no `--help` flag, so it will simply wait for
JSON-RPC frames — press `Ctrl+C` to stop it. Anything printed on stdout by other
means is a bug: stdout carries the protocol, logs go to stderr.
