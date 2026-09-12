// Simulaciones server-side de RPCs compartidas entre specs -- mismo
// criterio que ya usa cada spec para sus propios mocks puntuales (ver
// rpcAjustarCredito en creditos-por-disciplina.spec.js): no reimplementa
// el SQL entero, solo lo suficiente para que la UI reciba éxito/error
// reales y las tablas del fixture queden en el estado que produciría el
// RPC de verdad -- así los asserts de después pueden confiar en `tables`.

function isoUTC(date) {
  return date.toISOString().slice(0, 10)
}

function sumarDiasUTC(iso, dias) {
  const fecha = new Date(`${iso}T00:00:00.000Z`)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return isoUTC(fecha)
}

// admin_acreditar_creditos_manual() (Fase 1,
// supabase_migration_admin_acreditar_creditos_manual.sql) -- la usan
// NuevoSocioModal.jsx (alta con créditos iniciales) y Socios.jsx
// (handleConfirmarPago, "Cobrar") desde la Fase 2. Mismo modelo de "plan
// único" que acreditar_pack(): resetea TODOS los créditos del socio a 0 y
// apaga cualquier Aparatos vigente, después acredita exactamente lo que
// vino en p_creditos/p_incluye_aparatos con una sola fecha (p_fecha_inicio,
// o hoy si es null, + p_dias_vigencia), y espeja socios.creditos/
// fecha_vencimiento desde ese resultado real -- nunca desde lo que el
// admin haya tipeado en el formulario.
export function mockAdminAcreditarCreditosManual(tables) {
  // tablasBase() no incluye `user_credits` por defecto (varias specs nunca
  // lo necesitan) -- se inicializa acá, mutando la misma referencia de
  // `tables`, para no romper si esta es la primera escritura de la sesión.
  if (!tables.user_credits) tables.user_credits = []

  return (request) => {
    const {
      p_user_id: userId,
      p_creditos: creditos,
      p_incluye_aparatos: incluyeAparatos,
      p_dias_vigencia: diasVigencia,
      p_fecha_inicio: fechaInicio,
    } = request.postDataJSON()

    if (!diasVigencia || diasVigencia <= 0) {
      return { __e2eError: { status: 400, body: { message: `p_dias_vigencia inválido: ${diasVigencia}` } } }
    }
    if ((!creditos || creditos.length === 0) && !incluyeAparatos) {
      return {
        __e2eError: {
          status: 400,
          body: {
            message:
              'No se especificó ningún crédito ni Aparatos para acreditar -- no se resetea el plan del socio sin darle algo a cambio.',
          },
        },
      }
    }

    const disciplinaPorId = new Map((tables.disciplines ?? []).map((d) => [d.id, d]))
    const aparatosDiscipline = (tables.disciplines ?? []).find((d) => d.kind === 'membership')

    const vistos = new Set()
    for (const { discipline_id: disciplineId } of creditos ?? []) {
      const disciplina = disciplinaPorId.get(disciplineId)
      if (!disciplina) {
        return { __e2eError: { status: 400, body: { message: `La disciplina ${disciplineId} no existe.` } } }
      }
      if (disciplina.kind !== 'credits') {
        return { __e2eError: { status: 400, body: { message: `La disciplina ${disciplineId} (${disciplina.kind}) no es de créditos.` } } }
      }
      if (vistos.has(disciplineId)) {
        return { __e2eError: { status: 400, body: { message: `La disciplina ${disciplineId} está repetida más de una vez en la carga.` } } }
      }
      vistos.add(disciplineId)
    }

    const ahoraISO = new Date().toISOString()

    // RESETEO -- créditos a 0 en TODAS las disciplinas de créditos del
    // socio, Aparatos vigente apagado (ayer, no hoy -- mismo fix que el
    // RPC real).
    for (const fila of tables.user_credits ?? []) {
      if (fila.user_id !== userId) continue
      const disciplina = disciplinaPorId.get(fila.discipline_id)
      if (disciplina?.kind === 'credits' && (fila.remaining_credits ?? 0) > 0) {
        fila.remaining_credits = 0
      }
      if (aparatosDiscipline && fila.discipline_id === aparatosDiscipline.id && fila.expires_at && fila.expires_at > ahoraISO) {
        fila.expires_at = `${sumarDiasUTC(isoUTC(new Date()), -1)}T12:00:00.000Z`
      }
    }

    // Fecha única del plan nuevo.
    const fechaInicioBase = fechaInicio || isoUTC(new Date())
    const fechaPlanNueva = sumarDiasUTC(fechaInicioBase, diasVigencia)
    const expiresAtPlanNueva = `${fechaPlanNueva}T12:00:00.000Z`

    // ACREDITACIÓN -- solo lo que trae esta carga.
    let totalCreditos = 0
    for (const { discipline_id: disciplineId, credits } of creditos ?? []) {
      totalCreditos += credits
      tables.user_credits.push({
        id: `uc-e2e-${tables.user_credits.length + 1}-${disciplineId}`,
        user_id: userId,
        discipline_id: disciplineId,
        remaining_credits: credits,
        expires_at: expiresAtPlanNueva,
        created_at: new Date().toISOString(),
        discipline: disciplinaPorId.get(disciplineId),
      })
    }

    let aparatosExpiresAt = null
    if (incluyeAparatos && aparatosDiscipline) {
      tables.user_credits.push({
        id: `uc-e2e-aparatos-${tables.user_credits.length + 1}`,
        user_id: userId,
        discipline_id: aparatosDiscipline.id,
        remaining_credits: null,
        expires_at: expiresAtPlanNueva,
        created_at: new Date().toISOString(),
        discipline: aparatosDiscipline,
      })
      aparatosExpiresAt = expiresAtPlanNueva
    } else if (aparatosDiscipline) {
      // Estado REAL post-reseteo -- la fila más reciente de Aparatos de
      // este socio (la que se acaba de apagar arriba, si tenía alguna).
      const filasAparatos = (tables.user_credits ?? [])
        .filter((f) => f.user_id === userId && f.discipline_id === aparatosDiscipline.id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      aparatosExpiresAt = filasAparatos[0]?.expires_at ?? null
    }

    // Espejo en socios -- recalculado desde cero, mismo criterio que el RPC real.
    const profile = (tables.profiles ?? []).find((p) => p.id === userId)
    const socio = profile ? (tables.socios ?? []).find((s) => s.dni === profile.dni) : null
    if (socio) {
      socio.creditos = totalCreditos
      if (aparatosExpiresAt) {
        socio.fecha_vencimiento = aparatosExpiresAt.slice(0, 10)
      }
    }

    return null
  }
}

// admin_fijar_creditos_disciplina() (supabase_migration_fix_editor_
// creditos_plan_unico.sql) -- la usa CreditosEditablesSocio.jsx tanto para
// "Fijar en" (disciplina ya activa) como para "+ Agregar disciplina"
// (CAMBIO 2, disciplina sin ningún lote todavía). A diferencia de
// admin_acreditar_creditos_manual, esta NO resetea el resto del plan --
// solo pone en 0 los lotes activos de LA disciplina que se está fijando
// (mismo criterio de siempre, nunca borra filas) y resuelve la fecha del
// plan actual del socio (resolver_fecha_plan_actual: el expires_at MÁS
// LEJANO entre sus otras disciplinas de créditos activas + Aparatos
// vigente, o now()+30 días si no tiene nada) -- así, agregar una
// disciplina nueva a un socio que ya tiene algo activo la deja con la
// MISMA fecha que el resto, sin que el frontend tenga que calcular nada.
export function mockAdminFijarCreditosDisciplina(tables) {
  if (!tables.user_credits) tables.user_credits = []

  return (request) => {
    const { p_user_id: userId, p_discipline_id: disciplineId, p_creditos: creditos } = request.postDataJSON()

    if (creditos == null || creditos < 0) {
      return { __e2eError: { status: 400, body: { message: `p_creditos inválido: ${creditos}` } } }
    }

    const disciplina = (tables.disciplines ?? []).find((d) => d.id === disciplineId)
    if (!disciplina) {
      return { __e2eError: { status: 400, body: { message: `La disciplina ${disciplineId} no existe.` } } }
    }
    if (disciplina.kind !== 'credits') {
      return { __e2eError: { status: 400, body: { message: `La disciplina ${disciplineId} no es de créditos.` } } }
    }

    const ahoraISO = new Date().toISOString()

    // Consolidar SOLO esta disciplina -- mismo orden que el RPC real: ANTES
    // de resolver la fecha del plan, para que el residuo de esta misma
    // disciplina no "cuente" como fecha activa.
    for (const fila of tables.user_credits) {
      if (fila.user_id === userId && fila.discipline_id === disciplineId && (fila.remaining_credits ?? 0) > 0) {
        fila.remaining_credits = 0
      }
    }

    // resolver_fecha_plan_actual -- el expires_at más lejano entre las
    // OTRAS disciplinas de créditos activas + Aparatos vigente de este
    // socio, o now()+30 días si no tiene nada.
    const activas = tables.user_credits.filter((f) => {
      if (f.user_id !== userId || !f.expires_at || f.expires_at <= ahoraISO) return false
      const d = (tables.disciplines ?? []).find((disc) => disc.id === f.discipline_id)
      if (!d) return false
      if (d.kind === 'credits') return (f.remaining_credits ?? 0) > 0
      return d.kind === 'membership'
    })
    const fechaPlan =
      activas.length > 0
        ? activas.reduce((masLejana, f) => (f.expires_at > masLejana ? f.expires_at : masLejana), activas[0].expires_at)
        : `${sumarDiasUTC(isoUTC(new Date()), 30)}T12:00:00.000Z`

    tables.user_credits.push({
      id: `uc-e2e-fijar-${tables.user_credits.length + 1}`,
      user_id: userId,
      discipline_id: disciplineId,
      remaining_credits: creditos,
      expires_at: fechaPlan,
      created_at: new Date().toISOString(),
      discipline: disciplina,
    })

    // Espejo en socios.creditos -- recalculado desde cero, mismo criterio
    // que el RPC real.
    const profile = (tables.profiles ?? []).find((p) => p.id === userId)
    const socio = profile ? (tables.socios ?? []).find((s) => s.dni === profile.dni) : null
    if (socio) {
      const totalCreditos = tables.user_credits
        .filter((f) => {
          if (f.user_id !== userId || !f.expires_at || f.expires_at <= ahoraISO || (f.remaining_credits ?? 0) <= 0) return false
          const d = (tables.disciplines ?? []).find((disc) => disc.id === f.discipline_id)
          return d?.kind === 'credits'
        })
        .reduce((suma, f) => suma + f.remaining_credits, 0)
      socio.creditos = totalCreditos
    }

    return null
  }
}
