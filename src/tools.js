// Definiciones de las herramientas MCP y su despacho.
//
// Los nombres, los inputSchema y la forma del JSON de respuesta son contrato
// público: hay clientes configurados contra esto. test/contract.test.js los
// congela para que un refactor no los mueva sin que nos enteremos.

import { assertReadOnly, isReadOnly } from "./readonly.js";
import { runQuery, resolveMaxRows, truncationNote, DEFAULT_MAX_ROWS, MAX_ROWS_LIMIT } from "./query.js";
import { normalizeRows, toCsv } from "./format.js";

const FORMATS = ["json", "csv"];

// Los clientes MCP leen estas anotaciones para decidir si piden confirmación.
// `query` no lleva ninguna: si escribe o no depende de la conexión y del SQL.
const READ_ONLY = { readOnlyHint: true };

export const TOOL_DEFINITIONS = [
  {
    name: "list_connections",
    description: "List all available SQL Server connections grouped by connectionGroup",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: READ_ONLY,
  },
  {
    name: "reload_connections",
    description:
      "Reload connections from connections.json file without restarting the MCP server. Closes existing connection pools and loads new configuration.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    // Cambia el estado del servidor, pero no rompe nada y se puede repetir.
    // Sin declararlo, destructiveHint vale true por defecto.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "query",
    description: "Execute a SQL query on the database",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string", description: "Connection name to use" },
        sql: { type: "string", description: "SQL query to execute" },
        maxRows: {
          type: "integer",
          minimum: 1,
          maximum: MAX_ROWS_LIMIT,
          description:
            `Maximum rows to return across all result sets (default ${DEFAULT_MAX_ROWS}, max ${MAX_ROWS_LIMIT}). ` +
            "When the cap is hit the query is cancelled on the server and the response starts with truncated: true. " +
            "A truncated result is incomplete and the total row count is unknown: never report the cap as the number of rows. " +
            "Prefer TOP, WHERE or aggregates over raising this.",
        },
        format: {
          type: "string",
          enum: FORMATS,
          description:
            "Output format (default json). csv is far more compact for wide or long results: " +
            "the first line is a JSON header with metadata, then the rows as CSV.",
        },
      },
      required: ["connection", "sql"],
    },
  },
  {
    name: "get_schema",
    description: "Get database schema information for specific tables",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string", description: "Connection name to use" },
        table: { type: "string", description: "Table name (optional, returns all if not specified)" },
      },
      required: ["connection"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_indexes",
    description: "Get index information for a table",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string", description: "Connection name to use" },
        table: { type: "string", description: "Table name" },
      },
      required: ["connection", "table"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_execution_plan",
    description: "Get execution plan for a query",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string", description: "Connection name to use" },
        sql: { type: "string", description: "SQL query to analyze" },
      },
      required: ["connection", "sql"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_stored_procedure",
    description: "Get stored procedure definition",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string", description: "Connection name to use" },
        name: { type: "string", description: "Stored procedure name" },
      },
      required: ["connection", "name"],
    },
    annotations: READ_ONLY,
  },
];

function text(payload) {
  return { content: [{ type: "text", text: payload }] };
}

// Compacto a propósito: la indentación no le sirve a quien lo lee, que es un
// modelo. Medido sobre 500 filas de sys.all_objects: 210 KB indentado, 157 KB
// compacto, 66 KB en csv.
function json(payload) {
  return text(JSON.stringify(payload));
}

