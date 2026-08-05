// Selector de días para franjas horarias de Disciplinas -- semana COMPLETA
// (incluye Domingo), a diferencia de DIAS_SEMANA de utils/clases.js
// (Lun-Sáb, porque el gimnasio históricamente no carga clases por crédito
// los domingos). Acá se está describiendo cualquier horario posible, no el
// flujo de reserva de clases existente -- no se toca DIAS_SEMANA para no
// cambiar el fallback de diaActualPorDefecto() en otras pantallas.
export const DIAS_SEMANA_COMPLETA = [
  { numero: 1, corta: 'L', nombre: 'Lunes' },
  { numero: 2, corta: 'Ma', nombre: 'Martes' },
  { numero: 3, corta: 'Mi', nombre: 'Miércoles' },
  { numero: 4, corta: 'J', nombre: 'Jueves' },
  { numero: 5, corta: 'V', nombre: 'Viernes' },
  { numero: 6, corta: 'S', nombre: 'Sábado' },
  { numero: 0, corta: 'D', nombre: 'Domingo' },
]

const ORDEN_SEMANA = [1, 2, 3, 4, 5, 6, 0] // arranca en lunes
const DIAS_LARGOS = { 0: 'Dom', 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie', 6: 'Sáb' }

function formatearHora(t) {
  return (t ?? '').slice(0, 5)
}

// Colapsa un set de días en algo legible: 3+ consecutivos se muestran como
// rango ("Lun a Vie"), el resto separado por coma ("Lun, Mié, Vie") -- mismo
// criterio (a propósito) que usa greenfit-site/index.html en su sección
// "Elegí tu ritmo", para que la tarjeta del admin muestre la MISMA lectura
// que ve un visitante de la landing.
export function formatearRangoDias(diasSet) {
  const dias = ORDEN_SEMANA.filter((d) => diasSet.has(d))
  if (dias.length === 0) return ''
  const grupos = []
  let actual = [dias[0]]
  for (let i = 1; i < dias.length; i += 1) {
    const prevIdx = ORDEN_SEMANA.indexOf(actual[actual.length - 1])
    const curIdx = ORDEN_SEMANA.indexOf(dias[i])
    if (curIdx === prevIdx + 1) {
      actual.push(dias[i])
    } else {
      grupos.push(actual)
      actual = [dias[i]]
    }
  }
  grupos.push(actual)
  return grupos
    .map((g) => (g.length >= 3 ? `${DIAS_LARGOS[g[0]]} a ${DIAS_LARGOS[g[g.length - 1]]}` : g.map((d) => DIAS_LARGOS[d]).join(', ')))
    .join(', ')
}

// Agrupa filas de `classes` por rango horario EXACTO (mismo start/end),
// uniendo los días en los que se repite -- así una disciplina con 2 turnos
// distintos (ej. mañana y noche) muestra 2 líneas en vez de mezclar los días
// de ambas en una sola.
export function agruparClasesPorBloqueHorario(clases) {
  const bloques = new Map()
  for (const c of clases ?? []) {
    const key = `${c.start_time}|${c.end_time}`
    if (!bloques.has(key)) bloques.set(key, { start: c.start_time, end: c.end_time, dias: new Set() })
    const bloque = bloques.get(key)
    for (const d of c.days_of_week ?? []) bloque.dias.add(d)
  }
  return [...bloques.values()].sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
}

// "Lun, Mié, Vie — 17:00 a 18:00 hs"
export function formatearFranjaHoraria(bloque) {
  const dias = formatearRangoDias(bloque.dias)
  const rango = bloque.end ? `${formatearHora(bloque.start)} a ${formatearHora(bloque.end)} hs` : `${formatearHora(bloque.start)} hs`
  return dias ? `${dias} — ${rango}` : rango
}
