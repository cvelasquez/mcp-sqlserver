import { test } from "node:test";
import assert from "node:assert/strict";

import { createPoolManager } from "../src/pools.js";
import { createToolHandler } from "../src/tools.js";
import { createFakeDriver } from "./helpers/fake-mssql.js";

const CONNECTIONS = [
  {
    name: "prod",
    connectionGroup: "Client A",
    description: "Producción",
    server: "10.0.0.1",
    database: "ProdDB",
    user: "sa",
    password: "pw",
  },
  {
    name: "readonly-prod",
    connectionGroup: "Client A",
    description: "Réplica de lectura",
    server: "10.0.0.3",
    database: "ProdDB",
    readOnly: true,
  },
];

function harness({ onCall, connections = CONNECTIONS, error = null } = {}) {
  const driver = createFakeDriver({ onCall });
  const pools = createPoolManager({ driver, connections });
  let state = { connections, path: "/tmp/connections.json", source: "current directory", error };
  const callTool = createToolHandler({
    pools,
    getState: () => state,
    // Igual que src/server.js: cerrar los pools es parte de recargar.
    reload: async () => {
      const closed = await pools.closeAll();
      state = { ...state, reloaded: true };
      pools.setConnections(state.connections);
      return { ...state, closedPools: closed.length };
    },
  });
  return { driver, pools, callTool };
}

const parse = (res) => JSON.parse(res.content[0].text);

test("query devuelve datos y metadata de la conexión usada", async () => {
  const { callTool } = harness({
    onCall: () => ({ recordset: [{ id: 1 }], recordsets: [[{ id: 1 }]], rowsAffected: [1] }),
  });

  const res = await callTool("query", { connection: "prod", sql: "SELECT 1" });
  const body = parse(res);

  assert.equal(res.isError, undefined);
  assert.deepEqual(body.data, [{ id: 1 }]);
  assert.equal(body.rowsAffected, 1);
  assert.deepEqual(body.metadata, {
    connection: "prod",
    connectionGroup: "Client A",
    description: "Producción",
    server: "10.0.0.1",
    database: "ProdDB",
  });
});

test("get_schema con tabla usa un parámetro, no interpolación", async () => {
  const { driver, callTool } = harness({
    onCall: () => ({ recordset: [{ COLUMN_NAME: "id" }], recordsets: [], rowsAffected: [0] }),
  });

  const evil = "Users'; DROP TABLE Users--";
  const res = await callTool("get_schema", { connection: "prod", table: evil });
  const call = driver.pools[0].calls[0];

  assert.ok(call.sql.includes("@tableName"), "la consulta tiene que usar @tableName");
  assert.ok(!call.sql.includes("DROP TABLE"), "el valor no puede terminar dentro del SQL");
  assert.equal(call.inputs.tableName, evil);
  assert.deepEqual(parse(res).schema, [{ COLUMN_NAME: "id" }]);
});

test("get_schema sin tabla lista todo y no manda parámetros", async () => {
  const { driver, callTool } = harness();
  await callTool("get_schema", { connection: "prod" });
  const call = driver.pools[0].calls[0];

  assert.ok(!call.sql.includes("@tableName"));
  assert.ok(call.sql.includes("ORDER BY c.TABLE_NAME"));
  assert.deepEqual(call.inputs, {});
});

test("get_indexes usa un parámetro", async () => {
  const { driver, callTool } = harness({
    onCall: () => ({ recordset: [{ IndexName: "PK" }], recordsets: [], rowsAffected: [0] }),
  });

  const res = await callTool("get_indexes", { connection: "prod", table: "Orders'--" });
  const call = driver.pools[0].calls[0];

  assert.ok(call.sql.includes("OBJECT_NAME(i.object_id) = @tableName"));
  assert.equal(call.inputs.tableName, "Orders'--");
  assert.deepEqual(parse(res).indexes, [{ IndexName: "PK" }]);
});

test("get_stored_procedure usa un parámetro y avisa si no existe", async () => {
  const { driver, callTool } = harness({ onCall: () => ({ recordset: [], recordsets: [], rowsAffected: [0] }) });

  const res = await callTool("get_stored_procedure", { connection: "prod", name: "dbo.sp_Thing" });
  const call = driver.pools[0].calls[0];

  assert.ok(call.sql.includes("OBJECT_ID(@procName)"));
  assert.equal(call.inputs.procName, "dbo.sp_Thing");
  assert.equal(parse(res).definition, "Stored procedure not found");
});

