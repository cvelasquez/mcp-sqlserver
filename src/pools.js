// Manejo de pools de conexión, uno por conexión declarada.
//
// El driver se inyecta para poder testear sin una base real; en producción es
// el módulo `mssql`.

/**
 * Campos que son metadata nuestra y no del driver. Todo lo demás se pasa tal
 * cual, así el usuario puede usar cualquier opción de mssql (authentication,
 * pool, requestTimeout, options anidadas) sin que tengamos que mantener una
 * lista blanca que siempre queda vieja.
 */
const META_KEYS = new Set(["name", "connectionGroup", "description", "readOnly"]);

/**
 * Traduce una entrada de connections.json a un config de mssql.
 *
 * `encrypt` y `trustServerCertificate` van al nivel superior, que es donde
 * mssql los busca con su guarda de tipo (lib/tedious/connection-pool.js:14).
 * Un `options` anidado se respeta y tiene prioridad.
 */
export function buildDriverConfig(connConfig) {
  const config = {};
  for (const [key, value] of Object.entries(connConfig)) {
    if (META_KEYS.has(key)) continue;
    config[key] = value;
  }
  // Objeto propio en cada llamada: mssql muta config.options al construir el pool.
  config.options = { ...(connConfig.options ?? {}) };
  return config;
}

/**
 * mssql emite 'error' sobre el pool para fallos que llegan fuera de cualquier
 * promesa: el servidor que se reinicia, Azure SQL matando una sesión ociosa.
 * Un EventEmitter sin listener de 'error' lanza, y una excepción no capturada
 * mata el proceso — el cliente MCP pierde TODAS las conexiones porque se cayó
 * una. Se registra y se sigue: el próximo uso reconecta.
 */
function attachErrorHandler(pool, name) {
  pool.on("error", (err) => {
    console.error(`[${name}] connection pool error: ${err?.message ?? err}`);
  });
}

export function createPoolManager({ driver, connections = [] } = {}) {
  if (!driver) throw new Error("createPoolManager requires a driver");

  const pools = new Map();
  let list = connections;

  function setConnections(next) {
    list = Array.isArray(next) ? next : [];
  }

  function getConnectionConfig(name) {
    return list.find((c) => c.name === name);
  }

  // Se guarda la promesa, no el pool: dos herramientas que piden la misma
  // conexión a la vez tienen que esperar la misma conexión. Guardando el pool
  // ya resuelto, la segunda llamada abriría un segundo pool y el primero
  // quedaría huérfano, con su socket abierto y fuera del alcance de closeAll.
  async function get(name) {
    if (pools.has(name)) return pools.get(name);

    const connConfig = getConnectionConfig(name);
    if (!connConfig) throw new Error(`Connection '${name}' not found`);

    // `driver.connect()` es la conexión GLOBAL de mssql: si ya hay una abierta
    // descarta el config nuevo y devuelve la vieja, así que todas las
    // conexiones terminaban apuntando a la primera base usada. Un pool propio
    // por conexión es la única forma de que cada nombre hable con su servidor.
    const pool = new driver.ConnectionPool(buildDriverConfig(connConfig));
    attachErrorHandler(pool, name);
    const pending = pool.connect().then(() => pool);
    pools.set(name, pending);

    try {
      return await pending;
    } catch (error) {
      // Un fallo de red no puede dejar la conexión rota para siempre: se
      // saca del mapa para que el próximo intento vuelva a probar.
      pools.delete(name);
      throw error;
    }
  }

  async function closeAll() {
    const closed = [];
    for (const [name, pending] of pools.entries()) {
      try {
        const pool = await pending;
        await pool.close();
        closed.push(name);
      } catch {
        // Puede estar ya cerrado, o nunca haber llegado a conectarse.
      }
    }
    pools.clear();
    return closed;
  }

  /**
   * Pool de una sola conexión, fuera de la caché, para operaciones que
   * dependen del estado de la sesión.
   *
   * `pool.request()` NO fija una conexión: mssql toma una del pool y la
   * devuelve en cada .batch()/.query() (lib/tedious/request.js:276), y tarn
   * entrega la última liberada. Con dos llamadas solapadas, un `SET
   * SHOWPLAN_XML ON` puede quedar en una conexión y la consulta ejecutarse en
   * otra — sin plan y de verdad. Con max: 1 hay una sola conexión posible.
   *
   * El llamador tiene que cerrarlo: al cerrarse se destruye la conexión, así
   * que ningún estado de sesión sobrevive.
   */
  async function createDedicated(name) {
    const connConfig = getConnectionConfig(name);
    if (!connConfig) throw new Error(`Connection '${name}' not found`);

    const config = buildDriverConfig(connConfig);
    config.pool = { ...(config.pool ?? {}), min: 1, max: 1 };

    const pool = new driver.ConnectionPool(config);
    attachErrorHandler(pool, name);
    await pool.connect();
    return pool;
  }

  return {
    get,
    createDedicated,
    getConnectionConfig,
    setConnections,
    closeAll,
    get connections() {
      return list;
    },
    get size() {
      return pools.size;
    },
  };
}
