import { test } from "node:test";
import assert from "node:assert/strict";

import { runQuery, resolveMaxRows, DEFAULT_MAX_ROWS, MAX_ROWS_LIMIT } from "../src/query.js";
import { createFakeDriver } from "./helpers/fake-mssql.js";

function poolWith(onCall) {
  const driver = createFakeDriver({ onCall });
  return new driver.ConnectionPool({ server: "x" });
}

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

test("runQuery junta filas, filas afectadas y no marca truncado si entra todo", async () => {
  const pool = poolWith(() => ({ recordsets: [rows(3)], rowsAffected: [3] }));

  const result = await runQuery(pool, "SELECT id FROM t", { maxRows: 3 });

  assert.deepEqual(result.recordsets, [rows(3)]);
  assert.deepEqual(result.rowsAffected, [3]);
  assert.equal(result.rowCount, 3);
  assert.equal(result.truncated, false);
  assert.equal(pool.requests[0].canceled, false, "justo en el tope no hay nada que cancelar");
});

test("al pasar el tope corta, cancela en el servidor y avisa", async () => {
  const pool = poolWith(() => ({ recordsets: [rows(50)], rowsAffected: [50] }));

  const result = await runQuery(pool, "SELECT id FROM big", { maxRows: 10 });

  assert.equal(result.recordsets[0].length, 10);
  assert.deepEqual(result.recordsets[0].at(-1), { id: 10 });
  assert.equal(result.rowCount, 10);
  assert.equal(result.truncated, true);
  assert.equal(pool.requests[0].canceled, true);
  // Recortar después de traer todo no sirve: el servidor tiene que dejar de mandar.
  assert.ok(pool.requests[0].emittedRows < 50, `el driver siguió mandando filas (${pool.requests[0].emittedRows})`);
});

test("el ECANCEL que provoca nuestro propio corte no es un error", async () => {
  const pool = poolWith(() => ({ recordsets: [rows(5)] }));
  await assert.doesNotReject(runQuery(pool, "SELECT 1", { maxRows: 2 }));
});

test("el tope es sobre el total, no por recordset", async () => {
  const pool = poolWith(() => ({ recordsets: [rows(4), rows(4)] }));

  const result = await runQuery(pool, "SELECT 1; SELECT 2", { maxRows: 6 });

  assert.equal(result.recordsets[0].length, 4);
  assert.equal(result.recordsets[1].length, 2);
  assert.equal(result.truncated, true);
});

test("devuelve todos los recordsets, incluidos los vacíos", async () => {
  const pool = poolWith(() => ({ recordsets: [[{ a: 1 }], [], [{ b: 2 }]] }));
  const result = await runQuery(pool, "...", { maxRows: 100 });
  assert.deepEqual(result.recordsets, [[{ a: 1 }], [], [{ b: 2 }]]);
});

test("guarda las columnas de cada recordset, aunque no traiga filas", async () => {
  const pool = poolWith(() => ({
    recordsets: [[]],
    columns: { id: { index: 0, name: "id" }, name: { index: 1, name: "name" } },
  }));
  const result = await runQuery(pool, "SELECT id, name FROM t WHERE 1=0", { maxRows: 100 });
  assert.deepEqual(result.columns, [["id", "name"]]);
});

test("recoge los mensajes del servidor (PRINT, STATISTICS IO)", async () => {
  const pool = poolWith(() => ({
    recordsets: [[{ id: 1 }]],
    messages: ["Table 'Orders'. Scan count 1, logical reads 42", "hola"],
  }));
  const result = await runQuery(pool, "SET STATISTICS IO ON; SELECT ...", { maxRows: 100 });
  assert.deepEqual(result.messages, ["Table 'Orders'. Scan count 1, logical reads 42", "hola"]);
});

test("un error de SQL rechaza con el mensaje del servidor", async () => {
  const pool = poolWith(() => {
    throw new Error("Invalid object name 'nope'.");
  });
  await assert.rejects(runQuery(pool, "SELECT * FROM nope", { maxRows: 10 }), /Invalid object name 'nope'/);
});

test("resolveMaxRows: default, enteros, strings numéricos y tope duro", () => {
  assert.equal(resolveMaxRows(undefined), DEFAULT_MAX_ROWS);
  assert.equal(resolveMaxRows(null), DEFAULT_MAX_ROWS);
  assert.equal(resolveMaxRows(25), 25);
  assert.equal(resolveMaxRows("25"), 25, "hay agentes que mandan los números como string");
  assert.equal(resolveMaxRows(MAX_ROWS_LIMIT + 1), MAX_ROWS_LIMIT);
  assert.equal(DEFAULT_MAX_ROWS, 1000);
  assert.equal(MAX_ROWS_LIMIT, 10000);
});

test("resolveMaxRows rechaza lo que no es un entero positivo", () => {
  for (const bad of [0, -1, 1.5, "abc", "", {}, [], true, NaN]) {
    assert.throws(() => resolveMaxRows(bad), /maxRows/, `debería rechazar ${JSON.stringify(bad)}`);
  }
});
