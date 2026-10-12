// Publica el bundle .mcpb en Smithery con las herramientas declaradas.
//
// Smithery no examina servidores locales: la ficha muestra las herramientas
// que vienen en la publicación, y su CLI las copia de `tools` en manifest.json.
// Ahí no las podemos poner, porque el empaquetador de mcpb solo acepta
// {name, description} y Smithery exige inputSchema. Sin eso la ficha dice
// "No capabilities found".
//
// Esto manda lo mismo que el CLI, con las herramientas tal como las define
// src/tools.js. De paso no tiene su timeout fijo de 60 s, que un bundle de
// este tamaño no cumple con una subida lenta. El límite acá es el de fetch:
// 5 minutos hasta recibir respuesta.
//
// Publica lo que hay en este checkout: el manifiesto y las herramientas salen
// del repo, así que el bundle tiene que ser el recién armado.
//
//   npm run build:mcpb
//   SMITHERY_API_KEY=... node .github/scripts/publish-smithery.mjs
//   node .github/scripts/publish-smithery.mjs --dry-run     # muestra qué mandaría

import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { TOOL_DEFINITIONS } from "../../src/tools.js";

const QUALIFIED_NAME = "cvelasquez/mcp-sqlserver";
const API = "https://api.smithery.ai";
const MAX_BUNDLE_BYTES = 25 * 1024 * 1024; // límite de Smithery
const RELEASE_TIMEOUT_MS = 10 * 60 * 1000;
const FAILED = ["FAILURE", "FAILURE_SCAN", "INTERNAL_ERROR", "CANCELLED"];

// Lo que acepta Smithery en cada herramienta. Su esquema rechaza cualquier
// otra clave, y es mejor enterarse acá que por un 400 después de subir 18 MB.
const TOOL_KEYS = new Set([
  "name", "title", "icons", "description", "inputSchema", "outputSchema", "annotations", "execution", "_meta",
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** `user_config` de mcpb a JSON Schema, igual que lo hace el CLI de Smithery. */
function toConfigSchema(userConfig = {}) {
  const properties = {};
  const required = [];
  for (const [key, field] of Object.entries(userConfig)) {
    const type = field.type === "file" || field.type === "directory" ? "string" : field.type;
    const described = {
      ...(field.title ? { title: field.title } : {}),
      ...(field.description ? { description: field.description } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
    };
    properties[key] = field.multiple ? { type: "array", items: { type }, ...described } : { type, ...described };
    if (field.required) required.push(key);
  }
  if (Object.keys(properties).length === 0) return undefined;
  return { type: "object", properties, required };
}

function buildPayload(manifest) {
  if (manifest.server?.type !== "node") fail(`manifest.json: se esperaba server.type "node", vino "${manifest.server?.type}"`);

  for (const tool of TOOL_DEFINITIONS) {
    if (!tool.name || !tool.inputSchema) fail(`herramienta sin name o inputSchema: ${JSON.stringify(tool).slice(0, 80)}`);
    const extra = Object.keys(tool).filter((key) => !TOOL_KEYS.has(key));
    if (extra.length > 0) fail(`${tool.name}: Smithery no acepta ${extra.join(", ")}`);
  }

  const configSchema = toConfigSchema(manifest.user_config);
  return {
    type: "stdio",
    runtime: "node",
    serverCard: {
      serverInfo: { name: manifest.name, version: manifest.version },
      tools: TOOL_DEFINITIONS,
    },
    ...(configSchema ? { configSchema } : {}),
  };
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API}/servers/${encodeURIComponent(QUALIFIED_NAME)}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${process.env.SMITHERY_API_KEY}`, ...(options.headers ?? {}) },
    });
  } catch (error) {
    // fetch tapa el motivo detrás de un "fetch failed"; el real viene en cause.
    fail(`No se pudo hablar con Smithery: ${error.cause?.message ?? error.message}`);
  }
  const body = await response.text();
  if (!response.ok) fail(`Smithery respondió ${response.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body);
}

/** Sigue la publicación hasta que termina, mostrando lo que Smithery va registrando. */
async function follow(deploymentId) {
  const deadline = Date.now() + RELEASE_TIMEOUT_MS;
  let shown = 0;
  while (Date.now() < deadline) {
    const release = await api(`/releases/${deploymentId}`);
    for (const log of (release.logs ?? []).slice(shown)) console.log(`  [${log.stage}] ${log.message}`);
    shown = release.logs?.length ?? shown;

    if (release.status === "SUCCESS") return release;
    if (FAILED.includes(release.status)) fail(`la publicación terminó en ${release.status}`);
    await wait(2000);
  }
  fail(`sin resultado después de ${RELEASE_TIMEOUT_MS / 60000} minutos: https://smithery.ai/servers/${QUALIFIED_NAME}/releases`);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const bundlePath = args.find((arg) => !arg.startsWith("--")) ?? "dist/mcp-sqlserver.mcpb";

if (!existsSync(bundlePath)) fail(`No existe ${bundlePath}. Corré: npm run build:mcpb`);
const bundle = readFileSync(bundlePath);
if (bundle.length > MAX_BUNDLE_BYTES) fail(`${bundlePath} pesa ${(bundle.length / 1048576).toFixed(1)} MB y Smithery acepta hasta 25`);

const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf-8"));
const payload = buildPayload(manifest);

console.log(`${QUALIFIED_NAME} ${manifest.version}`);
console.log(`  bundle: ${bundlePath} (${(bundle.length / 1048576).toFixed(1)} MB)`);
console.log(`  herramientas: ${payload.serverCard.tools.map((tool) => tool.name).join(", ")}`);
console.log(`  configuración: ${Object.keys(payload.configSchema?.properties ?? {}).join(", ") || "ninguna"}`);

if (dryRun) {
  console.log("\n--dry-run: no se mandó nada. Esto es lo que iría:\n");
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

if (!process.env.SMITHERY_API_KEY) fail("\nFalta SMITHERY_API_KEY en el entorno.");

const form = new FormData();
form.set("payload", JSON.stringify(payload));
form.set("bundle", new Blob([bundle]), basename(bundlePath));

console.log("\nsubiendo...");
const accepted = await api("/releases", { method: "PUT", body: form });
console.log(`  aceptada: ${accepted.deploymentId}`);

if (accepted.status !== "SUCCESS") await follow(accepted.deploymentId);

console.log(`\npublicado: https://smithery.ai/servers/${QUALIFIED_NAME}`);
