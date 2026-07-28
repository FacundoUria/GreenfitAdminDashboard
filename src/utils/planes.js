export const PLANES_DISPONIBLES = ['CrossFit', 'Boxeo', 'Kickstrike', 'Aparatos / Musculación']
export const PLANES_DE_CREDITOS = ['crossfit', 'boxeo', 'kickstrike']

const PRECIO_POR_PLAN = {
  crossfit: 'precio_crossfit',
  boxeo: 'precio_boxeo',
  kickstrike: 'precio_kickstrike',
  'aparatos / musculación': 'precio_aparatos',
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

export function tienePlanDeVencimiento(plan) {
  return normalizarPlanes(plan).some((p) => !PLANES_DE_CREDITOS.includes((p ?? '').toLowerCase()))
}

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