test("get_stored_procedure devuelve la definición cuando existe", async () => {
  const { callTool } = harness({
    onCall: () => ({ recordset: [{ Definition: "CREATE PROC ..." }], recordsets: [], rowsAffected: [0] }),
  });
  const body = parse(await callTool("get_stored_procedure", { connection: "prod", name: "x" }));
  assert.equal(body.definition, "CREATE PROC ...");
  assert.equal(body.storedProcedure, "x");
});

// SHOWPLAN_XML es estado de la CONEXIÓN, y pool.request() no fija ninguna:
// mssql toma y devuelve una conexión del pool en cada batch. Sobre el pool
// compartido, una llamada en paralelo puede quedarse con la conexión marcada y
// hacer que la consulta corra sin plan — es decir, que se ejecute de verdad.
// Por eso el plan va sobre un pool propio de una sola conexión, que se cierra.
test("get_execution_plan corre sobre un pool dedicado de una sola conexión", async () => {
  const { driver, callTool } = harness({
    onCall: (call) =>
      call.sql === "SELECT 1"
        ? { recordsets: [[{ "Microsoft SQL Server 2005 XML Showplan": "<ShowPlanXML/>" }]], recordset: [] }
        : undefined,
  });

  const res = await callTool("get_execution_plan", { connection: "prod", sql: "SELECT 1" });

  assert.equal(driver.pools.length, 1, "no debería tocar el pool compartido");
  const planPool = driver.pools[0];
  assert.equal(planPool.config.pool.max, 1, "con más de una conexión el plan puede caer en la equivocada");
  assert.deepEqual(planPool.sql, ["SET SHOWPLAN_XML ON", "SELECT 1"]);
  assert.ok(planPool.closed, "cerrar destruye la conexión y con ella el estado de SHOWPLAN");
  assert.equal(parse(res).executionPlanXml, "<ShowPlanXML/>");
  assert.equal(parse(res).query, "SELECT 1");
});

test("get_execution_plan cierra su pool aunque la consulta falle", async () => {
  const { driver, callTool } = harness({
    onCall: (call) => {
      if (call.sql === "SELECT bad") throw new Error("Invalid column name 'bad'");
      return undefined;
    },
  });

  const res = await callTool("get_execution_plan", { connection: "prod", sql: "SELECT bad" });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Invalid column name/);
  assert.ok(driver.pools[0].closed, "un pool filtrado por consulta fallida deja conexiones abiertas");
});

test("el pool del plan no se reutiliza entre llamadas", async () => {
  const { driver, callTool } = harness();
  await callTool("get_execution_plan", { connection: "prod", sql: "SELECT 1" });
  await callTool("get_execution_plan", { connection: "prod", sql: "SELECT 2" });
  assert.equal(driver.pools.length, 2);
  assert.ok(driver.pools.every((p) => p.closed));
});

test("consultar y pedir el plan a la vez no comparten conexión", async () => {
  const { driver, callTool } = harness();

  await Promise.all([
    callTool("query", { connection: "prod", sql: "SELECT 'largo'" }),
    callTool("get_execution_plan", { connection: "prod", sql: "DELETE FROM Users" }),
  ]);

  const planPool = driver.pools.find((p) => p.sql[0] === "SET SHOWPLAN_XML ON");
  const queryPool = driver.pools.find((p) => p.sql.includes("SELECT 'largo'"));
  assert.ok(planPool && queryPool, "debería haber un pool para cada cosa");
  assert.notEqual(planPool, queryPool, "el DELETE se ejecutaría de verdad si compartieran conexión");
  assert.ok(!queryPool.sql.includes("DELETE FROM Users"));
});

test("get_execution_plan cae al primer campo si la columna tiene otro nombre", async () => {
  const { callTool } = harness({
    onCall: (call) =>
      call.sql === "SELECT 1" ? { recordsets: [[{ SomeOtherName: "<plan/>" }]], recordset: [] } : undefined,
  });
  assert.equal(parse(await callTool("get_execution_plan", { connection: "prod", sql: "SELECT 1" })).executionPlanXml, "<plan/>");
});

test("list_connections agrupa y marca las de solo lectura", async () => {
  const { callTool } = harness();
  const out = (await callTool("list_connections", {})).content[0].text;

  assert.ok(out.startsWith("Available SQL Server Connections:"));
  assert.ok(out.includes("Client A:"));
  assert.ok(out.includes("- prod\n"));
  assert.ok(out.includes("- readonly-prod  [read-only]"));
  assert.ok(out.includes("Server: 10.0.0.1"));
  assert.ok(out.includes("Loaded from: /tmp/connections.json"));
});

