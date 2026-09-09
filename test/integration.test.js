import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConnections } from "../src/config.js";
import { createPoolManager } from "../src/pools.js";
import { createToolHandler } from "../src/tools.js";

// Prueba contra un SQL Server de verdad. Se saltea salvo que se pida a mano:
//
//   MSSQL_TEST_CONNECTION=local npm test
//
// Usa la misma resolución de connections.json que el servidor, así que también
// verifica que la configuración de la máquina sea usable.
const target = process.env.MSSQL_TEST_CONNECTION;

test(
  "recorrido completo contra un SQL Server real",
  { skip: target ? false : "definí MSSQL_TEST_CONNECTION con el nombre de una conexión" },
  async (t) => {
    const sql = (await import("mssql")).default;
    const state = loadConnections({});
    assert.equal(state.error, null, `no se pudo cargar la configuración: ${state.error}`);

    const connection = state.connections.find((c) => c.name === target);
    assert.ok(connection, `no existe la conexión '${target}' en ${state.path}`);

    const pools = createPoolManager({ driver: sql, connections: state.connections });
    const callTool = createToolHandler({
      pools,
      getState: () => state,
      reload: async () => state,
    });

    t.after(() => pools.closeAll());

    await t.test("query", async () => {
      const res = await callTool("query", { connection: target, sql: "SELECT @@VERSION AS v" });
      assert.equal(res.isError, undefined, res.content[0].text);
      const body = JSON.parse(res.content[0].text);
      assert.match(body.data[0].v, /SQL Server/);
      assert.equal(body.metadata.connection, target);
    });

    await t.test("query llega al servidor pedido", async () => {
      const res = await callTool("query", {
        connection: target,
        sql: "SELECT DB_NAME() AS db",
      });
      const body = JSON.parse(res.content[0].text);
      assert.equal(
        body.data[0].db.toLowerCase(),
        String(connection.database).toLowerCase(),
        "la conexión habló con otra base"
      );
    });

    await t.test("get_schema con una tabla de INFORMATION_SCHEMA", async () => {
      const res = await callTool("get_schema", { connection: target, table: "TABLES" });
      assert.equal(res.isError, undefined, res.content[0].text);
      assert.ok(Array.isArray(JSON.parse(res.content[0].text).schema));
    });

    await t.test("get_indexes no falla en una tabla del sistema", async () => {
      const res = await callTool("get_indexes", { connection: target, table: "sysobjects" });
      assert.equal(res.isError, undefined, res.content[0].text);
    });

    await t.test("get_execution_plan devuelve XML y deja la sesión limpia", async () => {
      const res = await callTool("get_execution_plan", { connection: target, sql: "SELECT 1 AS one" });
      assert.equal(res.isError, undefined, res.content[0].text);
      assert.match(JSON.parse(res.content[0].text).executionPlanXml, /ShowPlanXML/);

      // Si SHOWPLAN_XML hubiera quedado prendido, esto devolvería un plan en
      // vez de la fila.
      const after = await callTool("query", { connection: target, sql: "SELECT 1 AS one" });
      assert.deepEqual(JSON.parse(after.content[0].text).data, [{ one: 1 }]);
    });

    await t.test("get_stored_procedure con uno que no existe", async () => {
      const res = await callTool("get_stored_procedure", { connection: target, name: "dbo.no_existe_seguro" });
      assert.equal(JSON.parse(res.content[0].text).definition, "Stored procedure not found");
    });
  }
);
