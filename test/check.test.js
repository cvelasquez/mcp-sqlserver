import { test } from "node:test";
import assert from "node:assert/strict";

import { checkConnections, renderCheck } from "../src/check.js";
import { createFakeDriver } from "./helpers/fake-mssql.js";

const CONNECTIONS = [
  { name: "ok-1", connectionGroup: "A", server: "10.0.0.1" },
  { name: "broken", connectionGroup: "A", server: "10.0.0.2" },
  { name: "ok-2", connectionGroup: "B", server: "10.0.0.3" },
];

function driverFailing(server, message) {
  return createFakeDriver({
    connectError: (config) => (config.server === server ? new Error(message) : null),
  });
}

test("prueba todas las conexiones y separa las que fallan", async () => {
  const driver = driverFailing("10.0.0.2", "Login failed for user 'x'");

  const results = await checkConnections({ driver, connections: CONNECTIONS });

  assert.deepEqual(
    results.map((r) => [r.name, r.ok]),
    [["ok-1", true], ["broken", false], ["ok-2", true]]
  );
  assert.equal(results[1].error, "Login failed for user 'x'");
  assert.equal(typeof results[0].ms, "number");
});

test("una conexión caída no impide probar las demás, y todo pool se cierra", async () => {
  const driver = driverFailing("10.0.0.1", "ETIMEOUT");

  const results = await checkConnections({ driver, connections: CONNECTIONS });

  assert.equal(results.filter((r) => r.ok).length, 2);
  const opened = driver.pools.filter((p) => p.connected);
  assert.equal(opened.length, 2);
  assert.ok(opened.every((p) => p.closed), "quedó un pool abierto");
});

test("manda una consulta de verdad, no solo abre el socket", async () => {
  const driver = createFakeDriver();
  await checkConnections({ driver, connections: CONNECTIONS.slice(0, 1) });
  assert.match(driver.pools[0].sql[0], /SELECT/i);
});

test("renderCheck lista cada conexión con su estado y un resumen", () => {
  const out = renderCheck([
    { name: "ok-1", connectionGroup: "A", ok: true, ms: 12 },
    { name: "broken", connectionGroup: "A", ok: false, ms: 300, error: "Login failed" },
  ]);
  assert.match(out, /OK\s+ok-1/);
  assert.match(out, /FAIL\s+broken.*Login failed/s);
  assert.match(out, /1 of 2 connections failed/);
});

test("renderCheck con todo bien lo dice", () => {
  const out = renderCheck([{ name: "ok-1", connectionGroup: "A", ok: true, ms: 12 }]);
  assert.match(out, /All 1 connections? OK/);
});
