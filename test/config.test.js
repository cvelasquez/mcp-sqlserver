import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConnections,
  resolveConnectionsSource,
  expandEnvVars,
  validateConnections,
  candidatePaths,
  userConfigPath,
  ENV_PATH_VAR,
  ENV_INLINE_VAR,
  PACKAGE_ROOT,
} from "../src/config.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "mcp-sqlserver-test-"));
  const dirs = {
    root,
    cwd: join(root, "cwd"),
    home: join(root, "home"),
    packageRoot: join(root, "package"),
  };
  for (const dir of [dirs.cwd, dirs.home, dirs.packageRoot]) mkdirSync(dir, { recursive: true });
  dirs.write = (dir, connections) => {
    const path = join(dir, "connections.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ connections }, null, 2));
    return path;
  };
  dirs.cleanup = () => rmSync(root, { recursive: true, force: true });
  return dirs;
}

const CONN = { name: "a", connectionGroup: "G", description: "d", server: "10.0.0.1", database: "DB" };

test("el JSON inline gana sobre los archivos que se buscan solos", () => {
  const s = sandbox();
  try {
    s.write(s.cwd, [CONN]);
    const result = loadConnections({
      env: { [ENV_INLINE_VAR]: JSON.stringify({ connections: [{ ...CONN, server: "inline" }] }) },
      cwd: s.cwd,
      home: s.home,
      packageRoot: s.packageRoot,
    });
    assert.equal(result.connections[0].server, "inline");
    assert.equal(result.source, `$${ENV_INLINE_VAR}`);
  } finally {
    s.cleanup();
  }
});

test("orden de precedencia: --connections gana sobre la variable de entorno y sobre cwd", () => {
  const s = sandbox();
  try {
    const explicit = join(s.root, "explicit.json");
    writeFileSync(explicit, JSON.stringify({ connections: [{ ...CONN, server: "explicit" }] }));
    const envPath = join(s.root, "from-env.json");
    writeFileSync(envPath, JSON.stringify({ connections: [{ ...CONN, server: "env" }] }));
    s.write(s.cwd, [{ ...CONN, server: "cwd" }]);

    const opts = { cwd: s.cwd, home: s.home, packageRoot: s.packageRoot };

    assert.equal(
      loadConnections({ ...opts, cliPath: explicit, env: { [ENV_PATH_VAR]: envPath } }).connections[0].server,
      "explicit"
    );
    assert.equal(loadConnections({ ...opts, env: { [ENV_PATH_VAR]: envPath } }).connections[0].server, "env");
    assert.equal(loadConnections({ ...opts, env: {} }).connections[0].server, "cwd");
  } finally {
    s.cleanup();
  }
});

test("cae al directorio del usuario y después al del paquete", () => {
  const s = sandbox();
  try {
    const userDir = join(s.home, ".mcp-sqlserver");
    s.write(userDir, [{ ...CONN, server: "user" }]);
    s.write(s.packageRoot, [{ ...CONN, server: "package" }]);
    const opts = { cwd: s.cwd, home: s.home, packageRoot: s.packageRoot, env: {} };

    assert.equal(loadConnections(opts).connections[0].server, "user");

    rmSync(join(userDir, "connections.json"));
    assert.equal(loadConnections(opts).connections[0].server, "package");
  } finally {
    s.cleanup();
  }
});

// Caer en silencio al connections.json de otro lado sería el mismo tipo de bug
// que el del pool global: terminar hablando con la base equivocada.
test("una ruta explícita inexistente falla en vez de usar otro archivo", () => {
  const s = sandbox();
  try {
    s.write(s.cwd, [CONN]);
    const result = loadConnections({
      cliPath: join(s.root, "no-existe.json"),
      cwd: s.cwd,
      home: s.home,
      packageRoot: s.packageRoot,
      env: {},
    });
    assert.equal(result.connections.length, 0);
    assert.match(result.error, /no-existe\.json/);
    assert.match(result.error, /--connections/);
  } finally {
    s.cleanup();
  }
});

test("sin ningún archivo devuelve error accionable y no lanza", () => {
  const s = sandbox();
  try {
    const result = loadConnections({ cwd: s.cwd, home: s.home, packageRoot: s.packageRoot, env: {} });
    assert.equal(result.connections.length, 0);
    assert.match(result.error, /No connections\.json found/);
    assert.match(result.error, /--init/);
    for (const candidate of candidatePaths({ cwd: s.cwd, home: s.home, packageRoot: s.packageRoot, env: {} })) {
      assert.ok(result.error.includes(candidate.path), `debería listar ${candidate.path}`);
    }
  } finally {
    s.cleanup();
  }
});

