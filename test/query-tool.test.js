import { test } from "node:test";
import assert from "node:assert/strict";

import { createPoolManager } from "../src/pools.js";
import { createToolHandler } from "../src/tools.js";
import { createFakeDriver } from "./helpers/fake-mssql.js";

// La herramienta `query` de punta a punta: lo que recibe el agente.

const CONNECTIONS = [
  { name: "prod", connectionGroup: "Client A", description: "Producción", server: "10.0.0.1", database: "ProdDB" },
];

function harness(onCall) {
  const driver = createFakeDriver({ onCall });
  const pools = createPoolManager({ driver, connections: CONNECTIONS });
  const state = { connections: CONNECTIONS, path: null, source: null, error: null };
  const callTool = createToolHandler({ pools, getState: () => state, reload: async () => state });
  return { driver, callTool };
}

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
const parse = (res) => JSON.parse(res.content[0].text);

test("la respuesta es JSON compacto: la indentación son tokens tirados", async () => {
  const { callTool } = harness(() => ({ recordsets: [rows(2)], rowsAffected: [2] }));
  const res = await callTool("query", { connection: "prod", sql: "SELECT 1" });
  assert.ok(!/\n\s/.test(res.content[0].text), res.content[0].text);
});

test("una consulta chica no lleva campos de más", async () => {
  const { callTool } = harness(() => ({ recordsets: [rows(2)], rowsAffected: [2] }));
  const body = parse(await callTool("query", { connection: "prod", sql: "SELECT 1" }));

  assert.deepEqual(Object.keys(body).sort(), ["data", "metadata", "rowCount", "rowsAffected"]);
  assert.equal(body.rowCount, 2);
});

test("sin maxRows el tope es 1000 y la respuesta explica cómo seguir", async () => {
  const { callTool } = harness(() => ({ recordsets: [rows(1500)] }));
  const body = parse(await callTool("query", { connection: "prod", sql: "SELECT * FROM big" }));

  assert.equal(body.data.length, 1000);
  assert.equal(body.rowCount, 1000);
  assert.equal(body.truncated, true);
  assert.equal(body.maxRows, 1000);
  assert.match(body.note, /maxRows/);
});

test("maxRows se respeta", async () => {
  const { callTool } = harness(() => ({ recordsets: [rows(50)] }));
  const body = parse(await callTool("query", { connection: "prod", sql: "SELECT 1", maxRows: 5 }));
  assert.equal(body.data.length, 5);
  assert.equal(body.truncated, true);
});

// Lo peor que puede pasar con el tope es que el agente crea que vio todo. Una
// respuesta de 10000 filas pesa cientos de KB, y un cliente que recorte salidas
// largas se queda con el principio: el aviso tiene que estar ahí.
test("el aviso de truncado va antes que las filas, no después", async () => {
  const { callTool } = harness(() => ({ recordsets: [rows(50)] }));
  const res = await callTool("query", { connection: "prod", sql: "SELECT 1", maxRows: 5 });
  const raw = res.content[0].text;

  for (const field of ['"truncated"', '"note"', '"rowCount"', '"maxRows"']) {
    assert.ok(raw.indexOf(field) !== -1, `falta ${field}`);
    assert.ok(raw.indexOf(field) < raw.indexOf('"data"'), `${field} quedó después de las filas`);
  }
});

test("la nota dice que hay más filas y que el total no se conoce", async () => {
  const { callTool } = harness(() => ({ recordsets: [rows(50)] }));
  const body = parse(await callTool("query", { connection: "prod", sql: "SELECT 1", maxRows: 5 }));

  assert.match(body.note, /INCOMPLETE/);
  assert.match(body.note, /more rows/i);
  assert.match(body.note, /total is unknown/i);
  assert.match(body.note, /COUNT\(\*\)/);
});

test("si el agente pidió más que el máximo y no entró, la nota lo dice", async () => {
  const { callTool } = harness(() => ({ recordsets: [rows(10050)] }));
  const body = parse(await callTool("query", { connection: "prod", sql: "SELECT * FROM big", maxRows: 50000 }));

  assert.equal(body.data.length, 10000);
  assert.equal(body.truncated, true);
  assert.equal(body.maxRows, 10000);
  assert.match(body.note, /50000/, "tiene que nombrar lo que pidió");
  assert.match(body.note, /10000/);
  assert.match(body.note, /hard limit/i);
  // Ya está en el máximo: sugerirle que suba maxRows lo manda a un callejón.
  assert.doesNotMatch(body.note, /pass a higher maxRows/i);
});

test("por debajo del máximo, la nota ofrece subir maxRows", async () => {
  const { callTool } = harness(() => ({ recordsets: [rows(50)] }));
  const body = parse(await callTool("query", { connection: "prod", sql: "SELECT 1", maxRows: 5 }));
  assert.match(body.note, /pass a higher maxRows/i);
});

