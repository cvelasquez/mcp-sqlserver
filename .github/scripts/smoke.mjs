// Prueba de humo end-to-end: empaqueta, instala el tarball en un directorio
// aparte y habla MCP contra el binario instalado.
//
// Es lo único que verifica el camino real del usuario nuevo — `npx` desde una
// carpeta cualquiera, sin el repo alrededor. Los tests unitarios no lo cubren
// porque importan los módulos directamente.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const repo = process.cwd();
const work = mkdtempSync(join(tmpdir(), "mcp-sqlserver-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const CONNECTIONS = {
  connections: [
    {
      name: "smoke",
      connectionGroup: "Smoke",
      description: "No se conecta a nada; solo tiene que aparecer en la lista",
      server: "127.0.0.1",
      database: "master",
      user: "sa",
      password: "${env:SMOKE_PASSWORD}",
      readOnly: true,
      // Nadie escucha en ese puerto: con el timeout por defecto de 15 s el
      // caso "no conecta" tardaría eso. De paso prueba el passthrough de
      // opciones de mssql que antes se descartaban.
      connectionTimeout: 2000,
    },
  ],
};

// Windows necesita shell para ejecutar npm.cmd desde Node 18.20; con shell hay
// que citar a mano lo que tenga espacios.
const needsShell = process.platform === "win32";

function run(cmd, args, cwd) {
  const quoted = needsShell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  return execFileSync(cmd, quoted, {
    cwd,
    encoding: "utf-8",
    shell: needsShell,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

const spawned = [];

/** Mata el proceso y espera a que salga: en Windows el cwd sigue bloqueado hasta entonces. */
function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
}

/** Cliente MCP mínimo por stdio. */
function client(command, args, env, cwd) {
  // cwd es el directorio aislado a propósito: uno de los lugares donde el
  // servidor busca connections.json es el directorio actual, y desde el repo
  // encontraría el del desarrollador en vez de probar el caso vacío.
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  spawned.push(child);
  const pending = new Map();
  let buf = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let id = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const messageId = ++id;
      pending.set(messageId, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: messageId, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout on ${method}\n--- stderr ---\n${stderr}`)), 20000);
    });

  return {
    send,
    notify: (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"),
    stop: () => child.kill(),
    get stderr() {
      return stderr;
    },
  };
}

const EXPECTED_TOOLS = [
  "get_execution_plan",
  "get_indexes",
  "get_schema",
  "get_stored_procedure",
  "list_connections",
  "query",
  "reload_connections",
];

try {
  console.log("empaquetando...");
  run(npm, ["pack", "--pack-destination", work], repo);
  const tarball = join(work, readdirSync(work).find((f) => f.endsWith(".tgz")));

  console.log("instalando el tarball en un directorio limpio...");
  run(npm, ["init", "-y"], work);
  run(npm, ["install", "--no-audit", "--no-fund", tarball], work);

  const installed = join(work, "node_modules", "@cvelasquez", "mcp-sqlserver", "index.js");

  // Sin archivo de conexiones y sin variables, el servidor tiene que arrancar
  // igual: si muere acá, el cliente MCP solo muestra "server disconnected".
  console.log("arrancando sin configuración...");
  {
    const mcp = client(process.execPath, [installed], {
      MSSQL_MCP_CONNECTIONS: "",
      MSSQL_MCP_CONNECTIONS_JSON: "",
      HOME: work,
      USERPROFILE: work,
    }, work);
    const init = await mcp.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    });
    mcp.notify("notifications/initialized");
    assert.equal(init.result.serverInfo.name, "mssql-server");

    const listed = await mcp.send("tools/call", { name: "list_connections", arguments: {} });
    const text = listed.result.content[0].text;
    assert.match(text, /No connections are loaded/, "debería explicar por qué no hay conexiones");
    assert.match(text, /--init/, "debería decir cómo crear el archivo");
    await mcp.stop();
    console.log("  ok: arranca y explica qué falta");
  }

  console.log("arrancando con conexiones inline...");
  {
    const mcp = client(process.execPath, [installed], {
      MSSQL_MCP_CONNECTIONS_JSON: JSON.stringify(CONNECTIONS),
      SMOKE_PASSWORD: "from-env",
    }, work);
    await mcp.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    });
    mcp.notify("notifications/initialized");

    const tools = await mcp.send("tools/list", {});
    const names = tools.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, EXPECTED_TOOLS, "la superficie MCP cambió");

    const listed = await mcp.send("tools/call", { name: "list_connections", arguments: {} });
    const text = listed.result.content[0].text;
    assert.match(text, /Smoke:/);
    assert.match(text, /- smoke {2}\[read-only\]/);
    assert.ok(!text.includes("from-env"), "la contraseña no se muestra en la lista");

    // La conexión no existe: lo que importa es que el error venga del intento
    // de conectar y no de la resolución de configuración.
    const failed = await mcp.send("tools/call", {
      name: "query",
      arguments: { connection: "smoke", sql: "SELECT 1" },
    });
    assert.equal(failed.result.isError, true);
    assert.ok(!/not found/.test(failed.result.content[0].text), "la conexión debería existir en la configuración");

    // La baranda de solo lectura tiene que cortar antes de tocar la red.
    const blocked = await mcp.send("tools/call", {
      name: "query",
      arguments: { connection: "smoke", sql: "DROP TABLE Users" },
    });
    assert.equal(blocked.result.isError, true);
    assert.match(blocked.result.content[0].text, /readOnly/);

    await mcp.stop();
    console.log("  ok: 7 herramientas, conexiones cargadas, readOnly activo");
  }

  console.log("\nsmoke test ok");
} finally {
  // En Windows un proceso vivo con cwd dentro del directorio lo mantiene
  // bloqueado, y el EBUSY resultante tapa el error real del test.
  await Promise.all(spawned.map(stopChild));
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (err) {
    console.error(`no se pudo limpiar ${work}: ${err.message}`);
  }
}