test("JSON malformado se reporta con la ruta, no revienta el proceso", () => {
  const s = sandbox();
  try {
    const path = join(s.cwd, "connections.json");
    writeFileSync(path, "{ esto no es json");
    const result = loadConnections({ cwd: s.cwd, home: s.home, packageRoot: s.packageRoot, env: {} });
    assert.equal(result.connections.length, 0);
    assert.match(result.error, /Invalid JSON/);
    assert.ok(result.error.includes(path));
  } finally {
    s.cleanup();
  }
});

test("${env:VAR} se expande en cualquier string", () => {
  const expanded = expandEnvVars(
    { password: "${env:PW}", server: "sql-${env:REGION}.corp", port: 1433, tags: ["${env:PW}"] },
    { PW: "s3cret", REGION: "eu" }
  );
  assert.equal(expanded.password, "s3cret");
  assert.equal(expanded.server, "sql-eu.corp");
  assert.equal(expanded.port, 1433);
  assert.deepEqual(expanded.tags, ["s3cret"]);
});

test("una contraseña con $ literal no se toca", () => {
  const missing = [];
  assert.equal(expandEnvVars("P@$$w0rd{}", {}, missing), "P@$$w0rd{}");
  assert.deepEqual(missing, []);
});

test("una variable de entorno sin definir se reporta", () => {
  const s = sandbox();
  try {
    s.write(s.cwd, [{ ...CONN, password: "${env:NO_EXISTE}" }]);
    const result = loadConnections({ cwd: s.cwd, home: s.home, packageRoot: s.packageRoot, env: {} });
    assert.match(result.error, /NO_EXISTE/);
  } finally {
    s.cleanup();
  }
});

test("validateConnections acepta el formato actual sin cambios", () => {
  const legacy = {
    connections: [
      {
        name: "production-main",
        connectionGroup: "Production",
        description: "Main production database",
        server: "192.168.1.10\\SQLEXPRESS",
        database: "ProductionDB",
        user: "sa",
        password: "pw",
        port: 1433,
        encrypt: false,
        trustServerCertificate: true,
      },
    ],
  };
  const { connections, errors } = validateConnections(legacy);
  assert.deepEqual(errors, []);
  assert.equal(connections.length, 1);
  assert.deepEqual(connections[0], legacy.connections[0]);
});

test("validateConnections rechaza nombres duplicados y campos faltantes", () => {
  const { connections, errors } = validateConnections({
    connections: [
      { name: "dup", server: "s" },
      { name: "dup", server: "s" },
      { name: "sin-server" },
      { server: "sin-nombre" },
    ],
  });
  assert.equal(connections.length, 1);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => /Duplicate connection name "dup"/.test(e)));
  assert.ok(errors.some((e) => /"sin-server" is missing "server"/.test(e)));
  assert.ok(errors.some((e) => /index 3 is missing "name"/.test(e)));
});

test("validateConnections rechaza una raíz que no tiene connections", () => {
  assert.match(validateConnections({}).errors[0], /Missing required "connections" array/);
  assert.match(validateConnections([]).errors[0], /Expected a JSON object/);
});

test("userConfigPath vive bajo el home del usuario", () => {
  assert.equal(userConfigPath("/home/x"), join("/home/x", ".mcp-sqlserver", "connections.json"));
});

test("resolveConnectionsSource informa dónde buscó cuando no encuentra nada", () => {
  const s = sandbox();
  try {
    const resolved = resolveConnectionsSource({ cwd: s.cwd, home: s.home, packageRoot: s.packageRoot, env: {} });
    assert.equal(resolved.kind, "none");
    assert.equal(resolved.searched.length, 3);
    assert.deepEqual(
      resolved.searched.map((c) => c.source),
      ["current directory", "user config", "package directory"]
    );
  } finally {
    s.cleanup();
  }
});

