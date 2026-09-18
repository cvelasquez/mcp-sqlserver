// Doble del módulo `mssql`, solo en el borde: registra lo que se le pide y
// devuelve lo que le digamos. Nada más del código se mockea.
//
// Extiende EventEmitter porque el ConnectionPool real lo es: mssql emite
// 'error' sobre el pool para fallos que llegan fuera de toda promesa, y sin
// listener eso mata el proceso.

import { EventEmitter } from "node:events";

// Request también es un EventEmitter en mssql: en modo streaming las filas,
// los recordsets y los mensajes del servidor llegan por eventos, y 'done'
// cierra. El doble reproduce ese orden, incluido lo que pasa al cancelar.
class FakeRequest extends EventEmitter {
  constructor(pool) {
    super();
    this.pool = pool;
    this.inputs = {};
    this.stream = null;
    this.canceled = false;
  }

  // mssql acepta input(name, value) e input(name, type, value).
  input(name, ...rest) {
    this.inputs[name] = rest[rest.length - 1];
    return this;
  }

  cancel() {
    this.canceled = true;
    return true;
  }

  async query(sql) {
    if (this.stream) return this._stream({ kind: "query", sql, inputs: { ...this.inputs } });
    return this.pool._call({ kind: "query", sql, inputs: { ...this.inputs } });
  }

  async batch(sql) {
    if (this.stream) return this._stream({ kind: "batch", sql, inputs: { ...this.inputs } });
    return this.pool._call({ kind: "batch", sql, inputs: { ...this.inputs } });
  }

  // Igual que el driver real en modo streaming: los errores salen por el
  // evento 'error', siempre hay un 'done' al final y la promesa no rechaza.
  async _stream(call) {
    let result;
    try {
      result = await this.pool._call(call);
    } catch (err) {
      this.emit("error", err);
      this.emit("done", { output: {}, rowsAffected: [] });
      return;
    }

    const recordsets =
      result.recordsets && result.recordsets.length > 0
        ? result.recordsets
        : result.recordset
          ? [result.recordset]
          : [];

    for (const message of result.messages ?? []) this.emit("info", { message });

    this.emittedRows = 0;
    outer: for (const rows of recordsets) {
      const columns = result.columns ?? Object.fromEntries(Object.keys(rows[0] ?? {}).map((name, index) => [name, { index, name }]));
      this.emit("recordset", columns);
      for (const row of rows) {
        if (this.canceled) break outer;
        this.emittedRows++;
        this.emit("row", row);
      }
    }

    // tedious contesta a la cancelación con un error ECANCEL.
    if (this.canceled) {
      const err = new Error("Canceled.");
      err.code = "ECANCEL";
      this.emit("error", err);
    }

    this.emit("done", { output: {}, rowsAffected: result.rowsAffected ?? [] });
  }
}

const EMPTY_RESULT = { recordset: [], recordsets: [[]], rowsAffected: [0] };

export class FakePool extends EventEmitter {
  constructor(config, driver) {
    super();
    this.config = config;
    this.driver = driver;
    this.calls = [];
    this.requests = [];
    this.connected = false;
    this.closed = false;
    this.closeError = null;
  }

  async connect() {
    // Un Error falla todas las conexiones; una función decide por config.
    const failure =
      typeof this.driver?.connectError === "function"
        ? this.driver.connectError(this.config)
        : this.driver?.connectError;
    if (failure) throw failure;
    this.connected = true;
    return this;
  }

  async close() {
    if (this.closeError) throw this.closeError;
    this.closed = true;
  }

  request() {
    const request = new FakeRequest(this);
    this.requests.push(request);
    return request;
  }

  async query(sql) {
    return this._call({ kind: "query", sql, inputs: {} });
  }

  async batch(sql) {
    return this._call({ kind: "batch", sql, inputs: {} });
  }

  _call(call) {
    this.calls.push(call);
    if (this.driver?.onCall) {
      const result = this.driver.onCall(call, this);
      if (result !== undefined) return result;
    }
    return EMPTY_RESULT;
  }

  /** Simula el error asíncrono que emite mssql cuando se cae la conexión. */
  emitConnectionError(message = "Connection lost") {
    this.emit("error", new Error(message));
  }

  /** Todo el SQL que pasó por este pool, en orden. */
  get sql() {
    return this.calls.map((c) => c.sql);
  }
}

/**
 * @param {object} [options]
 * @param {Function} [options.onCall]  (call, pool) => resultado, o undefined para el vacío
 * @param {Error|((config: object) => Error|null)} [options.connectError]
 */
export function createFakeDriver(options = {}) {
  const driver = {
    pools: [],
    onCall: options.onCall ?? null,
    connectError: options.connectError ?? null,

    // Si alguien vuelve a sql.connect(), el pool global de mssql descarta el
    // config y devuelve la conexión anterior. Que explote fuerte.
    connect() {
      throw new Error("driver.connect() is the mssql global pool — use new ConnectionPool() per connection");
    },
  };

  driver.ConnectionPool = class extends FakePool {
    constructor(config) {
      super(config, driver);
      driver.pools.push(this);
    }
  };

  return driver;
}
