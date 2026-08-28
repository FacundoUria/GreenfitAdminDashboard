import { supabase } from '../lib/supabaseClient'

const DIAS_VIGENCIA_CREDITOS = 30

// La cuenta de la app de socios se auto-provisiona por DNI (trigger
// on_socio_dni_upsert) -- ese es el puente de siempre. Pero el import
// masivo de Crossfy (scripts/importar_socios.js) trajo ~750 socios SIN DNI
// cargado (matcheados solo por email en ese script) -- para esos, buscar
// por DNI nunca va a encontrar nada, y antes de este cambio quedaban para
// siempre sin poder sincronizar créditos/vencimiento con la PWA (bug
// reportado: los botones de crédito no tenían ningún balance real sobre el
// que operar). Ahora, si no hay DNI (o no matchea), se intenta por EMAIL
// como respaldo -- mismo criterio que ya usa
// sincronizacion_crossfy_v2.sql para el mismo problema.
async function resolverUserId({ dni, email } = {}) {
  if (dni) {
    const { data } = await supabase.from('profiles').select('id').eq('dni', dni).maybeSingle()
    if (data?.id) return data.id
  }
  if (email) {
    const { data } = await supabase.from('profiles').select('id').ilike('email', email.trim()).maybeSingle()
    if (data?.id) return data.id
  }
  return null
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
//
// `email` es opcional -- respaldo para socios sin DNI cargado (ver
// resolverUserId de arriba). Nunca crashea si algo sale mal: cualquier
// error de red/Supabase se atrapa y se devuelve como `{ synced: false,
// reason: 'error_supabase' }` en vez de dejar una excepción sin capturar.
//
// `fechaVencimiento` es opcional -- si el mismo pago ADEMÁS carga una fecha
// de vencimiento para esta disciplina (TAREA 3: ya no es exclusivo de
// Aparatos), se usa esa fecha en vez del rolling de 30 días de siempre.
//
// UPSERT estricto (bug real: Aixa en Kickboxing -- la migración inicial
// solo sembró filas en user_credits para CrossFit; cualquier disciplina que
// un socio nunca tocó antes no tenía NINGUNA fila, y sumarle créditos
// rompía la sincronización). Si ya existe una fila para este socio+
// disciplina (la más reciente por created_at, mismo criterio de lectura que
// usa toda la app -- fetchUserBalances/disciplinas_del_plan_actual), se
// actualiza ESA fila en el lugar. Si no existe ninguna (disciplina nunca
// inicializada para este socio), se inserta una nueva arrancando desde 0.
// Antes esto SIEMPRE insertaba una fila nueva -- funcionaba de pura
// casualidad para disciplinas que ya tenían historial (CrossFit), pero
// dependía en silencio de que esa fila previa existiera.
export async function sincronizarCreditosPwa({ dni, email, disciplina, delta, fechaVencimiento }) {
  try {
    const userId = await resolverUserId({ dni, email })
    if (!userId) return { synced: false, reason: 'sin_cuenta_pwa' }

    const disciplineId = await resolverDisciplinaId(disciplina)
    if (!disciplineId) return { synced: false, reason: 'disciplina_no_encontrada' }

    const { data: filaActual } = await supabase
      .from('user_credits')
      .select('id, remaining_credits')
      .eq('user_id', userId)
      .eq('discipline_id', disciplineId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const nuevoBalance = Math.max(0, (filaActual?.remaining_credits ?? 0) + delta)
    const expiresAt = fechaVencimiento
      ? new Date(`${fechaVencimiento}T12:00:00`).toISOString()
      : new Date(Date.now() + DIAS_VIGENCIA_CREDITOS * 86_400_000).toISOString()

    const { error } = filaActual
      ? await supabase
          .from('user_credits')
          .update({ remaining_credits: nuevoBalance, expires_at: expiresAt })
          .eq('id', filaActual.id)
      : await supabase.from('user_credits').insert({
          user_id: userId,
          discipline_id: disciplineId,
          remaining_credits: nuevoBalance,
          expires_at: expiresAt,
          // Explícito (no depender del default now() de la columna) -- todo
          // el resto del código lee "la fila más reciente por created_at"
          // para saber cuál es el balance vigente, así que esto es parte
          // del contrato real de la función, no un detalle de
          // infraestructura.
          created_at: new Date().toISOString(),
        })

    if (error) {
      console.error('ERROR user_credits UPSERT SUPABASE (créditos):', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      })
      return { synced: false, reason: 'error_supabase' }
    }
    return { synced: true }
  } catch (err) {
    console.error('ERROR inesperado sincronizando créditos con la PWA:', err)
    return { synced: false, reason: 'error_supabase' }
  }
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
export async function sincronizarVencimientoPwa({ dni, email, disciplina, fechaVencimiento }) {
  try {
    const userId = await resolverUserId({ dni, email })
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
      created_at: new Date().toISOString(),
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
  } catch (err) {
    console.error('ERROR inesperado sincronizando vencimiento con la PWA:', err)
    return { synced: false, reason: 'error_supabase' }
  }
}

// Vencimiento para una disciplina de CRÉDITOS (CrossFit, Boxeo, Kickboxing)
// -- distinto de sincronizarVencimientoPwa (que es para Aparatos/Pase
// Libre) porque ESA función pisa `remaining_credits` con null a propósito
// (correcto para una membresía, que no tiene créditos). Para una
// disciplina de créditos eso sería un bug real: pisaría el balance real
// del socio con null la próxima vez que fetchUserBalances() lea "la fila
// más reciente" -- así que acá se lee el remaining_credits ACTUAL primero
// y se lo preserva en la fila nueva, solo cambiando expires_at.
export async function sincronizarVencimientoCreditoPwa({ dni, email, disciplina, fechaVencimiento }) {
  try {
    const userId = await resolverUserId({ dni, email })
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

    const expiresAt = new Date(`${fechaVencimiento}T12:00:00`).toISOString()

    const { error } = await supabase.from('user_credits').insert({
      user_id: userId,
      discipline_id: disciplineId,
      remaining_credits: actual?.remaining_credits ?? 0,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    })

    if (error) {
      console.error('ERROR user_credits INSERT SUPABASE (vencimiento de disciplina de créditos):', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      })
      return { synced: false, reason: 'error_supabase' }
    }
    return { synced: true }
  } catch (err) {
    console.error('ERROR inesperado sincronizando vencimiento de disciplina de créditos con la PWA:', err)
    return { synced: false, reason: 'error_supabase' }
  }
}

// Baja lógica: `profiles.active` es lo que de verdad bloquea el login y las
// reservas (AuthContext y el RPC book_class lo chequean del lado servidor);
// `socios.activo` es solo el reflejo de esto en el panel admin. Sin este
// puente, dar de baja a alguien acá no le impediría seguir usando la PWA.
export async function sincronizarEstadoCuentaPwa({ dni, email, activo }) {
  try {
    const userId = await resolverUserId({ dni, email })
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
  } catch (err) {
    console.error('ERROR inesperado sincronizando estado de cuenta con la PWA:', err)
    return { synced: false, reason: 'error_supabase' }
  }
}
