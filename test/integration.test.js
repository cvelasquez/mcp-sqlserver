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

    // Esta suite solo lee, y tiene que poder apuntarse a cualquier conexión,
    // producción incluida. Con la baranda forzada, si alguien agrega acá una
    // sentencia que escribe, se rechaza antes de salir de la máquina.
    const guarded = {
      ...state,
      connections: state.connections.map((c) => (c.name === target ? { ...c, readOnly: true } : c)),
    };

    const pools = createPoolManager({ driver: sql, connections: guarded.connections });
    const callTool = createToolHandler({
      pools,
      getState: () => guarded,
      reload: async () => guarded,
    });

    t.after(() => pools.closeAll());

    await t.test("query", async () => {
      const res = await callTool("query", { connection: target, sql: "SELECT @@VERSION AS v" });
      assert.equal(res.isError, undefined, res.content[0].text);
      const body = JSON.parse(res.content[0].text);
      // Azure SQL se presenta como "Microsoft SQL Azure".
      assert.match(body.data[0].v, /SQL (Server|Azure)/);
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

    // Lo que sigue depende del modo streaming del driver real: el doble de
    // los tests unitarios imita sus eventos, pero solo acá se ve si coinciden.
    const MANY_ROWS = "SELECT TOP 5000 a.object_id FROM sys.all_columns a CROSS JOIN sys.all_columns b";

    await t.test("el tope corta la consulta y la conexión queda usable", async () => {
      const res = await callTool("query", { connection: target, sql: MANY_ROWS, maxRows: 10 });
      assert.equal(res.isError, undefined, res.content[0].text);
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.data.length, 10);
      assert.equal(body.truncated, true);

      // La cancelación no puede dejar la conexión del pool en mal estado.
      const after = await callTool("query", { connection: target, sql: "SELECT 1 AS one" });
      assert.deepEqual(JSON.parse(after.content[0].text).data, [{ one: 1 }]);
    });

    await t.test("una consulta que entra entera no se marca truncada", async () => {
      const res = await callTool("query", { connection: target, sql: "SELECT TOP 10 object_id FROM sys.all_columns", maxRows: 10 });
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.rowCount, 10);
      assert.equal(body.truncated, undefined);
    });

    await t.test("PRINT y varios SELECT llegan completos", async () => {
      const res = await callTool("query", {
        connection: target,
        sql: "PRINT 'hola desde el servidor'; SELECT 1 AS a; SELECT 2 AS b;",
      });
      assert.equal(res.isError, undefined, res.content[0].text);
      const body = JSON.parse(res.content[0].text);
      assert.deepEqual(body.messages, ["hola desde el servidor"]);
      assert.deepEqual(body.recordsets, [[{ a: 1 }], [{ b: 2 }]]);
    });

    await t.test("varbinary en hexadecimal y formato csv", async () => {
      const res = await callTool("query", {
        connection: target,
        sql: "SELECT 0xCAFE AS bin, CAST(NULL AS varchar(5)) AS nada, '' AS vacio, 'a,b' AS texto",
        format: "csv",
      });
      assert.equal(res.isError, undefined, res.content[0].text);
      const [header, , ...csv] = res.content[0].text.split("\n");
      assert.equal(JSON.parse(header).format, "csv");
      assert.deepEqual(csv, ["bin,nada,vacio,texto", '0xcafe,,"","a,b"']);
    });

    await t.test("STATISTICS IO llega como mensajes", async () => {
      const res = await callTool("query", {
        connection: target,
        sql: "SET STATISTICS IO ON; SELECT TOP 5 name FROM sys.objects; SET STATISTICS IO OFF;",
      });
      assert.equal(res.isError, undefined, res.content[0].text);
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.data.length, 5);
      // El texto depende del idioma del login ("logical reads" / "lecturas
      // lógicas"); que traiga números alcanza para saber que es la estadística.
      assert.ok(body.messages?.some((m) => /\d/.test(m)), `sin mensajes: ${JSON.stringify(body.messages)}`);
    });

    await t.test("un error de SQL llega con el mensaje del servidor", async () => {
      const res = await callTool("query", { connection: target, sql: "SELECT * FROM dbo.no_existe_seguro" });
      assert.equal(res.isError, true);
      // El nombre del objeto aparece en el mensaje en cualquier idioma.
      assert.match(res.content[0].text, /no_existe_seguro/);
    });

    // WAITFOR y no un DELETE: la baranda lo rechaza igual, y si algún día
    // fallara, lo que llega al servidor no escribe nada.
    await t.test("la baranda de solo lectura está activa en esta suite", async () => {
      const res = await callTool("query", { connection: target, sql: "WAITFOR DELAY '00:00:00'" });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /readOnly/);
    });
  }
);
