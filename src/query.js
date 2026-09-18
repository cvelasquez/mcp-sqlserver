// Ejecución de la herramienta `query`.
//
// Corre en el modo streaming de mssql por tres motivos que salen del mismo
// mecanismo: las filas llegan de a una y se puede cortar al llegar al tope,
// cada SELECT del batch avisa cuándo empieza, y los mensajes del servidor
// (PRINT, STATISTICS IO/TIME) llegan como eventos en vez de perderse.

export const DEFAULT_MAX_ROWS = 1000;
export const MAX_ROWS_LIMIT = 10000;

/**
 * El SDK no valida los argumentos contra el inputSchema, y hay agentes que
 * mandan los enteros como string. Pasarse del máximo no es un error: se baja
 * al máximo, y la respuesta truncada dice con qué tope se corrió.
 */
export function resolveMaxRows(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_ROWS;

  let parsed = value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) parsed = Number(value.trim());

  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Parameter 'maxRows' must be an integer between 1 and ${MAX_ROWS_LIMIT}`);
  }
  return Math.min(parsed, MAX_ROWS_LIMIT);
}

/**
 * Lo que lee el agente cuando el resultado quedó cortado. El riesgo no es que
 * falten filas, es que el agente crea que no faltan: "la tabla tiene 10000
 * registros". Por eso la nota dice sin vueltas que hay más, que el total no se
 * sabe, y cómo averiguarlo.
 *
 * @param {number} maxRows    el tope con el que se corrió
 * @param {*} requested       el maxRows que mandó el cliente, tal como llegó
 */
export function truncationNote(maxRows, requested) {
  const asked = Number(requested);
  const lowered = Number.isFinite(asked) && asked > MAX_ROWS_LIMIT;
  const atLimit = maxRows >= MAX_ROWS_LIMIT;

  return [
    `INCOMPLETE RESULT: only the first ${maxRows} rows are included and the query was cancelled.`,
    `The query returns more rows than that and the total is unknown; ${maxRows} is the cap, not the row count.`,
    // Bajar el tope no es un error, pero si por eso faltan filas hay que decirlo.
    lowered ? `The requested maxRows of ${asked} was lowered to the hard limit of ${MAX_ROWS_LIMIT}.` : null,
    `Run SELECT COUNT(*) for the total.`,
    atLimit
      ? `${MAX_ROWS_LIMIT} is the hard limit: narrow the query with WHERE or an aggregate, or page through it with ORDER BY ... OFFSET/FETCH.`
      : `Narrow the query with TOP, WHERE or an aggregate, or pass a higher maxRows (max ${MAX_ROWS_LIMIT}).`,
  ]
    .filter(Boolean)
    .join(" ");
}

function columnNames(columns) {
  if (Array.isArray(columns)) return columns.map((c) => c.name);
  return Object.keys(columns ?? {});
}

/**
 * @param {object} pool  ConnectionPool de mssql
 * @param {string} sql
 * @param {{maxRows: number}} options  tope sobre el TOTAL de filas del batch
 * @returns {Promise<{recordsets: object[][], columns: string[][], rowsAffected: number[],
 *   messages: string[], rowCount: number, truncated: boolean}>}
 */
export function runQuery(pool, sql, { maxRows }) {
  return new Promise((resolve, reject) => {
    const request = pool.request();
    request.stream = true;

    const recordsets = [];
    const columns = [];
    const messages = [];
    const errors = [];
    let current = null;
    let rowCount = 0;
    let truncated = false;

    request.on("recordset", (cols) => {
      if (truncated) return;
      current = [];
      recordsets.push(current);
      columns.push(columnNames(cols));
    });

    request.on("row", (row) => {
      if (truncated) return;
      if (rowCount >= maxRows) {
        // Llegó una fila más de las que entran: recién ahí sabemos que había
        // más. Cancelar le avisa al servidor que deje de mandar; recortar al
        // final traería igual los diez millones de filas a memoria.
        truncated = true;
        request.cancel();
        return;
      }
      if (!current) {
        current = [];
        recordsets.push(current);
        columns.push(Object.keys(row));
      }
      current.push(row);
      rowCount++;
    });

    request.on("info", (info) => {
      if (info?.message) messages.push(info.message);
    });

    request.on("error", (err) => {
      // La cancelación propia vuelve como ECANCEL. No es un fallo.
      if (truncated) return;
      errors.push(err);
    });

    request.on("done", (result) => {
      if (errors.length > 0) {
        // Un batch puede dejar varios errores. Sin streaming mssql reporta solo
        // el último ("could not be prepared"), y el útil suele ser el primero
        // ("Invalid column name"). Van todos, sin repetidos.
        const unique = [...new Set(errors.map((e) => e?.message ?? String(e)))];
        const error = new Error(unique.join("\n"));
        error.code = errors[0]?.code;
        reject(error);
        return;
      }
      resolve({
        recordsets,
        columns,
        rowsAffected: result?.rowsAffected ?? [],
        messages,
        rowCount,
        truncated,
      });
    });

    // En streaming la promesa de mssql no rechaza: los errores salen por el
    // evento. El catch cubre lo que falle antes de llegar a ese punto.
    Promise.resolve()
      .then(() => request.query(sql))
      .catch(reject);
  });
}
