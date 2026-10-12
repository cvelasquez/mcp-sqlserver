// ¿El driver instalado puede correr en este Node?
//
// tedious 20 usa Promise.withResolvers, que llega con Node 22. En un Node
// anterior todo carga bien y recién falla al hablar con un servidor, con
// "Promise.withResolvers is not a function" — un mensaje que no le dice a
// nadie qué hacer.
//
// Se mira lo que declara el driver y no un número fijo nuestro: quien instala
// por npm en Node 18 o 20 recibe tedious 19, que ahí funciona, y no hay por
// qué cortarlo. El caso real es el bundle .mcpb, que lleva tedious 20, o una
// instalación hecha con un Node y ejecutada con otro.

import { createRequire } from "node:module";

/** Nombre, versión y Node que pide el driver instalado; null si no se puede leer. */
export function installedDriver() {
  try {
    // tedious es dependencia de mssql, no nuestra: se resuelve desde ahí.
    const fromMssql = createRequire(createRequire(import.meta.url).resolve("mssql"));
    const pkg = fromMssql("tedious/package.json");
    return { name: pkg.name, version: pkg.version, node: pkg.engines?.node ?? null };
  } catch {
    return null;
  }
}

const parts = (version) => String(version).split(".").map((n) => Number.parseInt(n, 10) || 0);

/** El piso de un rango ">=X", ">=X.Y" o ">=X.Y.Z"; null si es otra cosa. */
function floorOf(range) {
  const match = /^\s*>=\s*(\d+(?:\.\d+){0,2})\s*$/.exec(range ?? "");
  return match ? parts(match[1]) : null;
}

/** El motivo si el driver no puede correr en este Node, o null si puede. */
export function unsupportedNode(nodeVersion = process.versions.node, driver = installedDriver()) {
  const floor = floorOf(driver?.node);
  // Sin un piso que sepamos leer no se adivina: que decida el driver.
  if (!floor) return null;

  const current = parts(nodeVersion);
  for (let i = 0; i < 3; i++) {
    const wanted = floor[i] ?? 0;
    const have = current[i] ?? 0;
    if (have > wanted) return null;
    if (have < wanted) {
      return (
        `The SQL Server driver installed with this server (${driver.name} ${driver.version}) needs ` +
        `Node.js ${driver.node}, and it is running on Node.js ${nodeVersion}. ` +
        "Run it with a newer Node.js and restart your MCP client."
      );
    }
  }
  return null;
}
