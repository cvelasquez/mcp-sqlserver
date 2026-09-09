# SQL Server MCP for people who manage dozens of instances

[![npm](https://img.shields.io/npm/v/@cvelasquez/mcp-sqlserver.svg)](https://www.npmjs.com/package/@cvelasquez/mcp-sqlserver)
[![CI](https://github.com/cvelasquez/mcp-sqlserver/actions/workflows/ci.yml/badge.svg)](https://github.com/cvelasquez/mcp-sqlserver/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io/)

One MCP entry, every SQL Server you administer. Connections live in a single
`connections.json`, grouped by client or environment, hot-reloaded without
restarting your AI agent — plus execution plans, index audits and
stored-procedure analysis.

Built for DBAs and consultants, not for a demo against a single localhost
database.

## Install

Add this to your AI agent's MCP configuration:

```json
{
  "mcpServers": {
    "sqlserver": {
      "command": "npx",
      "args": ["-y", "@cvelasquez/mcp-sqlserver"]
    }
  }
}
```

Then create your connections file and restart the agent:

```bash
npx -y @cvelasquez/mcp-sqlserver --init
```

That writes `~/.mcp-sqlserver/connections.json` from a commented template. Edit
it, and ask your agent to *"list all SQL Server connections"*.

<details>
<summary>Where each agent keeps its MCP config</summary>

| Agent | Config file |
|---|---|
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Code | `claude mcp add sqlserver -- npx -y @cvelasquez/mcp-sqlserver` |
| VS Code / Copilot | `.vscode/mcp.json` |
| Cursor | `~/.cursor/mcp.json` |

Any MCP-compatible agent works — ChatGPT, Gemini, Copilot, Cline, Zed and
others all take the same `command` / `args` pair.
</details>

## Why this one

Most SQL Server MCP servers take a single connection string. That is fine for
one database. It falls apart when you administer thirty across eight clients,
because every instance needs its own entry in the agent config, its own
credentials, and its own restart when something changes.

| | Single-DSN servers | This one |
|---|---|---|
| Instances per MCP entry | 1 | all of them |
| Organised by client or environment | — | `connectionGroup` |
| Add or change a connection | edit agent config, restart | edit a file, `reload_connections` |
| Which server answered? | you assume | in every response's `metadata` |
| Beyond `SELECT` | — | execution plans, index layout, SP source |
| Read-only safety rail | — | `"readOnly": true` per connection |

## Connections

```json
{
  "connections": [
    {
      "name": "acme-prod",
      "connectionGroup": "Acme Corp",
      "description": "Production - head office",
      "server": "192.168.1.10\\SQLEXPRESS",
      "database": "AcmeDB_Prod",
      "user": "app_reader",
      "password": "${env:ACME_PROD_PASSWORD}",
      "port": 1433,
      "encrypt": true,
      "trustServerCertificate": false,
      "readOnly": true
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Unique; this is what you say to the agent |
| `server` | yes | Hostname, IP, or `host\instance` |
| `connectionGroup` | no | Client, project or environment. Groups the listing |
| `description` | no | Shown in `list_connections` and in every response |
| `database` | no | Defaults to the login's default database |
| `user`, `password` | no | Omit for domain or Entra ID auth |
| `port` | no | Defaults to 1433 |
| `encrypt`, `trustServerCertificate` | no | `encrypt` defaults to true |
| `readOnly` | no | Rejects writing statements — see below |

Anything else you put here is passed straight to [`mssql`](https://www.npmjs.com/package/mssql),
so `requestTimeout`, `connectionTimeout`, `pool`, `authentication` and a nested
`options` object all work.

### Keeping passwords out of the file

Any string may reference an environment variable:

```json
"password": "${env:ACME_PROD_PASSWORD}"
```

A connection that references a variable you have not set is **disabled**, and
`list_connections` names both the connection and the missing variable. Leaving
the literal in place would only move the failure to connect time, where it
arrives as `Login failed for user` and tells you nothing.

You can also skip the file entirely and pass the whole thing through the agent
config, which keeps credentials in one place with the rest of your MCP secrets:

```json
{
  "mcpServers": {
    "sqlserver": {
      "command": "npx",
      "args": ["-y", "@cvelasquez/mcp-sqlserver"],
      "env": {
        "MSSQL_MCP_CONNECTIONS_JSON": "{\"connections\":[{\"name\":\"prod\",\"server\":\"10.0.0.1\",\"database\":\"App\",\"user\":\"reader\",\"password\":\"...\"}]}"
      }
    }
  }
}
```

### Where the file is looked for

In order, first hit wins:

1. `--connections <path>`
2. `$MSSQL_MCP_CONNECTIONS` — a path
3. `$MSSQL_MCP_CONNECTIONS_JSON` — the JSON itself, inline
4. `./connections.json` in the working directory
5. `~/.mcp-sqlserver/connections.json`
6. `connections.json` next to the installed package

A path given explicitly via 1 or 2 that does not exist is an error — the server
will not quietly fall back to a different file and talk to the wrong database.

### Windows domain and Entra ID authentication

The bundled `tedious` driver supports NTLM and the Entra ID (Azure AD) family.
Add `domain` for NTLM:

```json
{
  "name": "warehouse",
  "server": "dwh.corp.local",
  "database": "DWH",
  "domain": "CORP",
  "user": "svc_analytics",
  "password": "${env:DWH_PASSWORD}"
}
```

```json
{
  "name": "azure-sql",
  "server": "myserver.database.windows.net",
  "database": "reporting",
  "encrypt": true,
  "authentication": {
    "type": "azure-active-directory-password",
    "options": { "userName": "${env:AZURE_USER}", "password": "${env:AZURE_PASSWORD}" }
  }
}
```

Fully integrated auth — a trusted connection with no password at all — needs
the native `msnodesqlv8` driver, which is not bundled because it would break
the one-line install on machines without a build toolchain. NTLM with an
explicit service account is the supported path.

## Tools

| Tool | Arguments | What it does |
|---|---|---|
| `list_connections` | — | Every connection, grouped |
| `reload_connections` | — | Re-read the file, drop open pools |
| `query` | `connection`, `sql` | Run a query |
| `get_schema` | `connection`, `table?` | Columns, types, nullability, defaults |
| `get_indexes` | `connection`, `table` | Indexes, types, key and included columns |
| `get_execution_plan` | `connection`, `sql` | `SHOWPLAN_XML` — the plan, without running the query |
| `get_stored_procedure` | `connection`, `name` | Source of a stored procedure |

Every response carries the connection it came from:

```json
{
  "metadata": {
    "connection": "acme-prod",
    "connectionGroup": "Acme Corp",
    "description": "Production - head office",
    "server": "192.168.1.10\\SQLEXPRESS",
    "database": "AcmeDB_Prod"
  },
  "data": [ ... ]
}
```

With thirty connections in play, that line is what tells you the answer came
from the client you meant.

### What this gets you

Things that are tedious by hand and become one sentence to the agent:

- *"Why is this stored procedure slow?"* — `get_stored_procedure` for the
  source, `get_execution_plan` for the plan, `get_indexes` for what is missing.
- *"Compare the Orders schema between acme-prod and acme-qa"* — `get_schema` on
  both, agent diffs them.
- *"Which indexes on this table are never covering anything?"* — `get_indexes`
  plus the queries you care about.
- *"I added a client to connections.json"* — `reload_connections`, no restart.

## Read-only connections

```json
"readOnly": true
```

Rejects `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `DROP`, `TRUNCATE`, `ALTER`,
`CREATE`, `GRANT`, `EXEC`, `BACKUP`, `DBCC`, `OPENQUERY`, `DISABLE`/`ENABLE`
and friends before the query leaves your machine. It also requires the batch to
*start* with something that reads — `SELECT`, `WITH`, `DECLARE`, `SET`, `IF`
and so on — because T-SQL lets you call a procedure without `EXEC`, and
`sp_rename 'dbo.Users','Users_old'` contains no blocked keyword at all.

String literals, comments and bracketed identifiers are ignored, so
`WHERE note = 'please delete this'`, `SELECT [delete] FROM [Audit]` and
`DECLARE @Create DATETIME` all pass. `get_execution_plan` still works, because
`SHOWPLAN_XML` returns the plan without executing anything.

Anything other than an explicit `false` turns the guard **on** — a hand-written
`"readOnly": "false"` locks the connection down rather than silently opening
it, and says so in `list_connections`.

**This is a guard rail, not a security boundary.** It stops an agent from
"helpfully" fixing a row in production. It will not stop someone determined to
write. The real protection is a SQL login that only has `db_datareader`:

```sql
CREATE LOGIN mcp_reader WITH PASSWORD = '...';
CREATE USER mcp_reader FOR LOGIN mcp_reader;
ALTER ROLE db_datareader ADD MEMBER mcp_reader;
GRANT VIEW DEFINITION TO mcp_reader;   -- for get_stored_procedure
GRANT SHOWPLAN TO mcp_reader;          -- for get_execution_plan
```

Use both.

## Security notes

- `connections.json` holds credentials. Keep it out of version control — the
  bundled `.gitignore` covers `connections*.json`.
- Prefer `${env:VAR}` over literal passwords.
- Give each connection the least privilege it needs. Do not use `sa`.
- Restrict file permissions:
  `icacls connections.json /inheritance:r /grant:r "%USERNAME%:F"` on Windows,
  `chmod 600 connections.json` elsewhere.
- The `query` tool runs whatever SQL the agent writes. That is the point of the
  tool — treat the connection's permissions as the boundary, not the tool.

## Web UI

`web/connections.html` is a standalone page for editing `connections.json`
without hand-writing JSON: drag and drop between groups, duplicate a
connection, autocompleting group selector, and auto-save through the File
System Access API in Chrome and Edge. No build, no dependencies, entirely
optional. See [web/README.md](web/README.md).

## Claude Desktop one-click install

Grab the `.mcpb` bundle from the
[latest release](https://github.com/cvelasquez/mcp-sqlserver/releases/latest)
and drag it onto Claude Desktop's extensions settings. It will ask for the path
to your `connections.json` and wire everything up.

## Upgrading from 2.x

Your existing `connections.json` works unchanged — every new field is optional
and the tools take the same arguments. Two things worth knowing:

- **Multi-connection was broken before 3.0.** The server used the `mssql`
  global connection pool, which ignores the config it is handed once a
  connection is already open. In practice every connection after the first
  silently reused the first one's server and database. If you were relying on
  results from more than one connection in a session, they may not have come
  from where you thought. Fixed in 3.0 with a pool per connection.
- If your agent config points at `node C:\path\to\index.js`, that still works.
  The file resolution order now checks that path last, so nothing moves.

## Development

```bash
npm install
npm test                     # unit tests, no database needed
node .github/scripts/smoke.mjs   # packs, installs and speaks MCP to the tarball
```

Against a real server, name a connection from your own file:

```bash
MSSQL_TEST_CONNECTION=local npm run test:integration
```

The `mssql` driver is injected, so the unit tests mock only that boundary —
everything else is the real code path. `test/contract.test.js` freezes the tool
names and arguments so a refactor cannot change the MCP surface by accident.

## License

MIT — see [LICENSE](LICENSE).

## Author

Christian Velasquez — [@cvelasquez](https://github.com/cvelasquez)

[Issues](https://github.com/cvelasquez/mcp-sqlserver/issues) ·
[Changelog](CHANGELOG.md) ·
[Sponsor](https://github.com/sponsors/cvelasquez)
