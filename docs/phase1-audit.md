# FASE 1 — Auditoría técnica (snapshot histórico)

Fecha: 2026-11-02 · Rama: `main` · Alcance: inspección previa a la implementación del archivado automático.

> Este documento describe el estado anterior a las fases de implementación; no es una descripción del plugin actual. Para las capacidades actuales, consulta el [README](../README.md) y el código en `src/userplugins/NAChatExporter/`.

---

## 1. Estado actual del plugin (6 archivos, todo en `src/userplugins/NAChatExporter/`)

| Archivo | Función real | Estado |
|---|---|---|
| `index.ts` | Entrada `definePlugin`. `start()`/`stop()` solo loguean. Descripción promete "JSON, HTML, CSV or TXT" | ❌ Promete HTML: **no existe implementación de HTML** (configuración engañosa, §12) |
| `settings.ts` | `exportJson` (botón), `defaultFormat` (incluye HTML), `pageDelayMs`, `maxMessages` | ⚠️ `defaultFormat` **no lo consume nadie**; `exportJson` es exportación manual (superseded por archivado automático) |
| `conversationResolver.ts` | Resuelve **solo el canal abierto** | ❌ Incompatible con captura global (§3.2) |
| `collector.ts` | Paginación REST `before`, 100/página, delay, 429 con espera, dedupe, cursor estancado | ✅ Sólido — **reutilizable como motor de backfill** con cambios de alcance |
| `export/json.ts` | Exportación manual vía diálogo nativo con manifiesto de integridad | ⚠️ Flujo manual — la integridad del manifiesto es reutilizable |
| `components/ExportButton.tsx` | Botón de exportación manual | ⚠️ Eliminable (§16: justificación documentada — superseded por automatización) |
| `utils/logger.ts` | `Logger("NAChatExporter")` | ✅ |

No hay persistencia, ni captura en directo, ni descubrimiento de conversaciones, ni escritura a disco propio, ni ediciones/eliminaciones/reacciones.

## 2. Capacidades verificadas de Vencord (evidencia)

### 2.1 Código en proceso main (Node/fs) — CLAVE para escribir en `D:/`
- `scripts/build/build.mjs:78` → `pluginDirs = ["plugins", "userplugins"]`: **los userplugins sí pueden tener `native.ts`**.
- Registro IPC: `src/VencordNative.ts:23-31` (`pluginHelpers` vía `GET_PLUGIN_IPC_METHOD_MAP`) + `@main/ipcPlugins` (`PluginIpcMappings`).
- Uso verificado: `src/plugins/voiceMessages/DesktopRecorder.tsx:27`
  `const Native = VencordNative.pluginHelpers.VoiceMessages as PluginNative<typeof import("./native")>;`
- `native.ts` corre en main con `electron`, `fs/promises`, `path` (ej.: `src/plugins/voiceMessages/native.ts`). El build **prohíbe** imports de node en renderer (`common.mjs:386-388`: "You need to use a native.ts file").
- Descargas: `src/plugins/directFileDownload.desktop/native.ts` valida host/protocolo y usa `e.sender.downloadURL` → patrón de validación reutilizable (descarga a ruta propia requiere `net`/`fs` en main — a validar en Fase 4).

### 2.2 Captura en directo
- `definePlugin({ flux: { EVENT(handler) } })` — `src/utils/types.ts:183-184` (`FluxEvents` tipado desde `@vencord/discord-types`); suscripción/desuscripción automática por `src/api/PluginManager.ts:161-183`. Ejemplo real: `vcNarrator/index.tsx:169-184`.
- Eventos **confirmados** en `@vencord/discord-types/src/fluxEvents.d.ts`:
  `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_UPDATE_EDIT`, `MESSAGE_DELETE`, `MESSAGE_DELETE_BULK`, `MESSAGE_REACTION_ADD`, `MESSAGE_REACTION_REMOVE`, `MESSAGE_REACTION_REMOVE_ALL`, `MESSAGE_REACTION_ADD_USERS`, `VOICE_STATE_UPDATES`, `CHANNEL_CREATE`, `CHANNEL_DELETE`, `GUILD_CREATE`, `THREAD_CREATE`, `THREAD_CREATE_LOCAL`.
