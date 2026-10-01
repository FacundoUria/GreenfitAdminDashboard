// ETAPA 4, PARTE B -- "¿cuándo vence el plan de este socio?", la fecha
// general que ve Seba ("Por vencer" en Home/Socios, sugerencias al cobrar).
//
// BUG: esos lugares leían `socios.fecha_vencimiento` directo. Esa columna
// solo se actualiza bien cuando el socio tiene Aparatos; para un socio de
// SOLO CRÉDITOS queda vieja o vacía (un pago por la app no la toca) -- nunca
// aparecía en "Por vencer", y al cobrarle el modal decía "el socio está
// vencido" estando al día.
//
// Ahora la fecha se CALCULA desde lo real (user_credits), con el mismo
// criterio que la PWA (resolverFechaPlan) y que resolver_fecha_plan_actual()
// en la base: la fecha MÁS LEJANA entre todo lo activo. La columna queda
// solo como respaldo para quien no tiene cuenta en la app.

const ZONA_ARGENTINA = 'America/Argentina/Mendoza'

// Timestamp de user_credits.expires_at -> día calendario de Argentina
// ("YYYY-MM-DD"), comparable con socios.fecha_vencimiento (columna `date`).
function diaArgentinaISO(timestamp) {
  const fecha = new Date(timestamp)
  if (Number.isNaN(fecha.getTime())) return null
  // 'en-CA' formatea como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_ARGENTINA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha)
}

const espejo = (socio) => socio?.fecha_vencimiento ?? socio?.fechaVencimiento ?? null

// Fecha de vencimiento VIGENTE del plan del socio ("YYYY-MM-DD"), o null si
// no tiene nada activo.
//
// `socio`: fila de `socios` (cruda o mapeada por Socios.jsx) ya mergeada con
//   - creditosPwaPorDisciplina: [{ lotes: [{ expiresAt }] }] (solo lotes activos)
//   - aparatosVigenteReal: TRI-ESTADO (true | false | undefined)
//   - membresiasVigentes: [{ expiresAt }] (opcional)
//
// - SIN cuenta en la app (`aparatosVigenteReal === undefined`): no hay
//   ninguna fila real posible -- se devuelve la columna tal cual (vigente o
//   no), es la única fuente. Mismo criterio que estadoOperativoSocio().
// - CON cuenta: la fecha más lejana entre los lotes de créditos activos y la
//   membresía real vigente. La columna NO se mira (puede ser una fecha vieja
//   o fantasma), salvo como respaldo de la fecha de Aparatos cuando ya está
//   confirmado que Aparatos está vigente pero no vino su fecha real.
export function fechaPlanSocio(socio) {
  if (!socio) return null
  if (socio.aparatosVigenteReal === undefined) return espejo(socio)

  const fechas = []
  for (const entrada of socio.creditosPwaPorDisciplina ?? []) {
    for (const lote of entrada.lotes ?? []) {
      if (lote.expiresAt) fechas.push(diaArgentinaISO(lote.expiresAt))
    }
  }
  const membresias = (socio.membresiasVigentes ?? []).filter((m) => m.expiresAt)
  for (const m of membresias) fechas.push(diaArgentinaISO(m.expiresAt))
  if (socio.aparatosVigenteReal === true && membresias.length === 0 && espejo(socio)) fechas.push(espejo(socio))

  const validas = fechas.filter(Boolean)
  // Strings ISO del mismo largo: el orden alfabético es el cronológico.
  return validas.length > 0 ? validas.reduce((max, f) => (f > max ? f : max)) : null
}

// Días de calendario desde hoy hasta que vence el plan (0 = vence hoy), o
// null si el socio no tiene ninguna fecha. Para "Por vencer".
export function diasHastaVencimientoPlan(socio, ahora = new Date()) {
  const fecha = fechaPlanSocio(socio)
  if (!fecha) return null
  const vencimiento = new Date(`${fecha}T00:00:00`)
  const msPorDia = 1000 * 60 * 60 * 24
  return Math.ceil((vencimiento.getTime() - ahora.getTime()) / msPorDia)
}

// Fecha desde la que se parte al COBRAR (RegistrarPagoModal): el vencimiento
// vigente real si lo hay; si no hay nada vigente, la última fecha conocida
// SOLO si ya pasó (para poder decir "venció el ..."). Una fecha futura de la
// columna sin nada real detrás (fantasma) no cuenta: se devuelve null y el
// cobro arranca desde hoy.
export function fechaVencimientoParaCobro(socio, hoy) {
  const vigente = fechaPlanSocio(socio)
  if (vigente) return vigente
  const ultima = espejo(socio)
  return ultima && ultima < hoy ? ultima : null
}
