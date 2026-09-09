# Publishing checklist

**Order matters.** npm first: every registry and directory below verifies the
package exists before it will accept the listing. Steps 3 to 7 can then be done
in any order.

Everything here is a release step. The commands that need an interactive login
are marked; the rest run unattended.

## 0. Before anything

```bash
npm test
node .github/scripts/smoke.mjs
npm pack --dry-run
```

The version must match in three files or the registry rejects the publish. CI
checks this, and so does the `registry` job:

- `package.json` → `version`
- `server.json` → `version` **and** `packages[0].version`
- `manifest.json` → `version`

## 1. npm

Needs an interactive login the first time on a machine.

```bash
npm login                     # interactive
npm publish --access public   # runs the test suite first via prepublishOnly
```

Verify: <https://www.npmjs.com/package/@cvelasquez/mcp-sqlserver>

Then confirm the install path a new user takes:

```bash
cd $(mktemp -d) && npx -y @cvelasquez/mcp-sqlserver --help
```

## 2. Official MCP registry

The registry only stores metadata; the package must be on npm first. It
verifies ownership through the `mcpName` field in `package.json`, which has to
equal `name` in `server.json`.

Install the CLI:

```powershell
# Windows
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile mcp-publisher.tar.gz
tar xf mcp-publisher.tar.gz mcp-publisher.exe
```

```bash
mcp-publisher validate            # no login needed
mcp-publisher login github        # interactive: device code at github.com/login/device
mcp-publisher publish
```

Verify:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.cvelasquez/mcp-sqlserver"
```

## 3. Glama

`glama.json` in the repository root names the maintainer. Glama crawls GitHub
on its own; to force it, submit the repository URL through **Add Server** at
<https://glama.ai/mcp/servers> and claim ownership with GitHub OAuth. Checks
are automated and usually pass within minutes.

## 4. Smithery

Smithery distributes stdio servers as MCPB bundles.

```bash
npm run build:mcpb            # writes dist/mcp-sqlserver.mcpb
npx @smithery/cli mcp publish ./dist/mcp-sqlserver.mcpb -n cvelasquez/mcp-sqlserver
```

Attach the same `.mcpb` to the GitHub release — that is what the README's
one-click install section links to, and it is what Claude Desktop users drag
into their extensions panel.

## 5. punkpeye/awesome-mcp-servers

A pull request against the `🗄️ Databases` section, alphabetical. 94k stars, so
this is the single highest-traffic listing on the list below.

You already have a fork at `cvelasquez/awesome-mcp-servers`, but it is **8035
commits behind** upstream and 1 commit ahead — check what that commit is before
syncing, then:

```bash
gh repo sync cvelasquez/awesome-mcp-servers --source punkpeye/awesome-mcp-servers
```

Do this **after** the npm package is live. A reviewer's first move is to try the
install command, and a 404 gets the PR closed.

The required line format:

```markdown
- [cvelasquez/mcp-sqlserver](https://github.com/cvelasquez/mcp-sqlserver) [![Github Repo stars](https://img.shields.io/github/stars/cvelasquez/mcp-sqlserver?style=flat)](https://github.com/cvelasquez/mcp-sqlserver) 📇 🏠 - SQL Server MCP for DBAs and consultants: dozens of instances grouped by client in one config, execution plans, index audits and stored-procedure analysis.
```

`📇` is TypeScript/JavaScript, `🏠` is a local service. Adding `🤖🤖🤖` to the
end of the PR title opts into their streamlined review lane for automated
contributions.

## 6. mcpservers.org

Web form at <https://mcpservers.org/submit>. This one also feeds
`wong2/awesome-mcp-servers`, which no longer accepts pull requests.

- **Name**: SQL Server MCP
- **Category**: Database
- **Repository**: `https://github.com/cvelasquez/mcp-sqlserver`
- **Description**: One MCP entry for every SQL Server you administer — connections grouped by client, hot-reloaded, with execution plans, index audits and stored-procedure analysis. Built for DBAs and consultants managing dozens of instances rather than a single database.

## 7. mcp.so

Web form at <https://mcp.so/submit?type=server>, same copy as above. The site
blocks automated requests, so it has to be done in a browser.

## Not currently accepting submissions

**PulseMCP** — as of September 2026 their submit page states they are not
accepting new servers or changes to existing listings, and points publishers at
the official MCP registry instead. They also ingest from that registry, so
step 2 is the way in. Re-check <https://www.pulsemcp.com/submit> later.
