// Resolución, carga y validación del archivo connections.json.
//
// El servidor tiene que arrancar aunque no encuentre configuración: si muere en
// el import, el cliente MCP solo muestra "server disconnected" y el usuario no
// tiene forma de saber qué pasó. Por eso acá nada lanza hacia afuera; los
// errores viajan dentro del resultado y las herramientas los reportan.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Raíz del paquete instalado (un nivel arriba de src/). */
export const PACKAGE_ROOT = resolvePath(__dirname, "..");

export const ENV_PATH_VAR = "MSSQL_MCP_CONNECTIONS";
export const ENV_INLINE_VAR = "MSSQL_MCP_CONNECTIONS_JSON";

/** Ruta por defecto para instalaciones vía npx, donde no hay directorio del proyecto. */
export function userConfigPath(home = homedir()) {
  return join(home, ".mcp-sqlserver", "connections.json");
}

/**
 * Orden de búsqueda, de más explícito a más implícito. El último es el
 * comportamiento histórico (connections.json junto a index.js) y se mantiene
 * para no romper a quien ya apunta su cliente MCP al repo clonado.
 */
export function candidatePaths({
  cliPath,
  env = process.env,
  cwd = process.cwd(),
  packageRoot = PACKAGE_ROOT,
  home = homedir(),
} = {}) {
  const candidates = [];
  if (cliPath) candidates.push({ source: "--connections", path: resolvePath(cwd, cliPath) });
  if (env[ENV_PATH_VAR]) {
    candidates.push({ source: `$${ENV_PATH_VAR}`, path: resolvePath(cwd, env[ENV_PATH_VAR]) });
  }
  candidates.push({ source: "current directory", path: join(cwd, "connections.json") });
  candidates.push({ source: "user config", path: userConfigPath(home) });
  candidates.push({ source: "package directory", path: join(packageRoot, "connections.json") });
  return candidates;
}

/**
 * Elige de dónde sale la configuración. El JSON inline gana sobre cualquier
 * archivo: permite dejar las credenciales en el bloque `env` del cliente MCP
 * y no tener archivo en disco.
 */
export function resolveConnectionsSource(options = {}) {
  const { env = process.env } = options;

  const candidates = candidatePaths(options);
  const explicit = candidates.find((c) => c.source.startsWith("--") || c.source.startsWith("$"));

  // El JSON inline va después de las rutas pedidas a mano, en el mismo orden
  // que documenta --help. Al revés, un cliente MCP que deje la variable en su
  // bloque `env` haría que --connections no tuviera efecto, en silencio.
  if (!explicit && env[ENV_INLINE_VAR]) {
    return { kind: "inline", source: `$${ENV_INLINE_VAR}`, raw: env[ENV_INLINE_VAR], searched: [] };
  }

  // Una ruta pedida a mano que no existe es un error del usuario. Caer en
  // silencio al connections.json del directorio actual sería peor que fallar:
  // terminaría hablando con la base equivocada.
  if (explicit && !existsSync(explicit.path)) {
    return { kind: "none", searched: candidates, missingExplicit: explicit };
  }

  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      return { kind: "file", ...candidate, searched: candidates };
    }
  }

  if (env[ENV_INLINE_VAR]) {
    return { kind: "inline", source: `$${ENV_INLINE_VAR}`, raw: env[ENV_INLINE_VAR], searched: candidates };
  }

  return { kind: "none", searched: candidates, missingExplicit: null };
}

const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Reemplaza ${env:NOMBRE} en cualquier string de la estructura. Sirve para
 * sacar las contraseñas del JSON. Los valores que no usan la sintaxis quedan
 * intactos, así que las configuraciones existentes no cambian.
 */
export function expandEnvVars(value, env = process.env, missing = []) {
  if (typeof value === "string") {
    return value.replace(ENV_REF, (match, name) => {
      if (env[name] === undefined) {
        missing.push(name);
        return match;
      }
      return env[name];
    });
  }
  if (Array.isArray(value)) return value.map((item) => expandEnvVars(item, env, missing));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = expandEnvVars(item, env, missing);
    return out;
  }
  return value;
}

/**
 * Valida la forma del archivo. Es deliberadamente permisiva: solo `name` y
 * `server` son obligatorios, para que cualquier connections.json que hoy
 * funcione siga funcionando.
 */
