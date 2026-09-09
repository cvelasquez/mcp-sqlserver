import { test } from "node:test";
import assert from "node:assert/strict";

import { createPoolManager, buildDriverConfig } from "../src/pools.js";
import { createFakeDriver } from "./helpers/fake-mssql.js";

const CONNECTIONS = [
  {
    name: "client-a",
    connectionGroup: "Client A",
    description: "Producción A",
    server: "10.0.0.1",
    database: "ClientA",
    user: "sa",
    password: "pw-a",
    port: 1433,
    encrypt: false,
    trustServerCertificate: true,
  },
  {
    name: "client-b",
    connectionGroup: "Client B",
    description: "Producción B",
    server: "10.0.0.2",
    database: "ClientB",
    user: "reader",
    password: "pw-b",
    port: 1434,
    encrypt: true,
    trustServerCertificate: false,
  },
];

// Este es el bug que motivó el refactor: index.js usaba sql.connect(config),
// que es el pool GLOBAL de mssql. Con una conexión ya abierta, mssql descarta
// el config nuevo (lib/global-connection.js:17) y devuelve el pool viejo, así
// que la segunda conexión terminaba consultando la base de la primera.
test("cada conexión abre su propio pool contra su propio servidor", async () => {
  const driver = createFakeDriver();
  const pools = createPoolManager({ driver, connections: CONNECTIONS });

  const a = await pools.get("client-a");
  const b = await pools.get("client-b");

  assert.notEqual(a, b, "client-b reutilizó el pool de client-a");
  assert.equal(driver.pools.length, 2);
  assert.equal(a.config.server, "10.0.0.1");
  assert.equal(a.config.database, "ClientA");
  assert.equal(b.config.server, "10.0.0.2");
  assert.equal(b.config.database, "ClientB");
  assert.equal(b.config.password, "pw-b");
  assert.ok(a.connected && b.connected);
});

test("nunca se usa el pool global del driver", async () => {
  const driver = createFakeDriver();
  const pools = createPoolManager({ driver, connections: CONNECTIONS });
  // El doble lanza si se llama driver.connect(); si esto no explota, el código
  // sigue construyendo un ConnectionPool por conexión.
  await pools.get("client-a");
  await pools.get("client-b");
});

test("el pool se reutiliza entre llamadas a la misma conexión", async () => {
  const driver = createFakeDriver();
  const pools = createPoolManager({ driver, connections: CONNECTIONS });

  const first = await pools.get("client-a");
  const second = await pools.get("client-a");

  assert.equal(first, second);
  assert.equal(driver.pools.length, 1);
  assert.equal(pools.size, 1);
});

test("una conexión inexistente falla con el nombre pedido", async () => {
  const driver = createFakeDriver();
  const pools = createPoolManager({ driver, connections: CONNECTIONS });
  await assert.rejects(() => pools.get("nope"), /Connection 'nope' not found/);
});

test("closeAll cierra todo y vacía el mapa", async () => {
  const driver = createFakeDriver();
  const pools = createPoolManager({ driver, connections: CONNECTIONS });

  const a = await pools.get("client-a");
  const b = await pools.get("client-b");
  const closed = await pools.closeAll();

  assert.deepEqual(closed.sort(), ["client-a", "client-b"]);
  assert.ok(a.closed && b.closed);
  assert.equal(pools.size, 0);
});

test("closeAll sigue adelante si un pool ya estaba cerrado", async () => {
  const driver = createFakeDriver();
  const pools = createPoolManager({ driver, connections: CONNECTIONS });

  const a = await pools.get("client-a");
  const b = await pools.get("client-b");
  a.closeError = new Error("already closed");

  const closed = await pools.closeAll();

  assert.deepEqual(closed, ["client-b"], "el pool que falló no se reporta como cerrado");
  assert.ok(b.closed, "el segundo pool se cerró igual");
  assert.equal(pools.size, 0);
});

test("setConnections cambia la configuración sin recrear el manager", async () => {
  const driver = createFakeDriver();
  const pools = createPoolManager({ driver, connections: CONNECTIONS });

  pools.setConnections([{ name: "solo", server: "10.0.0.9", database: "Solo" }]);

  await assert.rejects(() => pools.get("client-a"), /not found/);
  const solo = await pools.get("solo");
  assert.equal(solo.config.server, "10.0.0.9");
});

test("buildDriverConfig deja afuera la metadata nuestra y pasa el resto", () => {
  const config = buildDriverConfig({
    name: "x",
    connectionGroup: "G",
    description: "d",
    readOnly: true,
    server: "10.0.0.1",
    database: "DB",
    user: "u",
    password: "p",
    port: 1433,
    encrypt: true,
    trustServerCertificate: false,
    requestTimeout: 60000,
    domain: "CORP",
  });

  for (const meta of ["name", "connectionGroup", "description", "readOnly"]) {
    assert.ok(!(meta in config), `${meta} no debería llegar al driver`);
  }
  assert.equal(config.server, "10.0.0.1");
  assert.equal(config.encrypt, true);
  assert.equal(config.trustServerCertificate, false);
  assert.equal(config.requestTimeout, 60000);
  assert.equal(config.domain, "CORP", "domain habilita NTLM en mssql");
});

test("buildDriverConfig respeta un options anidado y no comparte el objeto", () => {
  const source = { name: "x", server: "s", options: { instanceName: "SQLEXPRESS" } };
  const first = buildDriverConfig(source);
  const second = buildDriverConfig(source);

  assert.equal(first.options.instanceName, "SQLEXPRESS");
  assert.notEqual(first.options, second.options, "mssql muta config.options");
  assert.notEqual(first.options, source.options);
});

test("dos llamadas simultáneas comparten un solo pool", async () => {
  const driver = createFakeDriver();
  const pools = createPoolManager({ driver, connections: CONNECTIONS });

  const [a, b] = await Promise.all([pools.get("client-a"), pools.get("client-a")]);

  assert.equal(a, b);
  assert.equal(driver.pools.length, 1, "el segundo pool quedaría huérfano, con su socket abierto");
});

test("un fallo de conexión no deja la conexión rota para siempre", async () => {
  const driver = createFakeDriver({ connectError: new Error("Failed to connect") });
  const pools = createPoolManager({ driver, connections: CONNECTIONS });

  await assert.rejects(() => pools.get("client-a"), /Failed to connect/);
  assert.equal(pools.size, 0, "un pool que no conectó no puede quedar cacheado");

  driver.connectError = null;
  const pool = await pools.get("client-a");
  assert.ok(pool.connected, "el siguiente intento tiene que poder conectarse");
});

test("closeAll no explota con una conexión que nunca conectó", async () => {
  const driver = createFakeDriver();
  const pools = createPoolManager({ driver, connections: CONNECTIONS });
  await pools.get("client-a");

  driver.connectError = new Error("nope");
  await pools.get("client-b").catch(() => {});

  const closed = await pools.closeAll();
  assert.deepEqual(closed, ["client-a"]);
  assert.equal(pools.size, 0);
});
