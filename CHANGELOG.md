# Changelog

Todos los cambios notables de este proyecto serán documentados en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/),
y este proyecto adhiere a [Semantic Versioning](https://semver.org/lang/es/).

---

## [3.0.0] - 2026-09-09

> From this release on, entries are written in English to match the rest of the
> documentation. Older entries are left as they were published.

Published to npm as **`@cvelasquez/mcp-sqlserver`**. The unscoped
`mcp-sqlserver` name on npm belongs to an unrelated package that was
unpublished in 2025 and cannot be reused.

### Fixed

- **Every connection after the first talked to the wrong database.** The server
  called `sql.connect(config)`, which is the `mssql` *global* connection pool.
  Once any connection is open, that function discards the config it is given
  and returns the existing pool
  ([`mssql/lib/global-connection.js`](https://github.com/tediousjs/node-mssql/blob/master/lib/global-connection.js)).
  So asking for `client-b` handed back `client-a`'s pool, and the query ran
  against `client-a`'s server and database, silently. Every connection now gets
  its own `ConnectionPool`. Covered by a regression test.

  If you used more than one connection in a session on 2.x, results may not
  have come from where you believed. Worth re-checking anything you acted on.

- **SQL injection in three tools.** `get_schema`, `get_indexes` and
  `get_stored_procedure` interpolated the table or procedure name straight into
  the query text. They now use bound parameters.

- **A missing `connections.json` killed the process at startup**, so the agent
  showed only "server disconnected" with no explanation. The server now starts
  regardless and `list_connections` reports what went wrong and where it looked.

- **Connection options were being dropped.** The driver config was assembled
  field by field, discarding `domain`, `authentication`, `connectionTimeout`,
  `requestTimeout`, `pool` and any nested `options`. Everything that is not our
  own metadata is now passed through to `mssql`.

- **`get_execution_plan` could run the query for real.** `SET SHOWPLAN_XML ON`
  is connection state, but `pool.request()` does not pin a connection — mssql
  acquires and releases one per batch. With a second call in flight, the
  `SHOWPLAN_XML ON` could land on one connection and the query on another,
  without a plan, executing for real; meanwhile the marked connection stayed in
  showplan mode and returned XML to unrelated queries. The plan now runs on a
  dedicated single-connection pool that is closed afterwards, which destroys
  the connection along with its session state.

- **A non-string `sql` argument bypassed the read-only guard and still ran.**
  The MCP SDK does not validate arguments against `inputSchema`, and
  `pool.query()` treats a non-string as a tagged template and executes its
  first element. `{"sql": {"0": "DELETE FROM Users"}}` therefore ran against a
  connection marked read-only. String arguments are now type-checked first.

- **Statements that slipped past the read-only guard.** A procedure call
  without `EXEC` (`sp_rename 'dbo.Users','Users_old'`, legal T-SQL) contains no
  blocked keyword. The guard now also requires the batch to start with a
  reading keyword, and blocks `OPENQUERY`, `DISABLE`, `ENABLE` and `WAITFOR`.

- **The read-only guard blocked legitimate queries.** `DECLARE @Create` matched
  the `CREATE` keyword, because `@` is not a word character. Variables and temp
  tables are excluded now.

- **A dropped connection could kill the whole server.** `mssql` emits `error`
  on the pool for failures that arrive outside any promise — a server restart,
  Azure SQL closing an idle session. An `EventEmitter` with no `error` listener
  throws, and the uncaught exception took the process down, so one bad
  connection disconnected every other one.

- **`MSSQL_MCP_CONNECTIONS_JSON` silently overrode `--connections`**, contrary
  to the documented precedence. Explicit paths now win.

- **An unset `${env:VAR}` left the literal in the config**, so the failure
  surfaced later as `Login failed for user`. The connection is now disabled and
  named, along with the variable that is missing.

- **A `port` coming from an environment variable arrived as a string** and
  tedious rejected the whole config with a `TypeError`. Numeric strings are
  coerced.

- **The web UI silently dropped fields it does not have inputs for.** Editing
  any connection rebuilt it from the ten form fields, wiping `readOnly`,
  `domain` and `authentication` — turning off the read-only guard and breaking
  domain and Entra ID logins. It merges now, and `readOnly` has a checkbox.

### Added

- **Install with one line.** `npx -y @cvelasquez/mcp-sqlserver` — no clone, no
  `npm install`, no absolute paths in the agent config.
- **`--init`** writes a starter `~/.mcp-sqlserver/connections.json`.
- **Connections file resolution**: `--connections`, `$MSSQL_MCP_CONNECTIONS`,
  `$MSSQL_MCP_CONNECTIONS_JSON` (inline), the working directory, the user
  config directory, then the package directory. An explicit path that does not
  exist is an error rather than a silent fallback to another file.
- **`${env:VAR}` in any string**, so passwords need not live in the file.
  Unset variables are reported at startup.
- **`"readOnly": true` per connection** rejects writing statements before the
  query leaves the machine. A guard rail against an over-helpful agent, not a
  security boundary — the README says so and shows the `db_datareader` login
  that is. Any value other than an explicit `false` enables it, so a
  hand-written `"readOnly": "false"` cannot quietly disable the guard.
- **Windows domain (NTLM) and Entra ID authentication**, documented, via the
  config passthrough.
- **Test suite** on `node:test`, no new dependencies. The `mssql` driver is
  injected and mocked only at that boundary. `test/contract.test.js` freezes
  the tool names and arguments; an end-to-end smoke test packs the tarball,
  installs it elsewhere and speaks MCP to it.
- **CI** on Node 18/20/22 across Linux and Windows, including a check that no
  credential file can reach the npm tarball and that `server.json` validates
  against the MCP registry.
- **`.mcpb` bundle** for one-click installation in Claude Desktop.
- **`server.json`** and **`glama.json`** for the official MCP registry and Glama.

### Changed

- `index.js` is now a thin entry point; the logic lives in `src/`. The path
  `node <repo>/index.js` still works, so existing agent configs keep running.
- `list_connections` marks read-only connections and reports which file it
  loaded, so "why is it not seeing my change" is answerable at a glance.
- The web UI moved to `web/`. GitHub was reporting the repository as an HTML
  project because that one file outweighed the server.
- `node_modules` is no longer tracked in git.
- Documentation rewritten around what this server actually does better than
  the alternatives: many instances, grouped, in one entry.

### Unchanged

- All seven tools keep their names, arguments and response shape.
- Existing `connections.json` files work as they are. Every new field is
  optional; there is nothing to migrate.

---

## [2.0.0] - 2026-01-01

### 🎉 Cambios Mayores

- **Gestión centralizada de conexiones**: Todas las conexiones ahora se definen en un único archivo `connections.json`
- **Configuración simplificada**: Solo se necesita una entrada en `claude_desktop_config.json` para todas las conexiones
- **Agrupación de conexiones**: Nuevo campo `connectionGroup` para organizar conexiones por cliente/proyecto/ambiente
- **Descripciones detalladas**: Nuevo campo `description` para identificar el propósito, sede o ambiente de cada conexión

### ✨ Nuevas Características

#### Comandos Nuevos
- **`list_connections`**: Lista todas las conexiones disponibles agrupadas por `connectionGroup`
- **`reload_connections`**: Recarga el archivo `connections.json` sin necesidad de reiniciar Claude Desktop
  - Cierra automáticamente pools de conexión obsoletos
  - Carga nueva configuración en caliente
  - Retorna información detallada del proceso (conexiones cargadas, pools cerrados)

#### Mejoras en Comandos Existentes
- **Metadata en todas las respuestas**: Todos los comandos ahora incluyen información completa de la conexión utilizada:
  - `connection`: Nombre de la conexión
  - `connectionGroup`: Grupo al que pertenece
  - `description`: Descripción detallada
  - `server`: Servidor SQL Server
  - `database`: Base de datos

- **`get_execution_plan`**: Corregido bug crítico
  - Ahora retorna correctamente el plan de ejecución en formato XML
  - Incluye información detallada de costos
  - Detecta y reporta missing indexes sugeridos por SQL Server
  - Permite análisis profundo de rendimiento de queries

### 🔧 Mejoras Técnicas

- **Pool de conexiones optimizado**: Reutilización eficiente de conexiones activas para mejor rendimiento
- **Función `loadConnections()`**: Permite recargar conexiones dinámicamente
- **Gestión automática de pools**: Cierre inteligente de conexiones obsoletas al recargar
- **Mejor manejo de errores**: Mensajes más descriptivos y contextuales
- **Validación de configuración**: Verifica existencia de conexiones antes de usarlas

### 📝 Cambios en la API

#### BREAKING CHANGES

Todas las herramientas ahora requieren el parámetro `connection` para identificar qué conexión usar:

**Antes (v1.0):**
```javascript
query({ sql: "SELECT * FROM Users" })
```

**Ahora (v2.0):**
```javascript
query({ 
  connection: "minsur-raura",
  sql: "SELECT * FROM Users" 
})
```

#### Formato de Respuestas

Todas las respuestas (excepto `list_connections` y `reload_connections`) ahora incluyen metadata:

```json
{
  "metadata": {
    "connection": "minsur-raura",
    "connectionGroup": "Minsur",
    "description": "Base de datos sede Raura",
    "server": "192.168.1.10\\SQLEXPRESS",
    "database": "Minsur_Raura"
  },
  "data": [...],
  "rowsAffected": 10
}
```

### 🔒 Seguridad

- Documentación completa de mejores prácticas de seguridad en README.md
- Recomendaciones sobre manejo de credenciales sensibles
- Plantilla `.gitignore` actualizada para proteger `connections.json`
- Advertencias sobre no subir credenciales a repositorios públicos
- Sugerencias de permisos de archivo en diferentes sistemas operativos

### 📚 Documentación

- **README.md completamente reescrito** con:
  - Documentación detallada de todos los comandos
  - Ejemplos de uso avanzados con Claude
  - Casos de uso reales por industria
  - Guía completa de solución de problemas
  - Instrucciones de migración desde v1.0
  - Roadmap de futuras versiones

- **CHANGELOG.md actualizado** con:
  - Historial completo de cambios
  - Formato estandarizado basado en Keep a Changelog
  - Secciones claras por tipo de cambio

- **Archivos de ejemplo actualizados**:
  - `connections.template.json`: Template de configuración
  - `claude_desktop_config_example.json`: Ejemplo de configuración simplificada

### 🧪 Testing

Durante el desarrollo se realizaron pruebas exhaustivas:

#### Pruebas Básicas (✅ Completadas)
1. Listar todas las tablas (529 tablas detectadas)
2. Obtener esquema de tabla específica (107 columnas)
3. Ejecutar SELECT con filtros
4. Verificar índices de tabla

#### Pruebas de Performance (✅ Completadas)
5. Plan de ejecución con filtro simple (bug detectado y corregido)
6. Plan de ejecución con COUNT (Missing Index detectado - Impact 98.21%)
7. Plan de ejecución con JOINs complejos (Missing Index detectado - Impact 88.97%)

#### Pruebas de Stored Procedures (✅ Completadas)
8. Listar stored procedures disponibles (20+ SPs)
9. Obtener definición de SP simple
10. Obtener definición de SP complejo
11. Manejo de SP inexistente

#### Pruebas de Dependencias (✅ Completadas)
12. Identificar dependencias SP → Tabla
13. Identificar dependencias entre SPs

#### Pruebas de Metadata (✅ Completadas)
14. Verificar metadata en todas las respuestas
15. Validar información de conexión en diferentes tipos de consultas

#### Pruebas de Análisis (✅ Completadas)
16. Analizar estructura de tablas relacionadas - 61 Foreign Keys encontradas
17. Detectar tablas sin índices - 112 heap tables detectadas
18. Sugerir optimizaciones de esquema

#### Pruebas de Reload (✅ Completadas)
19. Agregar nueva conexión y recargar sin reiniciar
20. Modificar conexión existente y recargar
21. Eliminar conexión y verificar cierre de pools

### 📋 Migración desde v1.0

#### Paso 1: Crear connections.json

Convierte cada entrada de `claude_desktop_config.json` a una entrada en `connections.json`:

**Formato antiguo:**
```json
{
  "mcpServers": {
    "sqlserver-minsur-raura": {
      "command": "node",
      "args": ["C:\\mcp-sqlserver\\index.js"],
      "env": {
        "SQL_SERVER": "192.168.1.10\\SQLEXPRESS",
        "SQL_DATABASE": "Minsur_Raura",
        "SQL_USER": "sa",
        "SQL_PASSWORD": "password",
        "SQL_PORT": "1433"
      }
    }
  }
}
```

**Formato nuevo:**
```json
{
  "connections": [
    {
      "name": "minsur-raura",
      "connectionGroup": "Minsur",
      "description": "Base de datos sede Raura",
      "server": "192.168.1.10\\SQLEXPRESS",
      "database": "Minsur_Raura",
      "user": "sa",
      "password": "password",
      "port": 1433,
      "encrypt": false,
      "trustServerCertificate": true
    }
  ]
}
```

#### Paso 2: Simplificar claude_desktop_config.json

Elimina todas las entradas `sqlserver-xxx` y deja una única entrada:

```json
{
  "mcpServers": {
    "sqlserver": {
      "command": "node",
      "args": ["C:\\mcp-sqlserver\\index.js"]
    }
  }
}
```

#### Paso 3: Reiniciar y Verificar

1. Cierra completamente Claude Desktop
2. Vuelve a abrir Claude Desktop
3. Ejecuta: `"Lista todas las conexiones SQL Server disponibles"`
4. Verifica que todas tus conexiones aparezcan correctamente

### 🐛 Bugs Corregidos

- **get_execution_plan**: Corregido bug crítico donde devolvía resultados de la query en lugar del plan XML
  - Problema: Usaba múltiples `pool.request()` que no compartían la misma sesión
  - Solución: Usar un único objeto `request` para todos los comandos batch
  - Resultado: Ahora retorna correctamente el plan de ejecución en formato XML con toda la información de análisis

### ⚠️ Deprecaciones

- **Variables de entorno para configuración**: Ya no se usan variables de entorno en `claude_desktop_config.json`
- **Múltiples entradas en claude_desktop_config.json**: Ahora solo se necesita una entrada

---

## [1.0.0] - 2025-12-15

### 🎉 Release Inicial

#### Características Principales

- Conexión a SQL Server usando Node.js y mssql
- Configuración mediante variables de entorno en `claude_desktop_config.json`
- Una entrada por conexión en el archivo de configuración

#### Herramientas Implementadas

1. **query**: Ejecuta consultas SQL
2. **get_schema**: Obtiene esquema de tablas
3. **get_indexes**: Lista índices de tablas
4. **get_execution_plan**: Obtiene plan de ejecución (con bug)
5. **get_stored_procedure**: Obtiene definición de stored procedures

#### Limitaciones de v1.0

- Configuración verbosa (una entrada por conexión)
- Sin agrupación de conexiones
- Sin metadata en respuestas
- Sin capacidad de recarga en caliente
- Bug en `get_execution_plan` que devuelve resultados en lugar del plan XML

---

## Tipos de Cambios

- ✨ **Nuevas características**: Nueva funcionalidad añadida
- 🔧 **Mejoras**: Cambios en funcionalidad existente
- 🐛 **Bugs corregidos**: Corrección de bugs
- 🔒 **Seguridad**: Cambios relacionados con seguridad
- 📝 **Documentación**: Solo cambios en documentación
- 🎨 **Estilo**: Cambios que no afectan el significado del código
- ♻️ **Refactorización**: Cambios de código que no corrigen bugs ni añaden características
- ⚡ **Performance**: Cambios que mejoran el rendimiento
- 🧪 **Testing**: Añadir o corregir tests
- 🔨 **Build**: Cambios en el sistema de build o dependencias externas
- ⚠️ **Breaking Changes**: Cambios incompatibles con versiones anteriores
- 🗑️ **Deprecaciones**: Características marcadas como obsoletas

---

## [2.1.0] - 2026-01-14

### 🎨 Web UI Improvements

- ✨ **NUEVO:** Interfaz completamente en inglés
- ✨ **NUEVO:** Auto-carga automática de connections.json si se encuentra en la misma carpeta
- ✨ **NUEVO:** Botón duplicar conexiones (añade sufijo "-copy" automáticamente)
- ✨ **NUEVO:** Drag & drop de tarjetas de conexiones entre grupos
- ✨ **NUEVO:** Selector inteligente de grupos con autocompletado
- 🔧 Mejora visual con feedback al arrastrar
- 🔧 Mejor UX al crear/editar conexiones
- 📝 Documentación completa actualizada en inglés

### 📚 Documentation

- 🌐 **NUEVO:** Toda la documentación traducida al inglés
- 🤖 **NUEVO:** Referencias generalizadas a "AI agents" (Claude, ChatGPT, Gemini, Copilot)
- 📝 README.md completamente reescrito en inglés con ejemplos multi-agente
- 📝 connections-README.md actualizado con información de compatibilidad
- 📝 CLAUDE.md actualizado con guías de Web UI y auto-save

### 🛠️ Technical Changes

- Implementación de HTML5 Drag and Drop API
- Uso de datalist para selector de grupos
- Función autoLoadConnectionsFile() con fetch API
- File System Access API para auto-guardado
- Lógica de nombres únicos para duplicados (copy, copy2, copy3...)
- CSS mejorado para estados de drag (dragging, drag-over)
- Notificaciones persistentes flotantes con animación slideInRight

### 🤖 AI Agent Compatibility

- Compatible con cualquier agente de IA que soporte MCP:
  - ✅ Claude Desktop (Anthropic)
  - ✅ ChatGPT con soporte MCP
  - ✅ GitHub Copilot con integración MCP
  - ✅ Google Gemini con soporte MCP
  - ✅ Cualquier otro agente que implemente Model Context Protocol

---

## [Unreleased]

### Planeado para v2.2.0

- [ ] Soporte para autenticación integrada de Windows
- [ ] Exportar resultados de queries a CSV/Excel
- [ ] Backup automático de esquemas de base de datos
- [ ] Comando para comparar esquemas entre dos conexiones
- [ ] Soporte para transacciones explícitas
- [ ] Historial de queries ejecutadas

### Considerando para v3.0.0

- [ ] Soporte para Azure SQL Database
- [ ] Integración con Azure Key Vault para credenciales
- [ ] Interfaz web para gestión de conexiones
- [ ] Métricas y monitoreo de uso del MCP
- [ ] Soporte para otros tipos de bases de datos (PostgreSQL, MySQL)
- [ ] Cache de resultados de queries frecuentes
- [ ] Sistema de plugins para extensiones personalizadas

---

**¿Encontraste un bug o tienes una sugerencia?**  
Abre un issue en [GitHub Issues](https://github.com/cvelasquez/mcp-sqlserver/issues)
