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
// - Con fecha de vencimiento: 'activo' si vencimiento >= hoy, 'vencido' si
//   ya pasó (calcularEstadoCuota ya resuelve esto -- CAMBIO 1, sin ninguna
//   ventana de tolerancia de por medio).
// - SIN fecha de vencimiento (nunca tuvo Aparatos -- socio 100% créditos, o
//   recién dado de alta sin nada cargado todavía): 'activo' SOLO si tiene
//   al menos un crédito real vigente en alguna disciplina; si no, 'inactivo'.
//   CAMBIO 3 (bug real: "Activo" con Plan/Créditos/Vencimiento vacíos) --
//   ANTES el default acá era 'activo' a ciegas, sin mirar si el socio tenía
//   un solo crédito real -- un socio de créditos que gastó todo y nunca
//   tuvo Aparatos (sin fecha_vencimiento para caer a 'vencido') quedaba
//   "Activo" para siempre. Requiere que el caller haya mergeado
//   `socio.creditosPwaPorDisciplina` (ver fetchCreditosPorDisciplina); sin
//   ese dato (undefined) cae a 'inactivo' por seguridad, nunca al viejo
//   default optimista.
//
// Acepta tanto filas crudas de Supabase (`fecha_vencimiento`, snake_case)
// como el objeto ya mapeado que arma Socios.jsx (`fechaVencimiento`,
// camelCase) -- así las tres pantallas pueden llamar exactamente la misma
// función sin tener que normalizar el shape antes.
export function estadoOperativoSocio(socio, fechaReferencia = new Date()) {
  if (socio.activo === false) return 'inactivo'
  const fechaVencimiento = socio.fecha_vencimiento ?? socio.fechaVencimiento ?? null
  const estadoPorFecha = calcularEstadoCuota(fechaVencimiento, fechaReferencia)
  if (estadoPorFecha) return estadoPorFecha
  return tieneCreditosActivosReal(socio.creditosPwaPorDisciplina) ? 'activo' : 'inactivo'
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