test("list_connections explica el problema en vez de devolver una lista vacía", async () => {
  const { callTool } = harness({ connections: [], error: "No connections.json found. Looked in: ..." });
  const out = (await callTool("list_connections", {})).content[0].text;
  assert.match(out, /No connections are loaded/);
  assert.match(out, /Looked in/);
});

test("reload_connections cierra los pools y reporta el resultado", async () => {
  const { driver, callTool } = harness();
  await callTool("query", { connection: "prod", sql: "SELECT 1" });
  assert.equal(driver.pools.length, 1);

  const body = parse(await callTool("reload_connections", {}));

  assert.equal(body.success, true);
  assert.equal(body.message, "Connections reloaded successfully");
  assert.equal(body.closedPools, 1);
  assert.ok(driver.pools[0].closed);
  assert.equal(body.totalConnections, 2);
  assert.deepEqual(body.connectionNames, ["prod", "readonly-prod"]);
});

test("después del reload se abre un pool nuevo", async () => {
  const { driver, callTool } = harness();
  await callTool("query", { connection: "prod", sql: "SELECT 1" });
  await callTool("reload_connections", {});
  await callTool("query", { connection: "prod", sql: "SELECT 2" });
  assert.equal(driver.pools.length, 2, "el pool cerrado no se puede reutilizar");
});

test("falta el parámetro connection", async () => {
  const { callTool } = harness();
  const res = await callTool("query", { sql: "SELECT 1" });
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, "Error: Connection parameter is required");
});

test("conexión inexistente", async () => {
  const { callTool } = harness();
  const res = await callTool("query", { connection: "fantasma", sql: "SELECT 1" });
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, "Error: Connection 'fantasma' not found");
});

test("herramienta desconocida", async () => {
  const { callTool } = harness();
  const res = await callTool("no_existe", { connection: "prod" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Unknown tool: no_existe/);
});

test("un error del driver vuelve como isError y no como excepción", async () => {
  const { callTool } = harness({
    onCall: () => {
      throw new Error("Login failed for user 'sa'");
    },
  });
  const res = await callTool("query", { connection: "prod", sql: "SELECT 1" });
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, "Error: Login failed for user 'sa'");
});

test("las consultas van al pool de la conexión pedida, no a otro", async () => {
  const { driver, callTool } = harness();

  await callTool("query", { connection: "prod", sql: "SELECT 'a'" });
  await callTool("query", { connection: "readonly-prod", sql: "SELECT 'b'" });

  const byServer = Object.fromEntries(driver.pools.map((p) => [p.config.server, p.sql]));
  assert.deepEqual(byServer["10.0.0.1"], ["SELECT 'a'"]);
  assert.deepEqual(byServer["10.0.0.3"], ["SELECT 'b'"]);
});

// El SDK no valida los argumentos contra el inputSchema: llegan como los mandó
// el cliente. Con un objeto en `sql`, String(...) da "[object Object]" y la
// baranda de readOnly lo deja pasar; después mssql lo interpreta como tagged
// template y ejecuta strings[0]. O sea: un DELETE en una conexión de solo
// lectura.
test("un sql que no es string se rechaza antes de llegar al driver", async () => {
  const { driver, callTool } = harness();

  const res = await callTool("query", {
    connection: "readonly-prod",
    sql: { 0: "DELETE FROM Users" },
  });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /must be a string/);
  assert.equal(driver.pools.length, 0, "no debería ni abrir la conexión");
});

test("table y name tampoco aceptan cualquier cosa", async () => {
  const { callTool } = harness();
  for (const [tool, args] of [
    ["get_indexes", { connection: "prod", table: { 0: "Users" } }],
    ["get_stored_procedure", { connection: "prod", name: ["x"] }],
    ["get_execution_plan", { connection: "prod", sql: 42 }],
  ]) {
    const res = await callTool(tool, args);
    assert.equal(res.isError, true, tool);
    assert.match(res.content[0].text, /must be a string/, tool);
  }
});

test("un error del pool no tumba el proceso", async () => {
  const { driver, callTool } = harness();
  await callTool("query", { connection: "prod", sql: "SELECT 1" });

  // Sin un listener de 'error', esto lanza y mata el servidor entero: el
  // cliente MCP pierde todas las conexiones porque se cayó una.
  assert.doesNotThrow(() => driver.pools[0].emitConnectionError("Connection lost"));
});
