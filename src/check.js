// `mcp-sqlserver --check`: probar todas las conexiones de una vez.
//
// Sirve después de rotar contraseñas o de editar el archivo a mano: sin esto,
// una conexión rota se descubre recién cuando el agente la usa.

import { buildDriverConfig } from "./pools.js";

async function checkOne(driver, conn) {
  const started = Date.now();
  const base = { name: conn.name, connectionGroup: conn.connectionGroup ?? "" };

  const config = buildDriverConfig(conn);
  config.pool = { ...(config.pool ?? {}), min: 0, max: 1 };
  const pool = new driver.ConnectionPool(config);
  // Sin listener, un 'error' tardío del pool tumba el proceso entero.
  pool.on("error", () => {});

  try {
    await pool.connect();
    // Abrir el socket no alcanza: un login sin acceso a la base conecta y
    // falla en la primera consulta.
    await pool.request().query("SELECT 1 AS ok");
    return { ...base, ok: true, ms: Date.now() - started };
  } catch (error) {
    return { ...base, ok: false, ms: Date.now() - started, error: error?.message ?? String(error) };
  } finally {
    await pool.close().catch(() => {});
  }
}

/**
 * Prueba todas en paralelo: con treinta conexiones y un timeout de 15 s, en
 * serie serían minutos si hay varias caídas. Devuelve en el orden del archivo.
 */
export function checkConnections({ driver, connections }) {
  return Promise.all(connections.map((conn) => checkOne(driver, conn)));
}

export function renderCheck(results) {
  const width = Math.max(0, ...results.map((r) => r.name.length));
  const lines = results.map((r) => {
    const status = r.ok ? "OK  " : "FAIL";
    const group = r.connectionGroup ? `  [${r.connectionGroup}]` : "";
    const detail = r.ok ? "" : `\n        ${r.error}`;
    return `  ${status}  ${r.name.padEnd(width)}  ${String(r.ms).padStart(6)} ms${group}${detail}`;
  });

  const failed = results.filter((r) => !r.ok).length;
  const summary =
    failed === 0
      ? `All ${results.length} connection${results.length === 1 ? "" : "s"} OK`
      : `${failed} of ${results.length} connections failed`;

  return `${lines.join("\n")}\n\n${summary}`;
}
