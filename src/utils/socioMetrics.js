import { calcularEstadoCuota } from './fecha'

// Mismo criterio que tieneCreditosActivos() en components/SociosTabla.jsx
// (duplicado a propósito -- utils/ no importa de components/, mismo patrón
// que ya existe entre SociosTabla.jsx y NuevoSocioModal.jsx para
// aparatosActivoReal()): alcanza con que UNA disciplina tenga saldo > 0 --
// `creditosPwaPorDisciplina` ya viene filtrado a "lotes activos" (con saldo
// Y sin vencer), ver fetchCreditosPorDisciplina en utils/fichaSocioPwa.js.
function tieneCreditosActivosReal(creditosPwaPorDisciplina) {
  return (creditosPwaPorDisciplina ?? []).some((c) => (c.remainingCredits ?? 0) > 0)
}

// Fuente ÚNICA de verdad para "¿este socio está Activo, Vencido o
// Inactivo?" -- Home.jsx, Socios.jsx y Reportes.jsx llaman a esta MISMA
// función (nunca reimplementan el criterio), así los números de las tres
// pantallas coinciden siempre.
//
// Reglas (únicas, válidas para toda la app):
// - Dado de baja (`activo === false`): 'inactivo' -- aparte de
//   Activo/Vencido, no se mezcla con el estado de pago.
// - Con al menos un crédito real vigente en alguna disciplina, O Aparatos
//   con una fila real vigente en user_credits: 'activo', SIEMPRE -- sin
//   importar qué diga fecha_vencimiento (ver BUG REAL x2 abajo).
// - Si no hay nada real, pero fecha_vencimiento existe y ya pasó: 'vencido'
//   (calcularEstadoCuota -- CAMBIO 1, sin ninguna ventana de tolerancia).
//   Una fecha_vencimiento FUTURA sin nada real detrás YA NO cuenta como
//   'activo' -- ver el segundo BUG REAL, es justo el caso que había que
//   dejar de confiar.
// - Sin nada de lo anterior (nunca tuvo Aparatos NI créditos reales, o
//   recién dado de alta sin nada cargado todavía): 'inactivo'.
//   CAMBIO 3 (bug real: "Activo" con Plan/Créditos/Vencimiento vacíos) --
//   ANTES el default acá era 'activo' a ciegas, sin mirar si el socio tenía
//   un solo crédito real -- un socio de créditos que gastó todo y nunca
//   tuvo Aparatos (sin fecha_vencimiento para caer a 'vencido') quedaba
//   "Activo" para siempre. Requiere que el caller haya mergeado
//   `socio.creditosPwaPorDisciplina` (ver fetchCreditosPorDisciplina); sin
//   ese dato (undefined) cae a 'inactivo' por seguridad, nunca al viejo
//   default optimista.
//
// BUG REAL #1 (filtro "Inactivo" de Socios.jsx mostrando socios con badge
// "Activo", caso real: socio con Aparatos vencido/residual + créditos
// reales vigentes en otra disciplina, ej. CrossFit) -- ANTES, si
// fecha_vencimiento existía, `calcularEstadoCuota` decidía SOLA (activo si
// vigente, vencido si no) sin mirar los créditos para nada -- un socio con
// Aparatos vencido pero CrossFit realmente vigente (créditos y Aparatos NO
// comparten fecha si Aparatos nunca se renovó pero los créditos sí se
// "Fijaron"/ajustaron después, ver admin_fijar_creditos_disciplina --
// nunca toca fecha_vencimiento a propósito) caía a 'vencido' acá, mientras
// EstadoBadge (SociosTabla.jsx) SÍ lo mostraba "Activo" (mira créditos
// reales directo, sin pasar por fecha_vencimiento). Un crédito real vigente
// GANA siempre.
//
// BUG REAL #2, dirección contraria (filtro "Activo" mostrando socios con
// badge "Inactivo", caso real Agustina Aguero DNI 43418750) -- esta función
// SEGUÍA confiando en `calcularEstadoCuota(fecha_vencimiento)` para el
// resultado 'activo' sin confirmar que existiera una fila real de Aparatos
// detrás (mismo "fecha fantasma" ya resuelto en aparatosActivoReal() para
// el checkbox/PlanCell, ver ticket Arianna Isgro, pero nunca aplicado acá).
// Un socio sin ningún crédito real Y sin Aparatos real, pero con
// fecha_vencimiento residual futura (import de CrossFy, campo viejo ya
// eliminado), caía a 'activo' por fecha -- contado como "Activo" en el
// filtro -- mientras EstadoBadge (que exige la fila real) lo mostraba
// "Inactivo".
//
// `socio.aparatosVigenteReal` es TRI-ESTADO (ver fetchAparatosVigentePorDni
// en fichaSocioPwa.js) -- true | false | undefined, NO un booleano simple:
//   - true: fila real vigente confirmada -> 'activo', gana siempre.
//   - false: tiene cuenta PWA CONFIRMADA sin ninguna fila vigente -- una
//     fecha_vencimiento futura fantasma ya NO alcanza para 'activo' (el fix
//     de este ticket); solo importa si esa fecha YA PASÓ, para poder seguir
//     devolviendo 'vencido' en vez de 'inactivo' (Home/Reportes necesitan
//     esa distinción, ver getSocioMetrics).
//   - undefined: el socio NO TIENE cuenta PWA -- no existe ninguna fila de
//     user_credits que pudiera confirmar nada (ej. cobrado 100% por
//     mostrador, Registrar Pago, nunca se registró en la app). Para este
//     caso puntual NO hay "fecha fantasma" posible -- socios.fecha_vencimiento
//     es la ÚNICA fuente de verdad que existe, y se confía en ella
//     COMPLETA (tanto para 'activo' como para 'vencido'), igual que
//     siempre. Tratar este caso igual que `false` rompería Registrar Pago
//     para cualquier socio sin cuenta PWA (caso real: Lucía Paz, plan de
//     vencimiento, nunca se registró en la app).
//
// Acepta tanto filas crudas de Supabase (`fecha_vencimiento`, snake_case)
// como el objeto ya mapeado que arma Socios.jsx (`fechaVencimiento`,
// camelCase) -- así las tres pantallas pueden llamar exactamente la misma
// función sin tener que normalizar el shape antes.
export function estadoOperativoSocio(socio, fechaReferencia = new Date()) {
  if (socio.activo === false) return 'inactivo'
  if (tieneCreditosActivosReal(socio.creditosPwaPorDisciplina)) return 'activo'

  const fechaVencimiento = socio.fecha_vencimiento ?? socio.fechaVencimiento ?? null
  const estadoPorFecha = calcularEstadoCuota(fechaVencimiento, fechaReferencia)

  if (socio.aparatosVigenteReal === true) return 'activo'
  if (socio.aparatosVigenteReal === false) return estadoPorFecha === 'vencido' ? 'vencido' : 'inactivo'
  // aparatosVigenteReal === undefined -- sin cuenta PWA, se confía en la
  // fecha completa (activo o vencido), es la única fuente posible.
  return estadoPorFecha ?? 'inactivo'
}

// Conteos para las tarjetas de KPI de Home, Socios y Reportes -- las tres
// pantallas deben llamar a ESTA función (no reimplementar el filtro) para
// garantizar que muestren exactamente el mismo número.
//
// CAMBIO 2 (simplificar estados de Socios a Activo/Por Vencer/Inactivo) --
// IMPORTANTE: esta función sigue distinguiendo 'vencidos' de 'inactivos'
// internamente -- eso NO cambió y no hay que tocarlo, es lo que le permite a
// Home/Reportes seguir contando bien "Cuota Vencida" aparte de "dados de
// baja". La unificación de la ETIQUETA que ve el admin ("Inactivo" para
// ambos casos) vive solo en el badge de SociosTabla.jsx, una capa de
// presentación por encima de este conteo -- no acá.
export function getSocioMetrics(socios, fechaReferencia = new Date()) {
  const metrics = { activos: 0, vencidos: 0, inactivos: 0 }
  for (const socio of socios ?? []) {
    const estado = estadoOperativoSocio(socio, fechaReferencia)
    if (estado === 'activo') metrics.activos += 1
    else if (estado === 'vencido') metrics.vencidos += 1
    else metrics.inactivos += 1
  }
  return metrics
}