- `src/api/MessageEvents.ts` solo ofrece hooks **pre-send/pre-edit** y click — **no** sirve para recepción (se usa `flux`).
- La forma exacta del payload de `MESSAGE_DELETE` (id vs channelId) se verifica en runtime (Fase 6) — handler defensivo: localizar por `messageId` indexado si falta `channelId`.

### 2.3 Descubrimiento de conversaciones (sin visitarlas)
- DMs/Grupos: `ChannelStore.getSortedPrivateChannels()`, `getMutablePrivateChannels()`, `getDMUserIds()` — `ChannelStore.d.ts:79-91`.
- Guilds: `GuildStore.getGuildIds()`, `getGuildsArray()` — `GuildStore.d.ts:4-8`.
- Canales de guild: `ChannelStore.getChannelIds()` (todos), `getMutableGuildChannelsForGuild(guildId)` — `ChannelStore.d.ts:38-50`.
- Hilos cacheados: `getAllThreadsForGuild(guildId)`, `getAllThreadsForParent(parentChannelId)` — `ChannelStore.d.ts:55-60`.
- Tipos exportables: enum `ChannelType` — `@vencord/discord-types/enums/channel.ts:56-74` (GUILD_TEXT=0, DM=1, GROUP_DM=3, GUILD_ANNOUNCEMENT=5, hilos 10/11/12; foro/media=15/16 requieren otro endpoint — ver §5).

### 2.4 Persistencia (verificada)
- **IndexedDB** con wrapper propio incluido: `src/api/DataStore/index.ts` (idb-keyval) con `createStore(dbName, storeName)` exportado → podemos abrir **nuestra propia base** con índices propios, sin dependencias (`common.mjs` no prohíbe `indexedDB` en renderer).
- Configuración persistente: `definePluginSettings` → archivo de settings de Vencord (`VencordNative.settings`, `src/VencordNative.ts:55-60`).
- Runtime versions: `VencordNative.native.getVersions()` → `process.versions` (`VencordNative.ts:79-81`) para sonda en runtime.

## 3. Evaluación de almacenamiento (§7 "Evaluar SQLite")

| Opción | Veredicto | Motivo técnico |
|---|---|---|
| SQLite (`better-sqlite3`) | ❌ Descartada | Nueva dependencia nativa (compilación ABI Electron) — viola "no introducir dependencias innecesarias" |
| SQLite (`node:sqlite`) | ❌ No prometible | Módulo experimental; su disponibilidad/flags en el Electron de Discord **no es verificable estáticamente**; no se simula lo que no se puede garantizar |
| **IndexedDB (renderer) + fs nativo (main)** | ✅ **Seleccionada** | IDB: transaccional, con índices, persistente, sin dependencias (Vencord ya la usa); fs en main vía `native.ts` para los archivos derivados visibles en `D:/` |

- **Fuente de verdad** = base IndexedDB `NAChatExporterArchive` (equivalente lógico de `System/archive.db`; documentado como sustitución, no simulación).
- `System/Events.jsonl` = append-only vía `fs.appendFile` en main (patrón IPC verificado).
- TXT/JSON/CSV = **derivados** regenerados/appendados desde la base (§7), nunca al revés.

## 4. Incompatibilidades detectadas (arquitectura existente vs requisitos)

1. Alcance de canal único (`conversationResolver`) → requiere registro global de conversaciones.
2. Sin suscripción a eventos flux → sin captura en directo ni ediciones/eliminaciones.
3. Sin persistencia propia → cierre de Discord = pérdida total (§8).
4. Flujo manual con botón y diálogos → contradice §1/§18 ("sin botones").
5. `defaultFormat` sin consumidor + HTML prometido sin implementar → §12 exige formatos reales (TXT/JSON/CSV).
6. Sin concurrencia entre backfill y live → carrera potencialmente perdedora de mensajes (§8).
7. Nada escribe fuera de los diálogos del sistema → sin estructura `D:/NA-CHAT-EXPORTER/`.

## 5. Riesgos identificados

