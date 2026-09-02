# AUDITORÍA TÉCNICA — GreenFit

**Fecha:** 2026-09-01
**Alcance:** Dashboard Admin (`PAGINA SUPABASE`), PWA de Socios (`APLICACION/greenfit-app`), backend Supabase compartido (proyecto `pgigyscgsrowlfddfnbj`).
**Método:** lectura estática de código y de los ~53 archivos `.sql` versionados en ambos repos. **No se ejecutó ningún query contra la base de producción** — donde algo depende de eso se aclara explícitamente ("no verificable sin acceso a producción").

---

## 1. MAPA DE ARQUITECTURA

### Corrección de contexto importante
La PWA de Socios **no es React + Vite**. Es una app **Expo / React Native 0.81** (`greenfit-app/package.json:25-40`) que corre en 3 targets: nativo (iOS/Android, sin usar hoy) y **Web vía `react-native-web`** — el `npm run web` (`expo start --web`) es lo que sirve la "PWA" real en el celular del socio. Esto importa porque varias APIs de React Native (`Alert.alert`, `Modal`, gestos) se comportan distinto o no existen en el build Web, y ya causó al menos un bug real (ver Punch List #3).

### Repos y cómo se conectan
Son **3 repositorios Git separados**, sin monorepo ni workspace compartido:

| Repo | Remoto | Rol |
|---|---|---|
| `PAGINA SUPABASE` | `FacundoUria/GreenfitAdminDashboard` | Dashboard Admin |
| `APLICACION/greenfit-app` | `FacundoUria/GREENFIT-APP` | PWA de Socios + Edge Functions |
| `PAGINA COMERCIAL/greenfit-site` | `FacundoUria/Greenfit` | Landing pública (no pedida en este audit, no se cubre en detalle) |

Los tres viven bajo una misma carpeta `GREENFIT/` en disco, pero esa carpeta **no es un repo git** (`git rev-parse` falla ahí) — es solo una convención de carpetas del desarrollador, no una relación versionada.

La única conexión real entre Dashboard y PWA es que **ambos apuntan al mismo proyecto Supabase** (`pgigyscgsrowlfddfnbj`, confirmado en `supabase/.temp/project-ref` de los dos repos) vía variables de entorno:
- Admin: `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (`PAGINA SUPABASE/src/lib/supabaseClient.js:3-4`)
- PWA: `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` (`greenfit-app/src/lib/supabase.ts:5-6`)

No hay ningún paquete compartido, tipo, o cliente común entre los dos frontends — cualquier regla de negocio que viva en ambos lados (ej. "2 horas de tolerancia para cancelar", nombres de disciplinas) está **duplicada a mano** en cada repo, con el riesgo de divergencia que eso implica (ver sección 6).

Las **Edge Functions solo existen en el repo de la PWA** (`greenfit-app/supabase/functions/`) — el Admin no tiene ninguna función propia, solo llama a RPCs de Postgres directo.

### Estructura de carpetas real

**Dashboard Admin** (`PAGINA SUPABASE/`, Vite + React 19 + Tailwind v4):
```
src/
  pages/          # 1 componente por ruta (Socios, Clases, Configuracion, Reportes, Home...)
  components/      # componentes reusables (modales, tablas, grids); comunidad/ y rutinas/ como subcarpetas
  context/         # AuthContext, ConfiguracionContext (hardcoded login, ver sección 6)
  utils/           # lógica de negocio pura: creditosPwa.js, planes.js, clases.js, fichaSocioPwa.js, socioMetrics.js, fecha.js
  lib/             # supabaseClient.js
  __tests__/       # Vitest, espejando pages/components/utils
e2e/               # Playwright contra un mock de red (mismo patrón que la PWA)
*.sql (raíz)       # 36 migraciones sueltas, sin carpeta supabase/migrations versionada por el CLI
```

**PWA de Socios** (`greenfit-app/`, Expo 54 + React Native 0.81 + TypeScript):
```
src/
  screens/
    auth/          # LoginScreen
    user/          # HomeScreen, AgendaMobileView, ProfileScreen, HistoryScreen, UserRoutineScreen, ComunidadMobileView...
  navigation/       # MainTabs (Tab Navigator), HomeStack, ProfileStack (gate de perfil obligatorio)
  context/          # AuthContext, ConfiguracionContext
  lib/               # supabase.ts, classesApi.ts, creditsApi.ts, paymentsApi.ts, xpApi.ts, dni.ts...
  components/        # modales (CancelBookingModal, MessageModal, BookingConfirmModal...)
  hooks/, theme/, types/
  __tests__/          # Jest + @testing-library/react-native, espejando screens/lib/components
e2e/                  # Playwright contra un mock de red completo (supabaseMock.ts, sin Supabase real)
supabase/functions/   # Edge Functions (Deno): create-payment-preference, mp-webhook, admin-create-socio,
                       # admin-delete-socio, admin-reset-password, send-push, _shared/
backend/              # 17 migraciones sueltas + schema.sql (LEGACY, ver Sección 6) + supabase-schema.sql (baseline real)
```

### Librerías clave (versión exacta en `package.json`)

| | Dashboard Admin | PWA de Socios |
|---|---|---|
| Framework | React 19.2.7 + Vite 8.1.1 | Expo 54 / React Native 0.81.5 / React 19.1.0 |
| Estilos | Tailwind CSS 4.3.3 | StyleSheet nativo (sin librería de estilos) |
| Routing | react-router-dom 7.18.1 | @react-navigation 6.x (bottom-tabs + native-stack) |
| Backend client | @supabase/supabase-js **^2.111.0** | @supabase/supabase-js **^2.45.4** |
| Testing unit | Vitest 4.1.10 + Testing Library | Jest (jest-expo 54) + @testing-library/react-native |
| Testing E2E | Playwright 1.62.1 | Playwright 1.62.1 |
| Gráficos | recharts 3.10.1 | — |

**Nota:** las versiones de `@supabase/supabase-js` están **desalineadas entre repos** (2.111.0 vs 2.45.4, ~66 versiones menores de diferencia) — no es un bug funcional hoy, pero es exactamente el tipo de drift que después produce comportamientos distintos entre paneles ante el mismo bug de la librería.

---

## 2. ESQUEMA DE BASE DE DATOS REAL

⚠️ **Hallazgo estructural, antes de la lista:** no existe un schema versionado único. Hay un archivo base (`greenfit-app/backend/supabase-schema.sql`, 486 líneas) más **53 archivos `.sql` sueltos** repartidos en dos repos, sin carpeta `supabase/migrations/` gestionada por el CLI de Supabase (ambos repos tienen `supabase/.temp/` de un `supabase link`, pero ninguno tiene `supabase/migrations/`). Cada migración se corrió **a mano** en el SQL Editor de producción, en un orden que solo existe en la memoria de quien las corrió. Esto ya generó divergencia real y verificable entre lo que el código versionado dice que existe y lo que probablemente existe en producción (ver los 3 ejemplos concretos más abajo, y el Punch List #2).

### Tablas confirmadas por `create table` en el código versionado

| Tabla | Origen | RLS | Policy (resumen) |
|---|---|---|---|
| `profiles` | `supabase-schema.sql:13` | ✅ | Cada uno ve/edita el suyo; admin ve/edita todos (`:175-178`) |
| `disciplines` | `supabase-schema.sql:59` | ✅ | SELECT público para cualquier logueado + policy `disciplines_select_public` que lo abre a **cualquiera sin sesión** (`disciplines_select_publico.sql:26-28`, decisión consciente: catálogo no sensible); solo admin escribe |
| `packs` | `supabase-schema.sql:70` | ✅ | SELECT para logueados, solo admin escribe |
| `user_credits` | `supabase-schema.sql:85` | ✅ | Cada uno ve el suyo; **solo admin escribe** (con `with check` explícito reforzado en `user_credits_rls_admin.sql`) |
| `credit_transactions` | `supabase-schema.sql:105` | ✅ | Cada uno ve las suyas; solo admin inserta |
| `classes` | `supabase-schema.sql:125` | ✅ | SELECT para logueados (+ variante pública en `aparatos_schedules.sql:64` para horarios de Aparatos en la Landing); solo admin escribe |
| `bookings` | `supabase-schema.sql:142` | ✅ | Cada uno ve/inserta/borra las suyas; admin ve/gestiona todas; solo admin actualiza (`attended`) |
| `booking_cancellations` | `supabase-schema.sql:353` | ✅ | Cada uno ve las suyas o admin; insert propio |
| `notifications` | `supabase-schema.sql:381` | ✅ | Admin gestiona todo; el socio ve según audiencia (`all`/`user`/`class`/`debtors`, resuelto dinámicamente contra `bookings`/`user_credits`) |
| `push_subscriptions` | `supabase-schema.sql:465` | ✅ | Cada uno administra las suyas; admin lee todas para poder mandar el push |
| `community_posts` / `community_reactions` / `community_comments` | `supabase_migration_comunidad.sql` | ✅ | SELECT abierto a autenticados; insert/delete propio |
| `community_groups` / `community_group_members` / `community_group_messages` | `supabase_migration_comunidad.sql` | ✅ | Select para miembros/todos según tabla; insert propio |
| `community_dm_threads` / `community_dm_messages` | `supabase_migration_mensajes.sql` | ✅ | Solo ve/escribe quien participa del hilo |
| `xp_events` | `supabase_migration_xp.sql:18` | ✅ | Select propio **o admin** (ampliado en `ficha360.sql:16`); insert propio con reglas (luego restringido en `xp_solo_asistencia.sql`) |
| `metas_personales` | `supabase_migration_xp.sql:111` | ✅ | CRUD propio |
| `pr_catalog` | `supabase_migration_pr_catalog.sql:14` | ✅ | Select para todos; solo admin escribe |
| `routine_exercise_weights` | `supabase_migration_routine_weights.sql:11` | ✅ | CRUD propio |
| `pagos_socio` | `PAGINA SUPABASE/supabase_migration_ficha360.sql:29` | ✅ | Cada uno ve los suyos o admin; solo admin escribe (webhook de MP escribe vía RPC `security definer`, bypasea RLS a propósito) |
| `configuracion` | `PAGINA SUPABASE/supabase_migration_configuracion.sql:7` | ✅ | **Ver hallazgo crítico abajo** |
| `socios` | **nunca creada en SQL versionado** — solo `alter table` en 9 migraciones distintas | ✅ (habilitado en `rls_y_clase_id.sql:16`) | Hoy: `authenticated` + `is_admin()` (`admin_auth_rls.sql:29-32`) |
| `asistencias` | **nunca creada en SQL versionado** | ✅ (habilitado en `rls_y_clase_id.sql:42`) | **Ver hallazgo crítico abajo — nunca se cerró el acceso `anon`** |

### Respuestas directas
- **¿Existe `socios`?** Sí, la usa todo el Dashboard Admin — pero su `CREATE TABLE` original no está en ningún repo (ver Punch List #2). Columnas confirmadas por uso real en código: `id, nombre, apellido, dni, email, telefono, plan (text[]), estado, activo, ultimo_pago, dia_corte, fecha_vencimiento, fecha_inicio_cuota, creditos`.
- **¿Existe `profiles`?** Sí (`supabase-schema.sql:13`) — es la extensión de `auth.users` que usa la PWA. Columnas base: `id, email, full_name, dni, phone, role, emergency_contact_name, emergency_contact_phone, medical_notes`. Más `avatar_url` y `domicilio`, agregadas por migraciones posteriores (`domicilio_y_sync_telefono.sql`) que tampoco están en el `create table` original — mismo patrón de drift.
- **¿Existe `user_credits`?** Sí (`supabase-schema.sql:85`), es la billetera real de la PWA: `user_id, discipline_id, pack_id (nullable), remaining_credits, expires_at`.
- **¿Existe `disciplines`?** Sí (`supabase-schema.sql:59`): `id, name (unique, case-sensitive), kind ('credits'|'membership')`.
- **¿Hay tabla de historial de pagos de Mercado Pago?** Sí, pero **no es una tabla dedicada**: `pagos_socio` (creada para pagos manuales de Seba) se reutilizó para MP agregándole `origen` y `mercado_pago_payment_id` (`mercadopago_payments.sql:7-11`). No hay una tabla `mercadopago_payments` real pese al nombre del archivo de migración — el nombre del archivo es engañoso.

### Hallazgo crítico #1 — `configuracion` sigue abierta a `anon` para escritura
`supabase_migration_configuracion.sql:32-33`:
```sql
create policy "anon select configuracion" on configuracion for select to anon using (true);
create policy "anon update configuracion" on configuracion for update to anon using (true) with check (true);
```
Ningún archivo posterior cierra esto (a diferencia de `socios`/`classes`, que sí se cerraron en `admin_auth_rls.sql`). Esta tabla guarda `alias_cbu`/`titular_cuenta` (los datos de transferencia bancaria que ve el socio en "Elegí tu pack", `HomeScreen.tsx`), precios, y el tiempo de tolerancia de cancelación. La `anon key` es pública por diseño (viaja en el bundle JS de ambas apps) — con `UPDATE ... using(true)` para `anon`, **cualquiera que abra las devtools del navegador y copie esa key puede reescribir esos datos vía la REST API de Supabase directamente**, sin pasar por ningún frontend. El caso más grave: cambiar `alias_cbu`/`titular_cuenta` para redirigir transferencias reales a otra cuenta. No verificable sin acceso a producción si la policy sigue así hoy, pero no hay ningún script en el historial que la haya cerrado. **Ver Punch List #1.**

### Hallazgo crítico #2 — `asistencias` nunca cerró su acceso `anon`
`supabase_migration_rls_y_clase_id.sql:49-52` le da a `anon` SELECT/INSERT/UPDATE/DELETE completo sobre `asistencias` ("mientras no haya login de verdad, después reemplazar por `authenticated`" dice el propio comentario del archivo, línea 11-13). `admin_auth_rls.sql` cerró el mismo hueco para `socios` y `classes` explícitamente, pero **`asistencias` no aparece en ningún migración posterior**. La tabla sigue viva en código actual (`Home.jsx`, `xpApi.ts`, `FichaSocioHistorial.jsx`) — no es una tabla huérfana. **Ver Punch List #1.**

### `configuracion`: columnas usadas en código que no están en ningún `CREATE TABLE`/`ALTER TABLE` versionado
El código de `Configuracion.jsx` (Admin) lee/escribe `config.limite_cancelacion_minutos` y `config.alias_cvu` (`Configuracion.jsx:12-16, 112-116`). El único `CREATE TABLE configuracion` versionado (`supabase_migration_configuracion.sql:7-20`) tiene `horas_limite_cancelacion` (no `limite_cancelacion_minutos`) y `alias_cbu` (no `alias_cvu`). Ninguna migración posterior renombra esas dos columnas. O bien alguien las renombró/agregó a mano en el dashboard de Supabase sin dejar rastro en el repo, o el código está escribiendo a columnas que no existen (lo cual Supabase no siempre reporta como error duro). Esto es el mismo patrón de drift que el punto anterior — ver Punch List #2 y #5.

---

## 3. SINCRONIZACIÓN SOCIOS ↔ PWA

### Cómo nace la cuenta de un socio en la PWA
El puente NO es una Edge Function llamada desde el Admin — es un **trigger de Postgres** que se dispara solo:

`PAGINA SUPABASE/supabase_migration_socios_auto_auth.sql:104-107`:
```sql
create trigger on_socio_dni_upsert
  after insert or update of dni on public.socios
  for each row execute function public.handle_socio_dni_upsert();
```

`handle_socio_dni_upsert()` (mismo archivo, líneas 40-102) valida el DNI con `^\d{6,10}$` (línea 53), y si es válido llama a la Auth Admin API de Supabase (`net.http_post` async, vía la extensión `pg_net`, línea 81-98) para crear el `auth.users` con:
- `email: NEW.dni || '@greenfit.com'`
- `password: NEW.dni`

El motivo documentado (líneas 11-20) de por qué es un trigger de base y no una llamada normal desde el frontend: **el login del Admin no usa Supabase Auth real** — es un usuario/clave hardcodeado en el cliente (confirmado en el propio comentario, y consistente con que el Admin corría durante mucho tiempo con RLS abierta a `anon`, sección 2). Sin un JWT real, el Admin no puede llamar a la Edge Function `admin-create-socio` (que exige rol admin verificado, `_shared/adminGuard.ts`), así que el trigger usa la Service Role key guardada en Supabase Vault para saltarse esa restricción.

### Qué pasa si un dato se actualiza en un lado y no en el otro
No hay garantía automática **excepto para 3 casos puntuales**, todos implementados como sincronización unidireccional explícita, nunca bidireccional automática:

1. **Alta/corrección de DNI en el Admin → cuenta de la PWA**: automático, vía el trigger de arriba. Si el `POST` a la Auth Admin API falla (ej. Vault sin el secret cargado, línea 67-70) solo hace `raise warning` — **el INSERT/UPDATE de `socios` igual se guarda como exitoso**, sin que el admin vea ningún error en pantalla. El socio queda con su ficha completa en el panel pero sin poder loguearse en la PWA, y nada se lo avisa a nadie.
2. **Créditos/vencimiento del Admin → `user_credits` de la PWA**: `sincronizarCreditosPwa` / `sincronizarVencimientoPwa` / `sincronizarVencimientoCreditoPwa` en `PAGINA SUPABASE/src/utils/creditosPwa.js:129, 245, 294`. Resuelve el `user_id` por DNI y, si falla, por email (`resolverUserId`, líneas 42-61) — con un comentario explícito de que esto existe porque ~750 socios de una migración vieja de "Crossfy" no tenían DNI cargado. Si ninguno matchea, la función devuelve un estado (`'socio_no_registrado'` o similar) que el llamador debe interpretar — **no lanza excepción**, así que un caller que no chequee el resultado no se entera de que la sincronización no pasó nada.
3. **Teléfono editado en la PWA → `socios.telefono` del Admin**: RPC `sincronizar_telefono_a_socio`, llamada desde `greenfit-app/src/screens/user/ProfileScreen.tsx:189`. Es la ÚNICA dirección de sync de teléfono que existe — si el admin edita el teléfono desde `NuevoSocioModal.jsx`, **no hay ningún mecanismo que empuje ese cambio hacia `profiles.phone`** de la PWA. La sincronización de teléfono es de un solo sentido (PWA → Admin), pese a que ambos lados tienen UI para editarlo.

### Punto ciego real: nomenclatura de disciplinas como vector de desincronización
`disciplines.name` tiene una unique constraint **case-sensitive** (`supabase-schema.sql:61`), pero `socios.plan` es texto libre cargado a mano (histórico) y el código lo resuelve con `ilike` (`resolverDisciplinaId`, `creditosPwa.js:78-98`). Esto ya causó al menos un incidente real documentado en el propio código (el comentario de `creditosPwa.js:66-77` narra el caso "Kickstrike" vs "kickstrike" como dos filas distintas para Postgres pero ambiguas para `ilike`). La función ya fue endurecida para elegir la coincidencia exacta o la fila más antigua cuando hay ambigüedad — pero es una mitigación en tiempo de lectura, no una prevención en tiempo de escritura: nada impide que se vuelva a crear una fila duplicada en `disciplines` con otra variante de mayúsculas.

---

## 4. WEBHOOK DE MERCADO PAGO

**Ubicación:** `greenfit-app/supabase/functions/mp-webhook/index.ts` (87 líneas), apoyado en `_shared/mercadopago.ts` y llamando a la RPC `mp_process_payment` (definida en `greenfit-app/backend/supabase_migration_planes_combos.sql`).

### Paso a paso real (`mp-webhook/index.ts:25-86`)
1. Recibe el POST de MP (o un GET con query params — `extractPaymentId` soporta ambos formatos de notificación).
2. Extrae el `paymentId` del body/URL. Si no lo encuentra, responde `200 {ignored:true}` (línea 42-44) — **a propósito**: el comentario de cabecera (líneas 21-24) explica que MP reintenta agresivamente cualquier respuesta no-2xx, así que un evento "no aplica" se confirma igual para no generar reintentos infinitos.
3. **Nunca confía en el body del webhook.** Vuelve a pedir el pago real contra la API de MP (`fetchMpPayment`, línea 52) usando el `MP_ACCESS_TOKEN` propio guardado en los secrets de la Edge Function — el `status`/monto que importa es el de esa respuesta, no el del payload entrante (comentario explícito, líneas 13-19). Esto cierra el vector de "cualquiera manda un POST fingiendo un pago aprobado".
4. Parsea el `external_reference` del pago (contiene `user_id`, `pack_id`, y el desglose de créditos/Aparatos armado en `create-payment-preference` al momento de generar la preferencia — nunca en el webhook).
5. Busca el nombre real del pack (`packs.name`) para el historial.
6. Llama a `mp_process_payment` (RPC `security definer`, corre con Service Role) con el status real de MP.
7. Devuelve `200` si todo salió bien, `500` si la RPC devolvió error (para que MP sí reintente en ese caso — es un fallo real, no un "no aplica").

### ¿Hay control de idempotencia? **Sí, y está bien implementado.**
`greenfit-app/backend/supabase_migration_planes_combos.sql` (función `mp_process_payment`):
- Índice único: `create unique index idx_pagos_socio_mp_payment_id on pagos_socio (mercado_pago_payment_id) where mercado_pago_payment_id is not null` — dos filas para el mismo pago son imposibles a nivel de base, no solo de código.
- `insert into pagos_socio (...) on conflict (mercado_pago_payment_id) do nothing` — la primera notificación gana la fila.
- Si la fila ya existía (segunda notificación del mismo pago, algo que MP hace seguido), se relee esa fila puntual con `for update` **antes** de decidir si corresponde acreditar — esto serializa dos webhooks casi simultáneos para el mismo `payment_id` (uno espera a que el otro termine su transacción, en vez de correr en paralelo y potencialmente duplicar el crédito).
- El crédito solo se otorga en la transición real hacia `estado = 'pagado'`, nunca si el estado previo ya era `'pagado'` — una notificación repetida de un pago ya aprobado no vuelve a sumar créditos.
- Soporta combos multi-disciplina: loopea `p_creditos` (jsonb) y acredita cada disciplina por separado, cada una sumando sobre el balance previo de esa disciplina puntual (no pisa el balance entero).

**Detalle no crítico pero real:** existe una **segunda versión** de `mp_process_payment`, con una firma distinta (`p_discipline_id uuid, p_credits int, p_duration_days int` en vez de `p_creditos jsonb, p_incluye_aparatos boolean...`), definida en `greenfit-app/backend/supabase_migration_mercadopago_payments.sql:47-131`. Postgres permite funciones sobrecargadas (mismo nombre, distinta firma) — como ningún archivo hace `drop function` de la versión vieja, **es muy probable que ambas versiones coexistan hoy en producción**, con la vieja sin ningún caller real (`mp-webhook/index.ts` solo llama a la firma nueva, con `p_creditos`). No es un riesgo de seguridad ni de datos, pero es código muerto en la base que puede confundir a futuro a quien audite `\df mp_process_payment`.

---

## 5. LÓGICA DE NEGOCIO — ESTADO REAL

| Regla | Estado | Evidencia |
|---|---|---|
| **Asistencia automática por NOW()** | ✅ Implementado | Admin: `fetchHistorialAsistencias` en `PAGINA SUPABASE/src/utils/fichaSocioPwa.js` filtra por `booking_date <= hoy` (no por `attended`) — cualquier `booking` con fecha pasada que sigue existiendo (no fue cancelado) se marca `'Asistió'`. PWA: mismo criterio en `greenfit-app/src/screens/user/HistoryScreen.tsx` (la query trae solo `booking_date <= hoy` y el render ya no distingue por `attended`). La razón de fondo por la que esto es válido: `cancel_booking()` **borra** la fila de `bookings` al cancelar (`supabase-schema.sql:317-321`), así que cualquier fila que sigue existiendo con fecha pasada, por definición, nunca se canceló. |
| **Reintegro de crédito al cancelar dentro del tiempo de gracia** | ⚠️ Implementado, pero el "tiempo de gracia" está **hardcodeado**, no sale de `configuracion` | La lógica atómica (lock `for update`, reversión solo si corresponde) está bien: `cancel_booking()` en `supabase-schema.sql:293-341` y `backend/supabase_migration_cancel_booking_2h.sql:21-69`. Pero la ventana está fija en el código SQL: `v_dentro_del_limite := now() <= (v_class_start - interval '2 hours')` (línea 43 de ese archivo) — **literal, no lee ninguna columna de `configuracion`**. El Admin tiene una UI real y funcional para cambiar ese valor (`Configuracion.jsx:12, 114`, campo "Tiempo de gracia" en minutos), pero cambiarlo ahí **no tiene ningún efecto sobre lo que la RPC realmente aplica** — es una configuración que aparenta funcionar y no hace nada. Ver Punch List #4. |
| **Bloqueo de historial/métricas si falta perfil obligatorio (sin bloquear reservas)** | ✅ Implementado, correctamente no-bloqueante | `tienePerfilCompleto()` en `greenfit-app/src/context/AuthContext.tsx:35-51` exige `full_name, dni, email, phone, emergency_contact_phone, domicilio`. El gate real vive en `greenfit-app/src/navigation/ProfileStack.tsx:62` (`bloqueado = !!user && !user.perfilCompleto`) — restringe la navegación **dentro de la pestaña Perfil únicamente** (fuerza a entrar directo a "Mis datos" y bloquea Historial/Progreso ahí adentro). `MainTabs.tsx:44` solo usa `perfilCompleto` para decidir la pestaña inicial al loguearse (`initialRouteName`), nunca para bloquear Inicio/Agenda/Mi Rutina/Comunidad — confirmado también por el test `perfil-obligatorio.spec.ts:42` ("el resto de la app queda 100% accesible"). |
| **Filtrado de horarios pasados + orden cronológico + cupos reales sincronizados en la agenda PWA** | ✅ Implementado (trabajo de esta misma sesión) | `greenfit-app/src/lib/classesApi.ts`: el `SELECT` a `classes` ya pide `order('start_time', ascending: true)`; al final de `loadClassesForDate()` se filtran las ocurrencias de **hoy** cuyo `startAt` ya pasó (comparado contra `new Date()`), dejando intactos los demás días del selector. Los cupos (`bookedCount`) se leen vía el RPC `get_bookings_count_por_clase` (`PAGINA SUPABASE/supabase_migration_bookings_count_rpc.sql`) en vez de un `SELECT` directo a `bookings` — porque la policy RLS de esa tabla (`auth.uid() = user_id or is_admin()`) solo dejaba ver al propio socio sus propias reservas, causando el "0 de X cupos" real reportado mientras el Admin (que sí bypasea esa policy) veía el número correcto. La confirmación antes de reservar (`BookingConfirmModal.tsx`) también se agregó en esta sesión. |

---

## 6. INCONSISTENCIAS Y CÓDIGO SOSPECHOSO

### Nomenclatura de disciplinas
- El código de aplicación (JS/TS) está limpio hoy: no quedan referencias vivas a "Kickboxing"/"Musculación"/"Crosstraining" fuera de comentarios que documentan el fix histórico.
- **Sí queda deuda a nivel de nombres de funciones/RPCs**: `otorgarCheckinMusculacion()` (`PAGINA SUPABASE/src/utils/fichaSocioPwa.js:353`) llama a la RPC `admin_otorgar_checkin_musculacion` (definida así en al menos 4 migraciones distintas, ej. `supabase_migration_hoy_entrene.sql`, `supabase_migration_xp_disciplina.sql`). Funcionalmente apunta a "Aparatos" (la disciplina renombrada), pero el identificador sigue diciendo "musculacion" — no rompe nada, pero es ruido cognitivo para cualquiera que lea el código nuevo sin el contexto histórico.

### Duplicación de lógica
- La regla de validación de DNI (`^\d{6,10}$`) está implementada **dos veces de forma independiente**, sin ninguna fuente común: en JS (`greenfit-app/src/lib/dni.ts:8`) y en SQL (`handle_socio_dni_upsert()`, `supabase_migration_socios_auto_auth.sql:53`). Si algún día cambia el formato válido de DNI en un lado, nada obliga a actualizar el otro.
- **El Dashboard Admin no valida el formato de DNI en ningún lado** (`NuevoSocioModal.jsx`, `Socios.jsx` no tienen ningún chequeo de formato antes de guardar). Un DNI mal tipeado se guarda sin error visible, y el trigger de auto-provisioning simplemente no dispara (`return NEW` silencioso, sección 3) — el socio queda sin cuenta de PWA sin que nadie se entere.
- "2 horas de tolerancia para cancelar" está hardcodeado de forma independiente en **dos funciones SQL** (`cancel_booking` y `admin_cancel_booking`, ambas en `supabase-schema.sql`) — mismo valor, dos lugares, sin ninguna función/constante compartida. Ver también el hallazgo de la sección 5 (ni siquiera lee `configuracion`).

### Funciones sin manejo de errores en operaciones críticas
No se encontraron `try/catch` faltantes en los paths más críticos revisados (`create-payment-preference/index.ts`, `mp-webhook/index.ts`, `cancel_booking`/`book_class` en SQL) — estos están bien cubiertos. Lo que sí se encontró, más sutil que un `try/catch` faltante:
- `resolverUserId()` y `resolverDisciplinaId()` (`creditosPwa.js:42-98`) **absorben el error y devuelven `null`** en vez de propagarlo — documentado y a propósito (el comentario explica que "socio no registrado todavía" es un estado válido, no una falla técnica), pero exige que **todo caller** revise ese `null` explícitamente; no hay ningún tipo o chequeo que lo fuerce a nivel de compilador (el repo es JS, no TS, en este archivo puntual).
- `handle_socio_dni_upsert()` silencia con `raise warning` (no `raise exception`) si falta el secret de Vault (línea 67-70) — la fila de `socios` se guarda igual, el fallo de aprovisionamiento de cuenta queda invisible para el admin.

### Hardcodeos que deberían salir de `configuracion`
- **Tiempo de gracia de cancelación**: `interval '2 hours'` literal en `cancel_booking`/`admin_cancel_booking` (ver sección 5) — el peor de estos casos, porque además hay una UI que aparenta controlarlo.
- **Montos de XP**: "+100 XP al reservar", "-100 XP al cancelar" están como literales dentro de cada función (`book_class`, `cancel_booking`, `admin_book_class`, `admin_cancel_booking` en `supabase_migration_xp_reserva.sql`) — decisión documentada como consciente en el propio archivo (mismo criterio que el resto de las reglas de XP), pero sigue siendo 4 lugares distintos con el mismo número mágico en vez de una constante.
- **Vigencia de créditos comprados por Mercado Pago**: `now() + interval '30 days'` hardcodeado dentro de `mp_process_payment` (`supabase_migration_planes_combos.sql`) — no configurable desde ningún panel, a diferencia de `dias_vigencia` que sí es dinámico para las membresías tipo Aparatos dentro del mismo pack.

### Credenciales de acceso a la PWA
`email = dni + '@greenfit.com'`, `password = dni` (`handle_socio_dni_upsert()`, sección 3) — confirmado también en `LoginScreen.tsx:10` ("por default, la contraseña también es su DNI") y en el propio fixture de tests E2E (`e2e/support/auth.ts:23`, que usa el mismo DNI para usuario y contraseña). **No se encontró ningún flujo de cambio de contraseña obligatorio ni opcional** en la PWA (`grep` de "cambiar contraseña"/`updatePassword` solo devuelve el comentario de `LoginScreen.tsx`). Ver Punch List #3.

### Legacy / código muerto
- `greenfit-app/backend/schema.sql` (58 líneas) describe un modelo totalmente distinto y viejo (`users`, `user_packs`, `schedules`) que no coincide con el schema real (`supabase-schema.sql`). Si alguien nuevo en el equipo lee este archivo primero, se arma un modelo mental incorrecto del sistema.
- La segunda versión de `mp_process_payment` (sección 4) es, con alta probabilidad, una función huérfana en producción.

---

## 7. PUNCH LIST PRIORIZADA

1. **`configuracion` sigue con `UPDATE ... to anon using (true)`** (Sección 2, Hallazgo #1) — cualquiera con la anon key (pública por diseño, embebida en el bundle JS) puede reescribir alias/CBU de transferencias, precios y el banner global directo contra la REST API, sin pasar por ningún login. Es el hallazgo de mayor impacto potencial (fraude financiero directo) de toda la auditoría.

2. **Contraseña de la PWA = DNI del socio, sin flujo de cambio** (Sección 6) — el DNI no es un secreto (se comparte con el gimnasio, familiares, y en Argentina el rango de números es predecible). Cualquiera que conozca el DNI de otro socio puede loguearse como esa persona y ver/operar su cuenta completa (reservas, cancelar clases ajenas consumiendo o liberando créditos reales, datos de perfil).

3. **`asistencias` nunca cerró su policy `to anon` de INSERT/UPDATE/DELETE** (Sección 2, Hallazgo #2) — mismo patrón que el punto 1 pero sobre una tabla que sí se usa en producción hoy (Admin y PWA la leen). Se cerró para `socios`/`classes` en `admin_auth_rls.sql` pero se olvidó esta tabla.

4. **El "tiempo de gracia" de cancelación configurable en el Admin no hace nada** (Sección 5 y 6) — `cancel_booking`/`admin_cancel_booking` tienen `interval '2 hours'` hardcodeado; el campo "Tiempo de gracia" de `Configuracion.jsx` escribe a una columna que la RPC nunca lee. Es un bug de confianza: Seba puede creer que cambió la regla de reintegros y en realidad no cambió nada.

5. **Esquema real de producción probablemente divergió del código versionado** (Sección 2) — `configuracion.limite_cancelacion_minutos`/`alias_cvu` (usados en `Configuracion.jsx`) no existen en ningún `CREATE`/`ALTER TABLE` versionado; la tabla `socios` no tiene ningún `CREATE TABLE` en el repo; la policy pública de `disciplines` fue diagnosticada como "configurada a mano en el dashboard, sin migración rastreada" (comentario propio de `disciplines_select_publico.sql:16`). Sin una fuente de verdad versionada, cualquier auditoría o rollback futuro depende de memoria humana, no de git.

6. **No hay validación de formato de DNI en el Admin** (Sección 6) — un DNI mal cargado falla en silencio: se guarda el socio, pero el trigger de auto-provisioning de cuenta PWA no dispara y nadie lo nota hasta que el socio dice "no puedo entrar a la app".

7. **Sincronización de teléfono Admin → PWA no existe** (solo PWA → Admin, Sección 3) — si Seba corrige un teléfono desde el panel, el socio sigue viendo (y usando, si aplica) el teléfono viejo en su propio perfil de la PWA.

8. **Segunda versión huérfana de `mp_process_payment`** (Sección 4) — no es explotable ni corrompe datos hoy (nada la llama), pero es un riesgo latente: si algún día alguien reintroduce una llamada con la firma vieja (4 parámetros escalares en vez de jsonb), correría contra una versión de la lógica que no sabe de combos ni de los checks más nuevos.

9. **Versiones de `@supabase/supabase-js` desalineadas entre repos** (2.111.0 vs 2.45.4, Sección 1) — no es un bug hoy, pero aumenta la chance de que un fix/breaking-change de la librería se comporte distinto en Admin vs PWA sin que nadie lo note hasta que falle en producción.

10. **`schema.sql` legacy conviviendo con el schema real** (Sección 6) — bajo riesgo pero costo real de onboarding: describe un modelo de datos que ya no existe (`users`, `user_packs`, `schedules`) en el mismo directorio que el schema verdadero.

---

**Auditoría guardada en `AUDITORIA_GREENFIT.md`.**
