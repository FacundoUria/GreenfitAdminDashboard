// Nomenclatura estricta (pedido del cliente): "Aparatos / Musculación" se
// unifica a "Aparatos" -- mismo criterio que el rename Kickboxing ->
// Kickstrike, misma migración SQL (supabase_migration_unificar_disciplinas.sql).
export const PLANES_DISPONIBLES = ['Pase Libre', 'CrossFit', 'Boxeo', 'Kickstrike', 'Aparatos']
export const PLANES_DE_CREDITOS = ['crossfit', 'boxeo', 'kickstrike']

const PRECIO_POR_PLAN = {
  crossfit: 'precio_crossfit',
  boxeo: 'precio_boxeo',
  kickstrike: 'precio_kickstrike',
  aparatos: 'precio_aparatos',
}

// `plan` puede venir como texto suelto (dato legacy) o como array (multi-plan).
// Normalizamos acá para que el resto del código no tenga que preguntarse cuál es.
export function normalizarPlanes(plan) {
  if (Array.isArray(plan)) return plan.filter(Boolean)
  return plan ? [plan] : []
}

export function esPlanDeCreditos(plan) {
  return normalizarPlanes(plan).some((p) => PLANES_DE_CREDITOS.includes((p ?? '').toLowerCase()))
}

// Subconjunto de `plan` que son actividades de créditos (no de vencimiento).
// Un socio puede tener más de una (ej: CrossFit + Kickstrike) -- eso es lo
// que obliga a preguntar a qué disciplina van los créditos de un pago,
// porque `creditos` es un solo pozo y no se puede repartir solo.
export function planesDeCreditos(plan) {
  return normalizarPlanes(plan).filter((p) => PLANES_DE_CREDITOS.includes((p ?? '').toLowerCase()))
}

export function tienePlanDeVencimiento(plan) {
  return normalizarPlanes(plan).some((p) => !PLANES_DE_CREDITOS.includes((p ?? '').toLowerCase()))
}

// Subconjunto de `plan` que son actividades por vencimiento (no de créditos)
// -- "Pase Libre" y "Aparatos" son las dos etiquetas posibles hoy, y un
// socio podría (en teoría) tener las dos cargadas. Se usa para
// sincronizar la fecha de vencimiento con la PWA resolviendo la disciplina
// por NOMBRE (igual que planesDeCreditos con los créditos) en vez de
// asumir "la única disciplina de tipo membership que exista" -- esa
// asunción se rompe el día que se cargue una segunda disciplina de ese tipo.
export function planesDeVencimiento(plan) {
  return normalizarPlanes(plan).filter((p) => !PLANES_DE_CREDITOS.includes((p ?? '').toLowerCase()))
}

// "Pase Libre" SÍ es un plan real (membresía de acceso libre a Aparatos,
// sin créditos ni turnos) -- no hay que descartarlo: la
// mayoría de los socios activos lo tienen como su membresía de verdad. Acá
// solo formateamos lo que haya; "Sin plan" es nada más el fallback para un
// `plan` null/vacío de verdad (no debería pasar si se cargó desde el panel,
// que exige elegir al menos uno).
export function formatearPlanes(plan) {
  const lista = normalizarPlanes(plan)
  return lista.length > 0 ? lista.join(', ') : 'Sin plan'
}

// Suma el precio configurado de cada plan que tiene el socio (un socio con
// CrossFit + Aparatos paga ambos). Los planes legacy/desconocidos caen al
// precio de Aparatos como valor por defecto razonable.
export function precioPlanes(plan, configuracion) {
  return normalizarPlanes(plan).reduce((total, p) => {
    const clave = PRECIO_POR_PLAN[(p ?? '').toLowerCase()] ?? 'precio_aparatos'
    return total + Number(configuracion?.[clave] ?? 0)
  }, 0)
}