| Riesgo | Mitigación prevista |
|---|---|
| Duplicados live↔backfill | Dedupe por clave `(channelId, messageId)` con índice único en IDB; el backfill pagina por cursor y solo inserta si la clave no existe |
| Pérdida durante cierre inesperado | IDB transaccional + `Events.jsonl` append-only + `flush` en `stop()`; estado de cursor por conversación persistido |
| Carreras historial/live | Cola única por conversación (serialización FIFO) + doble puntero: backfill solo inserta ids **anteriores** a su cursor; live inserta ids **≥ último visto**; al finalizar backfill se reconcilia contra el gap |
| Memoria con canales grandes | Nunca cargar conversación completa en RAM: lecturas por cursor IDB, escrituras por lotes, TXT append-only |
| Rate limits | Un solo backfill secuencial global con delay (`pageDelayMs`), espera de `retry_after` en 429 (ya implementado y probado) |
| Archivos derivados reconstruidos en exceso | TXT = append-only; JSON/CSV = reconstrucción con debounce en reposo + flush final |
| Nombres/rutas inválidos | Sanitización + validación main-side (`resolve` + prefijo del root configurado) |
| Hilos no cacheados / canales desconocidos | Descubrimiento: caché + `CHANNEL_CREATE`/`THREAD_CREATE` + resolución `GET /channels/{id}` si llega un mensaje de canal desconocido (verificar en Fase 3) |

## 6. Limitaciones que se declararán (nunca simuladas)

- Mensajes/ediciones/reacciones anteriores a la activación: solo si Discord los sirve en el historial REST; reacciones históricas **no** están en el endpoint de mensajes → no se prometen.
- Eliminaciones previas a la activación: imposibles sin copia previa.
- Periodos con Discord cerrado: no hay eventos live → el hueco se detecta al reanudar y se rellena por REST **solo si sigue accesible**.
- Descargas: solo URLs accesibles sin token (CDN público); el resto conserva referencia + `storedLocally: false` (§5.6).
- Foros/media (tipos 15/16): el endpoint `GET /channels/{id}/messages` no aplica; se listan sus hilos como conversaciones en su lugar (o se excluyen con estado documentado).

## 7. Arquitectura propuesta (ampliando la existente, no sustituyéndola)

```
NAChatExporter/
├── index.ts                 # orquestación start/stop + mapa flux
├── settings.ts              # configuración real (§12)
├── native.ts                # MAIN: mkdir/append/write/download + validación de rutas
├── core/
│   ├── db.ts                # capa IDB con índices (fuente de verdad)
│   ├── registry.ts          # descubrimiento + estado por conversación (cursors, integridad)
│   ├── backfill.ts          # historial REST (reutiliza lógica del collector actual)
│   ├── live.ts              # handlers flux → db
│   ├── scheduler.ts         # colas seriales historial+live, debounce de derivados, flush
│   └── events.ts            # Events.jsonl + contadores de integridad
├── derived/
│   ├── format.ts            # FORMATO APROBADO TXT (línea + ramas selectivas)
│   ├── writer.ts            # Chat.txt append / Chat.json / CSV (debounced) vía native
├── attachments/download.ts  # Fase 4
└── utils/{logger,sanitize}.ts
```

`collector.ts` + `conversationResolver.ts` + `export/json.ts` se **reutilizan/adaptan** (motor de paginación, validación de tipos de canal, manifiesto de integridad); `ExportButton.tsx` y `defaultFormat`-HTML se retiran con esta justificación.

## 8. Fases (reordenadas sin omitir objetivos)

1. **Auditoría** — este documento.
2. **Motor de archivado**: `db.ts` (esquema IDB con índices y claves únicas), `native.ts` (fs con validación), `events.ts`.
3. **Captura**: `registry.ts` (descubrimiento), `backfill.ts` (histórico con reconciliación), `live.ts` (flux), `scheduler.ts` (colas, reanudación, simultaneidad).
4. **Contenido**: ediciones, eliminaciones, respuestas, reacciones, encuestas, multimedia (descarga), eventos de voz observables.
5. **Exportación**: `format.ts` (TXT aprobado con ramas), `writer.ts` (Chat.txt/json/csv en estructura `D:/NA-CHAT-EXPORTER/`).
6. **Validación**: pruebas de la §14 (24 casos), rendimiento, integridad, correcciones.

Cada fase se cierra con `pnpm test:ts` + `eslint` + `pnpm build --dev` + `pnpm test` en verde antes de seguir.
