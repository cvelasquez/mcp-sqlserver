// Baranda para conexiones marcadas con "readOnly": true.
//
// No es un límite de seguridad y el README lo dice así: la protección real es
// un login de SQL Server con permisos de solo lectura (db_datareader). Esto
// existe para atajar el accidente — el agente que decide "arreglar" una fila
// en producción — no para contener a alguien que quiere escribir a propósito.
//
// Son dos capas, porque una sola no alcanza:
//   1. Lista de palabras que escriben.
//   2. Lista blanca de con qué puede empezar el batch. Sin esto, llamar un
//      procedimiento sin EXEC (`sp_rename 'a','b'`, que T-SQL permite como
//      primera sentencia) no usa ninguna palabra bloqueada y pasa limpio.

/**
 * Sentencias que escriben, cambian el esquema, mueven permisos o ejecutan
 * código arbitrario. EXEC entra porque un procedimiento puede hacer cualquier
 * cosa; para leer el código de uno está get_stored_procedure.
 */
const WRITE_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "CREATE", "ALTER",
  "GRANT", "REVOKE", "DENY", "EXEC", "EXECUTE", "BACKUP", "RESTORE", "SHUTDOWN",
  "DBCC", "RECONFIGURE", "KILL", "BULK", "OPENROWSET", "OPENDATASOURCE",
  "OPENQUERY", "WRITETEXT", "UPDATETEXT", "INTO", "DISABLE", "ENABLE",
  "WAITFOR", "CHECKPOINT", "REVERT",
];

// (?<![@#\w]) evita el falso positivo de las variables: en `DECLARE @Create`
// el \b de la izquierda sí matchea, porque @ no es carácter de palabra, y
// bloquear un nombre de variable haría la baranda inusable.
const KEYWORD_RE = new RegExp(`(?<![@#\\w])\\b(${WRITE_KEYWORDS.join("|")})\\b`, "i");

/**
 * Con qué puede empezar un batch de solo lectura. Todo lo demás — empezando
 * por un identificador suelto, que es una llamada a procedimiento — se
 * rechaza.
 */
const READ_STARTERS = new Set([
  "SELECT", "WITH", "DECLARE", "SET", "IF", "WHILE", "BEGIN", "PRINT", "USE",
  "OPEN", "FETCH", "CLOSE", "DEALLOCATE", "THROW", "RETURN", "GO",
]);

/**
 * Saca comentarios, literales de texto e identificadores citados, y deja un
 * espacio en su lugar. Se hace en una sola pasada porque un comentario puede
 * contener una comilla y un literal puede contener "--"; procesarlos con
 * expresiones regulares por separado se rompe con cualquiera de los dos.
 *
 * Un identificador como [delete] o "update" es un nombre de columna válido y
 * no debería bloquear la consulta, por eso también se blanquea.
 */
export function stripLiterals(sql) {
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }

    if (ch === "/" && next === "*") {
      // T-SQL permite anidar bloques de comentario.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; continue; }
        i++;
      }
      out += " ";
      continue;
    }

    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      out += " ";
      continue;
    }

    if (ch === "[") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "]" && sql[i + 1] === "]") { i += 2; continue; }
        if (sql[i] === "]") { i++; break; }
        i++;
      }
      out += " x ";
      continue;
    }

    if (ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      out += " x ";
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** Primera palabra real del batch, ignorando `;` y paréntesis de apertura. */
function firstWord(stripped) {
  const match = /^[\s;(]*([A-Za-z_][A-Za-z0-9_@#$]*)/.exec(stripped);
  return match ? match[1].toUpperCase() : null;
}

/**
 * @returns {{allowed: boolean, keyword?: string, reason?: string}}
 */
export function inspectStatement(sql) {
  if (typeof sql !== "string") {
    return { allowed: false, reason: "the query is not a string" };
  }

  const stripped = stripLiterals(sql);

  const match = KEYWORD_RE.exec(stripped);
  if (match) {
    const keyword = match[1].toUpperCase();
    return { allowed: false, keyword, reason: `it uses ${keyword}` };
  }

  const start = firstWord(stripped);
  if (start === null) {
    // Ni una palabra: comentarios, espacios o vacío. No hay nada que ejecutar.
    return { allowed: true };
  }
  if (!READ_STARTERS.has(start)) {
    // Un identificador suelto al principio de un batch es una llamada a
    // procedimiento: `sp_rename 'dbo.Users','Users_old'` no lleva EXEC.
    return {
      allowed: false,
      keyword: start,
      reason: `it starts with '${start}', which reads as a stored procedure call`,
    };
  }

  return { allowed: true };
}

/**
 * Lanza si la conexión es de solo lectura y la consulta escribe.
 */
export function assertReadOnly(sql, connectionName) {
  const result = inspectStatement(sql);
  if (result.allowed) return;
  throw new Error(
    `Connection '${connectionName}' is marked readOnly and this query was rejected because ${result.reason}. ` +
      `Remove "readOnly": true from the connection to allow writes.`
  );
}

/**
 * Cualquier valor que no sea explícitamente falso deja la conexión en solo
 * lectura. Un `"readOnly": "true"` escrito a mano en el JSON no puede terminar
 * desactivando la baranda en silencio: ante la duda, se cierra.
 */
export function isReadOnly(connConfig) {
  const value = connConfig?.readOnly;
  if (value === undefined || value === null) return false;
  if (value === false || value === "false" || value === 0 || value === "") return false;
  return true;
}