// El template es lo que escribe --init: si no carga, la primera experiencia de
// un usuario nuevo es un error. También atajó un bug real, cuando el texto de
// ayuda del propio archivo contenía la sintaxis ${env:...} y se reportaba como
// variable sin definir.
test("el template que se publica es válido y no referencia variables de más", () => {
  const path = join(PACKAGE_ROOT, "connections.template.json");

  // Sin las variables definidas, cada conexión queda deshabilitada con su
  // motivo: es lo que ve alguien que corrió --init y todavía no configuró nada.
  const sinEnv = loadConnections({ cliPath: path, cwd: PACKAGE_ROOT, env: {} });
  assert.equal(sinEnv.connections.length, 0);
  assert.match(sinEnv.error, /is disabled: unset environment variable/);

  const result = loadConnections({
    cliPath: path,
    cwd: PACKAGE_ROOT,
    env: {
      LOCAL_SQL_PASSWORD: "x", ACME_PROD_PASSWORD: "x", ACME_QA_PASSWORD: "x",
      DWH_PASSWORD: "x", AZURE_SQL_USER: "x", AZURE_SQL_PASSWORD: "x",
    },
  });

  assert.equal(result.connections.length, 5);
  assert.equal(result.error, null);
  assert.ok(result.connections.every((c) => c.name && c.server));

  const referenced = [
    ...new Set([...sinEnv.error.matchAll(/unset environment variables? ([A-Z_, ]+)\./g)]
      .flatMap((m) => m[1].split(",").map((v) => v.trim()))),
  ];
  assert.ok(referenced.length > 0, "el template debería mostrar el uso de variables de entorno");
  for (const name of referenced) {
    assert.match(name, /PASSWORD|USER/, `variable inesperada en el template: ${name}`);
  }
});

// La ayuda de --help lista --connections como lo de mayor precedencia. Si el
// JSON inline ganara, un cliente MCP con esa variable en su bloque `env`
// dejaría a --connections sin efecto y hablaría con los servidores
// equivocados, en silencio: exactamente el bug que el refactor viene a evitar.
test("una ruta pedida a mano le gana al JSON inline", () => {
  const s = sandbox();
  try {
    const explicit = join(s.root, "explicit.json");
    writeFileSync(explicit, JSON.stringify({ connections: [{ ...CONN, server: "explicit" }] }));
    const inline = JSON.stringify({ connections: [{ ...CONN, server: "inline" }] });
    const opts = { cwd: s.cwd, home: s.home, packageRoot: s.packageRoot };

    assert.equal(
      loadConnections({ ...opts, cliPath: explicit, env: { [ENV_INLINE_VAR]: inline } }).connections[0].server,
      "explicit"
    );
    assert.equal(
      loadConnections({ ...opts, env: { [ENV_PATH_VAR]: explicit, [ENV_INLINE_VAR]: inline } }).connections[0].server,
      "explicit"
    );
    // Sin ruta explícita, el inline sigue ganando sobre lo que se busca solo.
    assert.equal(loadConnections({ ...opts, env: { [ENV_INLINE_VAR]: inline } }).connections[0].server, "inline");
  } finally {
    s.cleanup();
  }
});

test("una conexión con una variable sin definir se deshabilita, no queda a medias", () => {
  const s = sandbox();
  try {
    s.write(s.cwd, [
      { ...CONN, name: "buena", password: "${env:TIENE}" },
      { ...CONN, name: "incompleta", password: "${env:NO_TIENE}" },
    ]);
    const result = loadConnections({ cwd: s.cwd, home: s.home, packageRoot: s.packageRoot, env: { TIENE: "ok" } });

    assert.deepEqual(result.connections.map((c) => c.name), ["buena"]);
    assert.equal(result.connections[0].password, "ok");
    assert.match(result.error, /Connection "incompleta" is disabled/);
    assert.match(result.error, /NO_TIENE/);
  } finally {
    s.cleanup();
  }
});

test("un puerto que viene de una variable llega como número", () => {
  const s = sandbox();
  try {
    s.write(s.cwd, [{ ...CONN, port: "${env:SQL_PORT}" }]);
    const result = loadConnections({
      cwd: s.cwd, home: s.home, packageRoot: s.packageRoot, env: { SQL_PORT: "1435" },
    });
    // tedious rechaza el config si options.port no es number.
    assert.strictEqual(result.connections[0].port, 1435);
  } finally {
    s.cleanup();
  }
});

test("un readOnly que no es booleano avisa pero deja la conexión cerrada", () => {
  const { connections, errors } = validateConnections({
    connections: [{ name: "a", server: "s", readOnly: "false" }],
  });
  assert.equal(connections.length, 1);
  assert.match(errors[0], /non-boolean "readOnly"/);
  assert.match(errors[0], /treated as read-only/);
});
