// Cableado del servidor MCP: estado de conexiones, pools y handlers.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { loadConnections } from "./config.js";
import { createPoolManager } from "./pools.js";
import { TOOL_DEFINITIONS, createToolHandler } from "./tools.js";

export const SERVER_NAME = "mssql-server";

/**
 * @param {object} options
 * @param {object} options.driver          módulo mssql (o un doble en tests)
 * @param {string} options.version
 * @param {object} [options.loadOptions]   opciones para loadConnections()
 * @param {Function} [options.load]        inyectable en tests
 */
export function createSqlServer({ driver, version, loadOptions = {}, load = loadConnections }) {
  let state = load(loadOptions);

  const pools = createPoolManager({ driver, connections: state.connections });

  const getState = () => state;

  // Cerrar los pools es parte de recargar, no responsabilidad del llamador:
  // si la lista cambia y los pools quedan, un nombre reutilizado sigue
  // apuntando al servidor viejo mientras metadata reporta el nuevo.
  async function reload() {
    const closed = await pools.closeAll();
    state = load(loadOptions);
    pools.setConnections(state.connections);
    return { ...state, closedPools: closed.length };
  }

  const callTool = createToolHandler({ pools, getState, reload });

  const server = new Server(
    { name: SERVER_NAME, version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(name, args ?? {});
  });

  return { server, pools, callTool, getState, reload };
}
