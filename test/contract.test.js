import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_DEFINITIONS } from "../src/tools.js";

// Superficie MCP congelada. Está copiada de un tools/list corrido contra v2.1
// antes del refactor: hay clientes configurados contra estos nombres y estos
// parámetros. Si un cambio rompe este test, o es un bug o es una versión mayor
// con su nota en el CHANGELOG — nunca un descuido.
const FROZEN = [
  {
    name: "get_execution_plan",
    required: ["connection", "sql"],
    properties: ["connection", "sql"],
    description: "Get execution plan for a query",
  },
  {
    name: "get_indexes",
    required: ["connection", "table"],
    properties: ["connection", "table"],
    description: "Get index information for a table",
  },
  {
    name: "get_schema",
    required: ["connection"],
    properties: ["connection", "table"],
    description: "Get database schema information for specific tables",
  },
  {
    name: "get_stored_procedure",
    required: ["connection", "name"],
    properties: ["connection", "name"],
    description: "Get stored procedure definition",
  },
  {
    name: "list_connections",
    required: [],
    properties: [],
    description: "List all available SQL Server connections grouped by connectionGroup",
  },
  {
    name: "query",
    required: ["connection", "sql"],
    properties: ["connection", "sql"],
    description: "Execute a SQL query on the database",
  },
  {
    name: "reload_connections",
    required: [],
    properties: [],
    description:
      "Reload connections from connections.json file without restarting the MCP server. Closes existing connection pools and loads new configuration.",
  },
];

function shape(tool) {
  return {
    name: tool.name,
    required: (tool.inputSchema.required ?? []).slice().sort(),
    properties: Object.keys(tool.inputSchema.properties ?? {}).sort(),
    description: tool.description,
  };
}

test("las herramientas expuestas son exactamente las de siempre", () => {
  const actual = TOOL_DEFINITIONS.map(shape).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(actual, FROZEN);
});

test("toda herramienta declara un inputSchema de objeto", () => {
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(typeof tool.description, "string", tool.name);
  }
});

test("toda propiedad tiene tipo y descripción", () => {
  for (const tool of TOOL_DEFINITIONS) {
    for (const [prop, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      assert.equal(schema.type, "string", `${tool.name}.${prop}`);
      assert.ok(schema.description, `${tool.name}.${prop} sin descripción`);
    }
  }
});

test("todo parámetro requerido está declarado en properties", () => {
  for (const tool of TOOL_DEFINITIONS) {
    for (const req of tool.inputSchema.required ?? []) {
      assert.ok(tool.inputSchema.properties?.[req], `${tool.name} requiere ${req} pero no lo declara`);
    }
  }
});
