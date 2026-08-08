import { supabase } from '../lib/supabaseClient'

const DIAS_VIGENCIA_CREDITOS = 30

// La cuenta de la app de socios se auto-provisiona por DNI (trigger
// on_socio_dni_upsert). Si el socio no tiene DNI o esa cuenta todavía no
// se creó, no hay a quién sincronizarle los créditos.
async function resolverUserId(dni) {
  if (!dni) return null
  const { data } = await supabase.from('profiles').select('id').eq('dni', dni).maybeSingle()
  return data?.id ?? null
}

// ilike a propósito: `plan` es texto libre cargado por el staff y no
// siempre calza en mayúsculas/minúsculas con `disciplines.name`.
async function resolverDisciplinaId(nombrePlan) {
  if (!nombrePlan) return null
  const { data } = await supabase.from('disciplines').select('id').ilike('name', nombrePlan).maybeSingle()
  return data?.id ?? null
}

// La app de socios (PWA) consulta su propia tabla `user_credits` para saber
// si puede reservar -- totalmente separada de `socios.creditos`, que es solo
// para la vista del panel admin. Esta función es el puente entre ambas.
//
// Recibe un DELTA (no el total nuevo): la app puede haber consumido créditos
// reservando clases desde la última vez que se cargó un pago acá, así que el
// balance real de la PWA puede no coincidir con `socios.creditos` -- sumar
// el delta sobre el balance actual de la PWA es lo único que no pisa ese uso.
export async function sincronizarCreditosPwa({ dni, disciplina, delta }) {
  const userId = await resolverUserId(dni)
  if (!userId) return { synced: false, reason: 'sin_cuenta_pwa' }

  const disciplineId = await resolverDisciplinaId(disciplina)
  if (!disciplineId) return { synced: false, reason: 'disciplina_no_encontrada' }

  const { data: actual } = await supabase
    .from('user_credits')
    .select('remaining_credits')
    .eq('user_id', userId)
    .eq('discipline_id', disciplineId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const nuevoBalance = Math.max(0, (actual?.remaining_credits ?? 0) + delta)

  const { error } = await supabase.from('user_credits').insert({
    user_id: userId,
    discipline_id: disciplineId,
    remaining_credits: nuevoBalance,
    expires_at: new Date(Date.now() + DIAS_VIGENCIA_CREDITOS * 86_400_000).toISOString(),
  })

  if (error) {
    console.error('ERROR user_credits INSERT SUPABASE (créditos):', {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    })
    return { synced: false, reason: 'error_supabase' }
  }
  return { synced: true }
}

// El pase de Aparatos / Musculación (y "Pase Libre", que es el mismo acceso
// libre sin créditos ni turnos -- ver planes.js) vence por fecha, no se
// consume por reserva. A diferencia de sincronizarCreditosPwa, acá SÍ
// pisamos con el valor absoluto que calculó el admin: no hay uso del lado
// de la PWA que pueda desincronizarse (nadie "gasta" días de membresía
// reservando una clase), la fecha de vencimiento siempre sale de una sola
// fuente de verdad (el ciclo de pago/edición directa que gestiona el admin).
//
// `disciplina` es el nombre del plan tal cual está en `socios.plan` (ej.
// "Aparatos / Musculación") -- se resuelve por nombre igual que
// sincronizarCreditosPwa, en vez de asumir "la única disciplina kind=
// membership que exista" (esa asunción era el bug real: se rompe apenas
// haya una segunda disciplina por vencimiento en `disciplines`). Si el
// nombre no matchea ninguna fila (ej. "Pase Libre" es una etiqueta legado
// que nunca tuvo su propia fila en `disciplines`), cae al fallback viejo
// -- sigue funcionando igual que antes para ese caso, no se pierde nada.
export async function sincronizarVencimientoPwa({ dni, disciplina, fechaVencimiento }) {
  const userId = await resolverUserId(dni)
  if (!userId) return { synced: false, reason: 'sin_cuenta_pwa' }

  let disciplineId = await resolverDisciplinaId(disciplina)
  if (!disciplineId) {
    const { data: fallback } = await supabase
      .from('disciplines')
      .select('id')
      .eq('kind', 'membership')
      .limit(1)
      .maybeSingle()
    disciplineId = fallback?.id ?? null
  }
  if (!disciplineId) return { synced: false, reason: 'disciplina_no_encontrada' }

  // Mediodía local en vez de medianoche: evita que la conversión a UTC que
  // hace timestamptz corra la fecha un día para atrás/adelante según el
  // huso horario del navegador que ejecuta esto.
  const expiresAt = new Date(`${fechaVencimiento}T12:00:00`).toISOString()

  const { error } = await supabase.from('user_credits').insert({
    user_id: userId,
    discipline_id: disciplineId,
    remaining_credits: null,
    expires_at: expiresAt,
  })

  if (error) {
    console.error('ERROR user_credits INSERT SUPABASE (vencimiento):', {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    })
    return { synced: false, reason: 'error_supabase' }
  }
  return { synced: true }
}

// Baja lógica: `profiles.active` es lo que de verdad bloquea el login y las
// reservas (AuthContext y el RPC book_class lo chequean del lado servidor);
// `socios.activo` es solo el reflejo de esto en el panel admin. Sin este
// puente, dar de baja a alguien acá no le impediría seguir usando la PWA.
export async function sincronizarEstadoCuentaPwa({ dni, activo }) {
  const userId = await resolverUserId(dni)
  if (!userId) return { synced: false, reason: 'sin_cuenta_pwa' }

  const { error } = await supabase.from('profiles').update({ active: activo }).eq('id', userId)
  if (error) {
    console.error('ERROR profiles UPDATE SUPABASE (baja/reactivación):', {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    })
    return { synced: false, reason: 'error_supabase' }
  }
  return { synced: true }
}
