// Doble del módulo `mssql`, solo en el borde: registra lo que se le pide y
// devuelve lo que le digamos. Nada más del código se mockea.
//
// Extiende EventEmitter porque el ConnectionPool real lo es: mssql emite
// 'error' sobre el pool para fallos que llegan fuera de toda promesa, y sin
// listener eso mata el proceso.

import { EventEmitter } from "node:events";

class FakeRequest {
  constructor(pool) {
    this.pool = pool;
    this.inputs = {};
  }

  // mssql acepta input(name, value) e input(name, type, value).
  input(name, ...rest) {
    this.inputs[name] = rest[rest.length - 1];
    return this;
  }

  async query(sql) {
    return this.pool._call({ kind: "query", sql, inputs: { ...this.inputs } });
  }

  async batch(sql) {
    return this.pool._call({ kind: "batch", sql, inputs: { ...this.inputs } });
  }
}

const EMPTY_RESULT = { recordset: [], recordsets: [[]], rowsAffected: [0] };

export class FakePool extends EventEmitter {
  constructor(config, driver) {
    super();
    this.config = config;
    this.driver = driver;
    this.calls = [];
    this.connected = false;
    this.closed = false;
    this.closeError = null;
  }

  async connect() {
    if (this.driver?.connectError) throw this.driver.connectError;
    this.connected = true;
    return this;
  }

  async close() {
    if (this.closeError) throw this.closeError;
    this.closed = true;
  }

  request() {
    return new FakeRequest(this);
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
 * @param {Error} [options.connectError]
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
