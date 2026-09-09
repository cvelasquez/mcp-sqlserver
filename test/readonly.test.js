import { test } from "node:test";
import assert from "node:assert/strict";

import { inspectStatement, stripLiterals } from "../src/readonly.js";
import { createPoolManager } from "../src/pools.js";
import { createToolHandler } from "../src/tools.js";
import { createFakeDriver } from "./helpers/fake-mssql.js";

const ALLOWED = [
  "SELECT * FROM Users",
  "select top 10 * from dbo.Orders order by CreatedAt desc",
  "WITH cte AS (SELECT 1 AS n) SELECT * FROM cte",
  "SELECT COUNT(*) FROM sys.tables",
  "SELECT * FROM Orders WHERE Note = 'please delete this row'",
  "SELECT * FROM Orders WHERE Note = 'don''t update'",
  "SELECT [delete], [update] FROM [Audit]",
  'SELECT "insert" FROM "Log"',
  "-- drop table Users\nSELECT 1",
  "/* update everything */ SELECT 1",
  "/* nested /* drop */ still a comment */ SELECT 1",
  "SELECT * FROM Invoices WHERE Status IN ('created', 'altered')",
];

const BLOCKED = [
  ["DELETE FROM Users", "DELETE"],
  ["delete from Users where id = 1", "DELETE"],
  ["UPDATE Users SET name = 'x'", "UPDATE"],
  ["INSERT INTO Users VALUES (1)", "INSERT"],
  ["DROP TABLE Users", "DROP"],
  ["TRUNCATE TABLE Users", "TRUNCATE"],
  ["ALTER TABLE Users ADD col INT", "ALTER"],
  ["CREATE INDEX ix ON Users(id)", "CREATE"],
  ["MERGE Target USING Source ON 1=1", "MERGE"],
  ["EXEC sp_who2", "EXEC"],
  ["EXECUTE dbo.DoThing", "EXECUTE"],
  ["GRANT SELECT ON Users TO app", "GRANT"],
  ["BACKUP DATABASE Prod TO DISK = 'x'", "BACKUP"],
  ["DBCC FREEPROCCACHE", "DBCC"],
  ["SHUTDOWN", "SHUTDOWN"],
  ["SELECT * INTO Copy FROM Users", "INTO"],
  ["SELECT 1; DELETE FROM Users", "DELETE"],
  ["SELECT 1 /* ok */; drop table Users", "DROP"],
];

test("consultas de lectura pasan", () => {
  for (const sql of ALLOWED) {
    const result = inspectStatement(sql);
    assert.equal(result.allowed, true, `no debería bloquear: ${sql} (${result.keyword})`);
  }
});

test("consultas que escriben se bloquean con el motivo", () => {
  for (const [sql, keyword] of BLOCKED) {
    const result = inspectStatement(sql);
    assert.equal(result.allowed, false, `debería bloquear: ${sql}`);
    assert.equal(result.keyword, keyword, sql);
  }
});

test("stripLiterals blanquea texto, comentarios e identificadores citados", () => {
  assert.ok(!stripLiterals("SELECT 'DELETE'").includes("DELETE"));
  assert.ok(!stripLiterals("-- DELETE\nSELECT 1").includes("DELETE"));
  assert.ok(!stripLiterals("/* DELETE */ SELECT 1").includes("DELETE"));
  assert.ok(!stripLiterals("SELECT [DELETE]").includes("DELETE"));
  assert.ok(stripLiterals("SELECT 1 FROM T").includes("FROM"));
});

test("un literal sin cerrar no deja escapar una palabra clave", () => {
  assert.equal(inspectStatement("SELECT 'abc").allowed, true);
  assert.equal(inspectStatement("SELECT 'abc; DROP TABLE Users").allowed, true);
});

function harness(connections) {
  const driver = createFakeDriver();
  const pools = createPoolManager({ driver, connections });
  const callTool = createToolHandler({
    pools,
    getState: () => ({ connections, path: null, source: null, error: null }),
    reload: async () => ({ connections, path: null, source: null, error: null }),
  });
  return { driver, callTool };
}

const READ_ONLY = { name: "replica", connectionGroup: "G", description: "d", server: "s", database: "DB", readOnly: true };
const WRITABLE = { name: "main", connectionGroup: "G", description: "d", server: "s2", database: "DB" };

test("query bloquea la escritura en una conexión readOnly", async () => {
  const { driver, callTool } = harness([READ_ONLY, WRITABLE]);

  const res = await callTool("query", { connection: "replica", sql: "DELETE FROM Users" });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /marked readOnly/);
  assert.match(res.content[0].text, /DELETE/);
  // Ni siquiera se abre la conexión: si el chequeo corriera después, el error
  // que ve el usuario sería un timeout de red en vez del motivo real.
  assert.equal(driver.pools.length, 0, "no debería ni intentar conectarse");
});

test("query deja pasar la lectura en una conexión readOnly", async () => {
  const { driver, callTool } = harness([READ_ONLY]);
  const res = await callTool("query", { connection: "replica", sql: "SELECT 1" });
  assert.equal(res.isError, undefined);
  assert.deepEqual(driver.pools[0].sql, ["SELECT 1"]);
});

test("sin readOnly no se bloquea nada", async () => {
  const { driver, callTool } = harness([WRITABLE]);
  const res = await callTool("query", { connection: "main", sql: "DELETE FROM Users" });
  assert.equal(res.isError, undefined);
  assert.deepEqual(driver.pools[0].sql, ["DELETE FROM Users"]);
});

// SHOWPLAN_XML devuelve el plan sin ejecutar la consulta, así que pedir el plan
// de un DELETE en una réplica de lectura es legítimo y útil.
test("get_execution_plan funciona en una conexión readOnly", async () => {
  const { callTool } = harness([READ_ONLY]);
  const res = await callTool("get_execution_plan", { connection: "replica", sql: "DELETE FROM Users" });
  assert.equal(res.isError, undefined);
});

// Consultas que un DBA escribe todos los días. Un falso positivo acá hace que
// readOnly sea inusable y la gente lo apague, que es peor que no tenerlo.
// `create_date` es el caso interesante: \bCREATE\b no matchea porque el guion
// bajo es carácter de palabra, pero eso se rompe fácil al tocar el regex.
const CONSULTAS_REALES_DE_DBA = [
  "SELECT name, create_date, modify_date FROM sys.objects WHERE type = 'U'",
  "SELECT name, database_id, create_date FROM sys.databases",
  "SELECT o.name, m.definition FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id",
  "SELECT TOP 20 total_worker_time/execution_count AS avg_cpu FROM sys.dm_exec_query_stats",
  "SELECT * FROM sys.dm_db_missing_index_details",
  "SELECT SCHEMA_NAME(schema_id) AS sch, name FROM sys.tables ORDER BY name",
  "SELECT COUNT(*) AS deleted_rows FROM Audit WHERE action = 1",
  "SELECT updated_at FROM Orders WHERE created_by = 5",
  "SELECT * FROM Users WHERE email LIKE '%@insert.com'",
];

test("no bloquea consultas de diagnóstico habituales", () => {
  for (const sql of CONSULTAS_REALES_DE_DBA) {
    const result = inspectStatement(sql);
    assert.equal(result.allowed, true, `falso positivo (${result.keyword}): ${sql}`);
  }
});
