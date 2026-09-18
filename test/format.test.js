import { test } from "node:test";
import assert from "node:assert/strict";

import { formatBinary, normalizeRows, toCsv } from "../src/format.js";

test("un varbinary corto sale como hexadecimal", () => {
  assert.equal(formatBinary(Buffer.from([0xde, 0xad, 0xbe, 0xef])), "0xdeadbeef");
  assert.equal(formatBinary(Buffer.alloc(0)), "0x");
});

test("un varbinary largo se recorta y dice cuánto medía", () => {
  const out = formatBinary(Buffer.alloc(5000, 0xab));
  assert.match(out, /^0x(ab){64}\.\.\. \(5000 bytes\)$/);
});

test("normalizeRows reemplaza los Buffer y no toca lo demás", () => {
  const date = new Date("2026-01-02T03:04:05.000Z");
  const input = [{ id: 1, hash: Buffer.from([1, 2]), when: date, note: null, dup: [Buffer.from([255]), "x"] }];
  const out = normalizeRows(input);

  assert.deepEqual(out, [{ id: 1, hash: "0x0102", when: date, note: null, dup: ["0xff", "x"] }]);
  assert.ok(Buffer.isBuffer(input[0].hash), "no muta la fila original");
  // Sin esto JSON.stringify produce {"type":"Buffer","data":[1,2]}.
  assert.ok(!JSON.stringify(out).includes('"Buffer"'));
});

test("toCsv: encabezado, filas y fin de línea simple", () => {
  const csv = toCsv([{ id: 1, name: "Ana" }, { id: 2, name: "Luis" }]);
  assert.equal(csv, "id,name\n1,Ana\n2,Luis");
});

test("toCsv escapa comas, comillas y saltos de línea", () => {
  const csv = toCsv([{ a: 'dijo "hola"', b: "x,y", c: "l1\nl2" }]);
  assert.equal(csv, 'a,b,c\n"dijo ""hola""","x,y","l1\nl2"');
});

test("toCsv distingue NULL de string vacío", () => {
  const csv = toCsv([{ a: null, b: "", c: undefined }]);
  assert.equal(csv, 'a,b,c\n,"",');
});

test("toCsv: fechas en ISO, booleanos y números tal cual", () => {
  const csv = toCsv([{ d: new Date("2026-01-02T03:04:05.000Z"), ok: true, n: 1.5 }]);
  assert.equal(csv, "d,ok,n\n2026-01-02T03:04:05.000Z,true,1.5");
});

test("toCsv sin filas conserva el encabezado si conoce las columnas", () => {
  assert.equal(toCsv([], ["id", "name"]), "id,name");
  assert.equal(toCsv([]), "");
});
