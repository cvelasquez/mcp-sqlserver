// Cómo salen los datos hacia el agente. Todo lo que está acá existe para no
// gastar contexto en bytes que no dicen nada.

/** Bytes de un varbinary que se muestran antes de recortar. */
export const BINARY_PREVIEW_BYTES = 64;

/**
 * JSON.stringify convierte un Buffer en {"type":"Buffer","data":[1,2,...]}:
 * un número por byte, ilegible, y enorme con un varbinary(max). En hexadecimal
 * es como lo muestra SSMS, y alcanza para comparar hashes o rowversions.
 */
export function formatBinary(buffer) {
  if (buffer.length <= BINARY_PREVIEW_BYTES) return `0x${buffer.toString("hex")}`;
  return `0x${buffer.subarray(0, BINARY_PREVIEW_BYTES).toString("hex")}... (${buffer.length} bytes)`;
}

function normalizeValue(value) {
  if (Buffer.isBuffer(value)) return formatBinary(value);
  // mssql junta en un arreglo las columnas con nombre repetido.
  if (Array.isArray(value)) return value.map(normalizeValue);
  return value;
}

/** Copia las filas reemplazando lo que no se serializa bien. No muta la entrada. */
export function normalizeRows(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) out[key] = normalizeValue(value);
    return out;
  });
}

function csvCell(value) {
  // NULL es la celda vacía y el string vacío va entre comillas: si los dos
  // salieran igual, el agente no podría distinguirlos.
  if (value === null || value === undefined) return "";
  if (value === "") return '""';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();

  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV según RFC 4180, con "\n" como fin de línea. Para resultados anchos ocupa
 * bastante menos que JSON, que repite el nombre de cada columna en cada fila.
 *
 * @param {object[]} rows
 * @param {string[]} [columns]  encabezado cuando no hay filas de donde sacarlo
 */
export function toCsv(rows, columns) {
  const header = columns && columns.length > 0 ? columns : Object.keys(rows[0] ?? {});
  if (header.length === 0) return "";

  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(header.map((name) => csvCell(row[name])).join(","));
  return lines.join("\n");
}
