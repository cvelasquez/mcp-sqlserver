import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { installedDriver, unsupportedNode } from "../src/runtime.js";

const readJson = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf-8"));

const TEDIOUS_20 = { name: "tedious", version: "20.3.7", node: ">=22" };
const TEDIOUS_19 = { name: "tedious", version: "19.2.2", node: ">=18.17" };

test("un driver que pide un Node más nuevo devuelve el motivo, con las versiones", () => {
  const reason = unsupportedNode("20.19.0", TEDIOUS_20);

  assert.match(reason, /tedious 20\.3\.7/);
  assert.match(reason, /Node\.js >=22/);
  assert.match(reason, /Node\.js 20\.19\.0/);
});

test("un driver que corre en este Node no devuelve nada", () => {
  assert.equal(unsupportedNode("22.0.0", TEDIOUS_20), null);
  assert.equal(unsupportedNode("24.1.0", TEDIOUS_20), null);
  // Lo que instala npm sobre Node 18 y 20: no hay por qué cortarlo.
  assert.equal(unsupportedNode("20.19.0", TEDIOUS_19), null);
  assert.equal(unsupportedNode("18.20.8", TEDIOUS_19), null);
});

test("compara también el número menor", () => {
  assert.equal(unsupportedNode("18.17.0", TEDIOUS_19), null);
  assert.match(unsupportedNode("18.16.1", TEDIOUS_19), /Node\.js >=18\.17/);
});

test("si no se sabe qué pide el driver, no se bloquea", () => {
  assert.equal(unsupportedNode("18.0.0", null), null);
  assert.equal(unsupportedNode("18.0.0", { name: "tedious", version: "1.0.0", node: null }), null);
  // Un rango que no sabemos leer no es motivo para dejar a nadie afuera.
  assert.equal(unsupportedNode("18.0.0", { name: "tedious", version: "1.0.0", node: "^20 || >=22" }), null);
});

test("installedDriver lee el driver que realmente está instalado", () => {
  const driver = installedDriver();

  assert.equal(driver.name, "tedious");
  assert.match(driver.version, /^\d+\.\d+\.\d+/);
  assert.match(driver.node, /^>=\d+/);
});

// La 3.1.0 declaraba >=18 con un driver fijado que ya pedía 22, y nada lo
// notó: los unitarios usan el doble y pasan en cualquier Node.
test("el Node mínimo declarado alcanza para el driver instalado", () => {
  const declared = readJson("package.json").engines.node;
  assert.equal(readJson("manifest.json").compatibility.runtimes.node, declared);

  const floor = /^>=(\d+\.\d+\.\d+)$/.exec(declared)?.[1];
  assert.ok(floor, `engines.node tiene que ser ">=X.Y.Z", vino "${declared}"`);
  assert.equal(unsupportedNode(floor, installedDriver()), null);
});
