#!/usr/bin/env node

// Punto de entrada. Se mantiene en la raíz a propósito: hay clientes MCP
// configurados con "args": ["C:\\mcp-sqlserver\\index.js"] desde v1 y esa ruta
// tiene que seguir funcionando.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import sql from "mssql";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSqlServer } from "./src/server.js";
import { PACKAGE_ROOT, userConfigPath, ENV_PATH_VAR, ENV_INLINE_VAR } from "./src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));

function parseArgs(argv) {
  const opts = { connections: null, init: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--connections" || arg === "-c") opts.connections = argv[++i];
    else if (arg.startsWith("--connections=")) opts.connections = arg.slice("--connections=".length);
    else if (arg === "--init") opts.init = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--version" || arg === "-v") opts.version = true;
  }
  return opts;
}

const HELP = `${pkg.name} ${pkg.version}

One MCP server for every SQL Server instance you administer.

Usage:
  mcp-sqlserver [options]

Options:
  -c, --connections <path>  Path to connections.json
      --init                Create a starter connections.json and exit
  -v, --version             Print version and exit
  -h, --help                Show this help

Connections file, in order of precedence:
  --connections <path>
  $${ENV_PATH_VAR}         path to a connections.json
  $${ENV_INLINE_VAR}    the JSON itself, inline
  ./connections.json                    current directory
  ${userConfigPath()}
  ${join(PACKAGE_ROOT, "connections.json")}

Docs: ${pkg.homepage ?? "https://github.com/cvelasquez/mcp-sqlserver"}
`;

function runInit(targetPath) {
  const target = targetPath ? resolve(targetPath) : userConfigPath();
  if (existsSync(target)) {
    console.error(`connections.json already exists at ${target} — leaving it untouched.`);
    return 0;
  }
  const template = join(PACKAGE_ROOT, "connections.template.json");
  if (!existsSync(template)) {
    console.error(`Could not find the template at ${template}`);
    return 1;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(template, "utf-8"));
  console.error(
    `Created ${target}\n\n` +
      `Edit it with your servers, then point your AI agent at this MCP server:\n\n` +
      `  {"mcpServers":{"sqlserver":{"command":"npx","args":["-y","${pkg.name}"]}}}\n`
  );
  return 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Salen antes de que el transporte MCP tome stdout, así que acá stdout es
  // libre y `mcp-sqlserver --version | cat` funciona.
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.version) { console.log(pkg.version); return 0; }
  if (opts.init) return runInit(opts.connections);

  const { server, pools, getState } = createSqlServer({
    driver: sql,
    version: pkg.version,
    loadOptions: { cliPath: opts.connections },
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const state = getState();
  console.error(`${pkg.name} v${pkg.version} running on stdio`);
  if (state.error && state.connections.length === 0) {
    // Arrancar igual y reportar por la herramienta: si el proceso muere acá,
    // el cliente MCP solo muestra "server disconnected" y nadie sabe por qué.
    console.error(`No connections loaded.\n${state.error}`);
  } else {
    console.error(`Loaded ${state.connections.length} connections from ${state.path ?? state.source}`);
    if (state.error) console.error(`Warnings:\n${state.error}`);
  }

  process.on("unhandledRejection", (reason) => {
    console.error(`Unhandled rejection: ${reason?.stack ?? reason}`);
  });

  const shutdown = async () => {
    await pools.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return 0;
}

main().then(
  (code) => { if (code) process.exit(code); },
  (err) => {
    console.error(`Fatal: ${err?.stack ?? err}`);
    process.exit(1);
  }
);