test("pedir más que el máximo no avisa nada si el resultado entra entero", async () => {
  const { callTool } = harness(() => ({ recordsets: [rows(7)] }));
  const body = parse(await callTool("query", { connection: "prod", sql: "SELECT 1", maxRows: 50000 }));

  assert.equal(body.rowCount, 7);
  assert.equal(body.truncated, undefined);
  assert.equal(body.note, undefined);
});

test("en csv el aviso de truncado viaja en la cabecera", async () => {
  const { callTool } = harness(() => ({ recordsets: [rows(50)] }));
  const res = await callTool("query", { connection: "prod", sql: "SELECT 1", maxRows: 5, format: "csv" });
  const meta = JSON.parse(res.content[0].text.split("\n")[0]);

  assert.equal(meta.truncated, true);
  assert.match(meta.note, /INCOMPLETE/);
});

test("un maxRows inválido se rechaza sin abrir la conexión", async () => {
  const { driver, callTool } = harness();
  const res = await callTool("query", { connection: "prod", sql: "SELECT 1", maxRows: "muchas" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /maxRows/);
  assert.equal(driver.pools.length, 0);
});

test("los mensajes del servidor llegan en `messages`", async () => {
  const { callTool } = harness(() => ({ recordsets: [rows(1)], messages: ["logical reads 42"] }));
  const body = parse(await callTool("query", { connection: "prod", sql: "SELECT 1" }));
  assert.deepEqual(body.messages, ["logical reads 42"]);
});

test("con varios SELECT, `data` sigue siendo el primero y `recordsets` trae todos", async () => {
  const { callTool } = harness(() => ({ recordsets: [[{ a: 1 }], [{ b: 2 }]] }));
  const body = parse(await callTool("query", { connection: "prod", sql: "SELECT 1; SELECT 2" }));

  assert.deepEqual(body.data, [{ a: 1 }]);
  assert.deepEqual(body.recordsets, [[{ a: 1 }], [{ b: 2 }]]);
});

test("una sentencia sin resultado devuelve data vacío y las filas afectadas", async () => {
  const { callTool } = harness(() => ({ recordsets: [], rowsAffected: [7] }));
  const body = parse(await callTool("query", { connection: "prod", sql: "UPDATE t SET x = 1" }));
  assert.deepEqual(body.data, []);
  assert.equal(body.rowsAffected, 7);
});

test("un varbinary no sale como arreglo de bytes", async () => {
  const { callTool } = harness(() => ({ recordsets: [[{ hash: Buffer.from([0xca, 0xfe]) }]] }));
  const body = parse(await callTool("query", { connection: "prod", sql: "SELECT hash FROM t" }));
  assert.deepEqual(body.data, [{ hash: "0xcafe" }]);
});

test("format csv: una línea de cabecera JSON y después el CSV", async () => {
  const { callTool } = harness(() => ({
    recordsets: [[{ id: 1, name: "Ana" }, { id: 2, name: "Luis, hijo" }]],
    rowsAffected: [2],
  }));
  const res = await callTool("query", { connection: "prod", sql: "SELECT ...", format: "csv" });

  assert.equal(res.isError, undefined);
  const [header, blank, ...csv] = res.content[0].text.split("\n");
  const meta = JSON.parse(header);
  assert.equal(meta.metadata.connection, "prod");
  assert.equal(meta.format, "csv");
  assert.equal(meta.rowCount, 2);
  assert.equal("data" in meta, false);
  assert.equal(blank, "");
  assert.deepEqual(csv, ["id,name", "1,Ana", '2,"Luis, hijo"']);
});

test("format csv con varios recordsets los separa y los numera", async () => {
  const { callTool } = harness(() => ({ recordsets: [[{ a: 1 }], [{ b: 2 }]] }));
  const res = await callTool("query", { connection: "prod", sql: "SELECT 1; SELECT 2", format: "csv" });
  const text = res.content[0].text;
  assert.match(text, /-- recordset 1\na\n1\n\n-- recordset 2\nb\n2$/);
});

test("un format desconocido se rechaza sin abrir la conexión", async () => {
  const { driver, callTool } = harness();
  const res = await callTool("query", { connection: "prod", sql: "SELECT 1", format: "xml" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /format/);
  assert.equal(driver.pools.length, 0);
});

test("las demás herramientas también responden en JSON compacto", async () => {
  const { callTool } = harness(() => ({ recordset: [{ COLUMN_NAME: "id" }] }));
  const res = await callTool("get_schema", { connection: "prod", table: "Users" });
  assert.ok(!/\n\s/.test(res.content[0].text));
});