function failure(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function renderConnectionList(connections) {
  const grouped = {};
  connections.forEach((conn) => {
    if (!grouped[conn.connectionGroup]) grouped[conn.connectionGroup] = [];
    grouped[conn.connectionGroup].push({
      name: conn.name,
      description: conn.description,
      server: conn.server,
      database: conn.database,
      readOnly: isReadOnly(conn),
    });
  });

  let output = "Available SQL Server Connections:\n\n";
  for (const [group, conns] of Object.entries(grouped)) {
    output += `${group}:\n`;
    conns.forEach((conn) => {
      output += `  - ${conn.name}${conn.readOnly ? "  [read-only]" : ""}\n`;
      output += `    Description: ${conn.description}\n`;
      output += `    Server: ${conn.server}\n`;
      output += `    Database: ${conn.database}\n\n`;
    });
  }
  return output;
}

/**
 * @param {object} ctx
 * @param {object} ctx.pools  pool manager (src/pools.js)
 * @param {() => object} ctx.getState  { connections, path, source, error }
 * @param {() => Promise<object>} ctx.reload
 * @param {string|null} [ctx.runtimeError]  por qué el driver no corre en este Node (src/runtime.js)
 */
export function createToolHandler({ pools, getState, reload, runtimeError = null }) {
  return async function callTool(name, args = {}) {
    try {
      if (name === "list_connections") {
        const state = getState();
        // Si el driver no corre en este Node ninguna conexión va a andar: va primero.
        const blocker = runtimeError ? `${runtimeError}\n\n` : "";
        if (state.connections.length === 0) {
          // Es el primer lugar donde alguien mira cuando "no anda". Si la
          // configuración no cargó, acá va el motivo, no una lista vacía.
          return text(
            blocker +
              (state.error
                ? `No connections are loaded.\n\n${state.error}`
                : "Available SQL Server Connections:\n\n")
          );
        }
        let output = blocker + renderConnectionList(state.connections);
        if (state.path) output += `Loaded from: ${state.path}\n`;
        if (state.error) output += `\nWarnings:\n${state.error}\n`;
        return text(output);
      }

      if (name === "reload_connections") {
        try {
          const state = await reload();
          return json({
            success: true,
            message: "Connections reloaded successfully",
            totalConnections: state.connections.length,
            closedPools: state.closedPools,
            connectionNames: state.connections.map((c) => c.name),
            ...(state.path ? { loadedFrom: state.path } : {}),
            ...(state.error ? { warnings: state.error } : {}),
          });
        } catch (error) {
          return { ...json({ success: false, error: error.message }), isError: true };
        }
      }

      if (!args.connection) {
        throw new Error("Connection parameter is required");
      }

      const state = getState();
      const connConfig = state.connections.find((c) => c.name === args.connection);
      if (!connConfig) {
        if (state.connections.length === 0 && state.error) {
          throw new Error(`Connection '${args.connection}' not found. ${state.error}`);
        }
        throw new Error(`Connection '${args.connection}' not found`);
      }

      const metadata = {
        connection: args.connection,
        connectionGroup: connConfig.connectionGroup,
        description: connConfig.description,
        server: connConfig.server,
        database: connConfig.database,
      };

      // El SDK no valida los argumentos contra el inputSchema, así que llegan
      // tal como los mandó el cliente. Un `sql` que no sea string se saltea la
      // baranda de readOnly (String({...}) es "[object Object]") y aun así se
      // ejecuta, porque mssql lo interpreta como tagged template y corre
      // strings[0]. Los tipos se verifican antes de tocar nada.
      for (const field of ["sql", "table", "name", "format"]) {
        if (field in args && args[field] !== undefined && typeof args[field] !== "string") {
          throw new Error(`Parameter '${field}' must be a string`);
        }
      }

      // Igual que lo anterior: se valida antes de abrir la conexión.
      let maxRows;
      let format;
      if (name === "query") {
        maxRows = resolveMaxRows(args.maxRows);
        format = args.format ?? "json";
        if (!FORMATS.includes(format)) {
          throw new Error(`Parameter 'format' must be one of: ${FORMATS.join(", ")}`);
        }
      }

      // Antes de abrir la conexión: una consulta rechazada no debería ni tocar
      // la red, y el error tiene que ser el motivo real y no un timeout.
      if (name === "query" && isReadOnly(connConfig)) {
        assertReadOnly(args.sql, args.connection);
      }

      // El driver fallaría igual, pero con un error que no explica nada.
      if (runtimeError) throw new Error(runtimeError);

      // get_execution_plan trabaja sobre su propio pool dedicado.
      const pool = name === "get_execution_plan" ? null : await pools.get(args.connection);

      switch (name) {
        case "query": {
          const result = await runQuery(pool, args.sql, { maxRows });
          const recordsets = result.recordsets.map(normalizeRows);

          // Todo lo que describe el resultado va ANTES de las filas, y el aviso
          // de truncado primero. Una respuesta de 10000 filas pesa cientos de
          // KB: si el cliente recorta la salida se queda con el principio, y
          // con el aviso al final el agente creería que vio el resultado entero.
          //
          // Los campos opcionales solo aparecen cuando dicen algo: en la
          // consulta común, que entra entera, la respuesta no crece.
          const head = {
            metadata,
            ...(result.truncated
              ? { truncated: true, maxRows, note: truncationNote(maxRows, args.maxRows) }
              : {}),
            rowCount: result.rowCount,
            rowsAffected: result.rowsAffected?.[0],
            ...(result.messages.length > 0 ? { messages: result.messages } : {}),
          };

          if (format === "csv") {
            const header = JSON.stringify({ ...head, format });
            const blocks = recordsets.map((rows, i) => toCsv(rows, result.columns[i]));
            // Un solo bloque de texto: no todos los clientes muestran más de uno.
            const body =
              blocks.length > 1
                ? blocks.map((csv, i) => `-- recordset ${i + 1}\n${csv}`).join("\n\n")
                : (blocks[0] ?? "");
            return text(`${header}\n\n${body}`);
          }

          return json({
            ...head,
            // `data` es el primer recordset, como siempre. Los demás antes se
            // perdían; ahora van en `recordsets` cuando hay más de uno.
            data: recordsets[0] ?? [],
            ...(recordsets.length > 1 ? { recordsets } : {}),
          });
        }

        case "get_schema": {
          const request = pool.request();
          let query;
          if (args.table) {
            request.input("tableName", args.table);
            query = `
            SELECT
              c.TABLE_NAME,
              c.COLUMN_NAME,
              c.DATA_TYPE,
              c.CHARACTER_MAXIMUM_LENGTH,
              c.IS_NULLABLE,
              c.COLUMN_DEFAULT
            FROM INFORMATION_SCHEMA.COLUMNS c
            WHERE c.TABLE_NAME = @tableName
            ORDER BY c.ORDINAL_POSITION
          `;
          } else {
            query = `
            SELECT
              c.TABLE_NAME,
              c.COLUMN_NAME,
              c.DATA_TYPE,
              c.CHARACTER_MAXIMUM_LENGTH,
              c.IS_NULLABLE
            FROM INFORMATION_SCHEMA.COLUMNS c
            ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
          `;
          }
          const result = await request.query(query);
          return json({ metadata, schema: result.recordset });
        }

        case "get_indexes": {
          const request = pool.request();
          request.input("tableName", args.table);
          const result = await request.query(`
          SELECT
            i.name AS IndexName,
            i.type_desc AS IndexType,
            COL_NAME(ic.object_id, ic.column_id) AS ColumnName,
            ic.is_included_column AS IsIncluded
          FROM sys.indexes i
          INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          WHERE OBJECT_NAME(i.object_id) = @tableName
          ORDER BY i.name, ic.key_ordinal
        `);
          return json({ metadata, indexes: result.recordset });
        }

        case "get_execution_plan": {
          // SHOWPLAN_XML es estado de la CONEXIÓN, y pool.request() no fija
          // ninguna: mssql toma y devuelve una conexión en cada batch. Sobre
          // el pool compartido, otra llamada en paralelo puede quedarse con la
          // conexión marcada y hacer que la consulta se ejecute de verdad
          // contra otra. Un pool dedicado de una sola conexión lo vuelve
          // imposible, y al cerrarlo la conexión se destruye con su estado.
          const planPool = await pools.createDedicated(args.connection);
          try {
            const request = planPool.request();

            // SET SHOWPLAN_XML tiene que ser la única sentencia del batch.
            await request.batch("SET SHOWPLAN_XML ON");

            // Con SHOWPLAN_XML activo la consulta no se ejecuta: devuelve el plan.
            const planResult = await request.batch(args.sql);

            let planXml = null;
            if (planResult.recordsets && planResult.recordsets.length > 0) {
              const planRecordset = planResult.recordsets[0];
              if (planRecordset && planRecordset.length > 0) {
                const firstRow = planRecordset[0];
                // El nombre de la columna cambia según la versión del servidor.
                planXml =
                  firstRow["Microsoft SQL Server 2005 XML Showplan"] ||
                  firstRow["QUERY PLAN"] ||
                  firstRow[Object.keys(firstRow)[0]];
              }
            }

            return json({ metadata, query: args.sql, executionPlanXml: planXml });
          } finally {
            // Cerrar destruye la conexión: no hace falta apagar SHOWPLAN_XML
            // ni queda forma de que se filtre a otra consulta.
            await planPool.close().catch(() => {});
          }
        }

        case "get_stored_procedure": {
          const request = pool.request();
          request.input("procName", args.name);
          const result = await request.query(`
          SELECT OBJECT_DEFINITION(OBJECT_ID(@procName)) AS Definition
        `);
          return json({
            metadata,
            storedProcedure: args.name,
            definition: result.recordset[0]?.Definition || "Stored procedure not found",
          });
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      // No todo lo que se lanza es un Error: un throw de string o de null
      // daría "Error: undefined", o rompería acá mismo.
      return failure(error?.message ?? String(error));
    }
  };
}