export function validateConnections(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { connections: [], errors: ['Expected a JSON object with a "connections" array'] };
  }
  if (!Array.isArray(parsed.connections)) {
    return { connections: [], errors: ['Missing required "connections" array'] };
  }

  const seen = new Set();
  const connections = [];
  parsed.connections.forEach((conn, index) => {
    const label = conn && conn.name ? `"${conn.name}"` : `at index ${index}`;
    if (!conn || typeof conn !== "object") {
      errors.push(`Connection ${label} is not an object`);
      return;
    }
    if (!conn.name) {
      errors.push(`Connection at index ${index} is missing "name"`);
      return;
    }
    if (seen.has(conn.name)) {
      errors.push(`Duplicate connection name "${conn.name}"`);
      return;
    }
    if (!conn.server) {
      errors.push(`Connection ${label} is missing "server"`);
      return;
    }
    if ("readOnly" in conn && typeof conn.readOnly !== "boolean") {
      // No se descarta la conexión: isReadOnly() trata cualquier valor que no
      // sea explícitamente falso como solo lectura, así que el efecto es
      // seguro. Pero conviene decirlo, porque "readOnly": "false" (con
      // comillas) no hace lo que parece.
      errors.push(
        `Connection ${label} has a non-boolean "readOnly" (${JSON.stringify(conn.readOnly)}); ` +
          `it is treated as read-only. Use true or false without quotes.`
      );
    }
    seen.add(conn.name);
    connections.push(conn);
  });

  return { connections, errors };
}

/**
 * La expansión de ${env:...} siempre devuelve string, así que un
 * "port": "${env:SQL_PORT}" produce "1433" y tedious rechaza el config con un
 * TypeError sobre config.options.port. Se convierte lo que claramente es un
 * número.
 */
function coerceTypes(conn) {
  if (typeof conn.port === "string" && /^\d+$/.test(conn.port)) {
    return { ...conn, port: Number(conn.port) };
  }
  return conn;
}

function describeSearch(searched) {
  return searched.map((c) => `  - ${c.path}  (${c.source})`).join("\n");
}

/**
 * Carga las conexiones. Nunca lanza: devuelve `{ connections, error }` y el
 * llamador decide qué hacer. `error` es texto listo para mostrarle a un humano.
 */
export function loadConnections(options = {}) {
  const { env = process.env } = options;
  const resolved = resolveConnectionsSource(options);

  if (resolved.kind === "none") {
    const hint = resolved.missingExplicit
      ? `No connections file at ${resolved.missingExplicit.path} (set via ${resolved.missingExplicit.source}).`
      : `No connections.json found. Looked in:\n${describeSearch(resolved.searched)}`;
    return {
      connections: [],
      path: null,
      source: null,
      searched: resolved.searched,
      error:
        `${hint}\n\n` +
        `Create one by running:  npx -y @cvelasquez/mcp-sqlserver --init\n` +
        `or point the server at an existing file with $${ENV_PATH_VAR}.`,
    };
  }

  let raw;
  if (resolved.kind === "inline") {
    raw = resolved.raw;
  } else {
    try {
      raw = readFileSync(resolved.path, "utf-8");
    } catch (err) {
      return {
        connections: [],
        path: resolved.path,
        source: resolved.source,
        error: `Could not read ${resolved.path}: ${err.message}`,
      };
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const where = resolved.kind === "inline" ? `$${ENV_INLINE_VAR}` : resolved.path;
    return {
      connections: [],
      path: resolved.path ?? null,
      source: resolved.source,
      error: `Invalid JSON in ${where}: ${err.message}`,
    };
  }

  const { connections: declared, errors } = validateConnections(parsed);

  // La expansión se hace por conexión para poder decir cuál quedó incompleta.
  // Una conexión a la que le falta la variable de la contraseña se deja
  // afuera: dejarla con el literal "${env:PROD_PW}" adentro solo cambia el
  // momento del fallo, y el error que llega es "Login failed for user", que no
  // dice nada sobre la variable que falta.
  const connections = [];
  for (const conn of declared) {
    const missing = [];
    const expanded = expandEnvVars(conn, env, missing);
    if (missing.length > 0) {
      const unique = [...new Set(missing)];
      errors.push(
        `Connection "${conn.name}" is disabled: unset environment variable${unique.length > 1 ? "s" : ""} ` +
          `${unique.join(", ")}. Set ${unique.length > 1 ? "them" : "it"} or replace the ` +
          `\${env:NAME} reference with a literal value.`
      );
      continue;
    }
    connections.push(coerceTypes(expanded));
  }

  return {
    connections,
    path: resolved.path ?? null,
    source: resolved.source,
    error: errors.length > 0 ? errors.join("\n") : null,
  };
}
