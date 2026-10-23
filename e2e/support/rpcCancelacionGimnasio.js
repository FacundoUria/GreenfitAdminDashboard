// Simulación server-side de las RPC de "cancela el gimnasio"
// (supabase_migration_cancelacion_gimnasio_reintegro.sql): admin_quitar_de_clase
// y admin_cancelar_clase_dia_v2. Mismo criterio que el resto de
// e2e/support/rpcMocks.js -- no reimplementa el SQL entero, solo las mismas
// reglas y textos, para que `tables` quede como lo dejaría la base real:
//   0) (antes que todo) clase de Aparatos (kind 'membership') -> no se toca nada;
//      el aviso dice hasta cuándo sigue el acceso o que no tiene acceso vigente.
//   1) lote de un pago ANULADO (reversion.filas_vencidas o creditos[].lote_id) -> no se devuelve;
//   2) lote vigente -> +1 a ese lote;
//   3) lote vencido/reseteado -> +1 al vigente de esa disciplina que vence antes
//      (sin contar lotes de pagos anulados); si no hay, no se devuelve;
//   4) sin lote -> igual que 3.
// `ahora`: Node y el browser son procesos separados -- con el reloj del browser
// congelado, el test pasa acá la misma hora.

const ZONA = 'America/Argentina/Mendoza'

function ddmmaaaa(iso) {
  const [a, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${a}`
}

function diaArgentina(timestamp) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(timestamp),
  )
}

function pagoAnuladoDelLote(tables, userId, loteId) {
  return (tables.pagos_socio ?? []).find((p) => {
    if (p.estado !== 'anulado' || p.user_id !== userId) return false
    const vencidas = p.detalle_acreditacion?.reversion?.filas_vencidas ?? []
    const creditos = p.detalle_acreditacion?.creditos ?? []
    return vencidas.some((f) => f.user_credit_id === loteId) || creditos.some((c) => c.lote_id === loteId)
  })
}

export function mockCancelacionGimnasio(tables, { ahora = () => new Date() } = {}) {
  const llamadas = []

  function cancelarReserva(userId, classId, fecha, contexto) {
    const clase = (tables.classes ?? []).find((c) => c.id === classId)
    if (!clase) throw new Error('No existe esa clase.')
    const disciplinaFila = (tables.disciplines ?? []).find((d) => d.id === clase.discipline_id)
    const disciplina = disciplinaFila?.name ?? clase.title
    const esAparatos = disciplinaFila?.kind === 'membership'
    const nombre = (tables.profiles ?? []).find((p) => p.id === userId)?.full_name ?? 'Socio'

    const idx = (tables.bookings ?? []).findIndex((b) => b.user_id === userId && b.class_id === classId && b.booking_date === fecha)
    if (idx === -1) throw new Error('Ese socio no tenía una reserva en esta clase')
    const loteId = tables.bookings[idx].credit_lote_id ?? null
    tables.bookings.splice(idx, 1)

    const vigente = (f) => new Date(f.expires_at) > ahora()
    const lotes = tables.user_credits ?? []
    const pago = loteId && !esAparatos ? pagoAnuladoDelLote(tables, userId, loteId) : null

    let motivo
    let destino = null
    let accesoAparatos = null
    if (esAparatos) {
      // Aparatos no usa créditos: no se toca nada; acceso = la fila vigente que vence más tarde.
      motivo = 'aparatos_sin_creditos'
      accesoAparatos =
        lotes
          .filter((f) => f.user_id === userId && f.discipline_id === clase.discipline_id && vigente(f))
          .sort((a, b) => new Date(b.expires_at) - new Date(a.expires_at))[0] ?? null
    } else if (pago) {
      motivo = 'pago_anulado'
    } else {
      const propio = loteId ? lotes.find((f) => f.id === loteId && vigente(f)) : null
      if (propio) {
        destino = propio
        motivo = 'reintegrado'
      } else {
        destino =
          lotes
            .filter((f) => f.user_id === userId && f.discipline_id === clase.discipline_id && vigente(f))
            .filter((f) => !pagoAnuladoDelLote(tables, userId, f.id))
            .sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at))[0] ?? null
        motivo = destino ? (loteId ? 'reintegrado_otro_lote' : 'reintegrado_fifo') : 'sin_lote_vigente'
      }
    }
    if (destino) destino.remaining_credits = (destino.remaining_credits ?? 0) + 1

    const fechaTxt = ddmmaaaa(fecha)
    const hora = (clase.start_time ?? '').slice(0, 5)
    const conFecha = destino ?? accesoAparatos
    const vence = conFecha ? ddmmaaaa(diaArgentina(conFecha.expires_at)) : null
    const inicio =
      contexto === 'quitar'
        ? `El gimnasio te quitó de ${clase.title} de las ${hora} del ${fechaTxt}.`
        : `${clase.title} de las ${hora} del ${fechaTxt} fue cancelada por el gimnasio.`
    const reintegrado = Boolean(destino)
    const mensajeSocio = esAparatos
      ? accesoAparatos
        ? `${inicio} ${disciplina} no usa créditos: tu acceso sigue igual hasta el ${vence}.`
        : `${inicio} ${disciplina} no usa créditos y hoy no tenés acceso vigente a ${disciplina}. Consultá con el gimnasio.`
      : reintegrado
        ? `${inicio} Te devolvimos el crédito (vence el ${vence}).`
        : motivo === 'pago_anulado'
          ? contexto === 'quitar'
            ? `El gimnasio te quitó de la clase del ${fechaTxt}. Ese crédito no se reintegró porque pertenecía a un pago anulado. Consultá con el gimnasio.`
            : `La clase del ${fechaTxt} se canceló. Ese crédito no se reintegró porque pertenecía a un pago anulado. Consultá con el gimnasio.`
          : `${inicio} Ese crédito no se reintegró porque no tenés créditos vigentes de ${disciplina}. Consultá con el gimnasio.`
    const mensajeAdmin = {
      aparatos_sin_creditos: accesoAparatos
        ? `${nombre}: ${disciplina} no usa créditos, no había nada que devolver; su acceso sigue igual hasta el ${vence}.`
        : `${nombre}: ${disciplina} no usa créditos, no había nada que devolver; no tiene acceso vigente a ${disciplina}.`,
      reintegrado: `${nombre}: crédito devuelto (vence el ${vence}).`,
      reintegrado_otro_lote: `${nombre}: su lote original ya estaba vencido o lo reemplazó un pago posterior; el crédito se sumó a su lote vigente de ${disciplina} (vence el ${vence}).`,
      reintegrado_fifo: `${nombre}: crédito devuelto a su lote vigente de ${disciplina} (vence el ${vence}).`,
      pago_anulado: `${nombre}: NO se devolvió el crédito, era de un pago anulado (del ${pago ? ddmmaaaa(diaArgentina(pago.created_at)) : ''}). Si querés, cargáselo a mano con los créditos manuales.`,
      sin_lote_vigente: `${nombre}: NO se devolvió el crédito, no tiene créditos vigentes de ${disciplina}. Si querés, cargáselo a mano con los créditos manuales.`,
    }[motivo]

    tables.booking_cancellations = tables.booking_cancellations ?? []
    tables.booking_cancellations.push({ user_id: userId, class_id: classId, booking_date: fecha })

    return {
      user_id: userId,
      nombre,
      reintegrado,
      motivo,
      lote_id: destino?.id ?? null,
      vence: conFecha ? diaArgentina(conFecha.expires_at) : null,
      mensaje_socio: mensajeSocio,
      mensaje_admin: mensajeAdmin,
    }
  }

  function notificar(userId, title, body) {
    tables.notifications = tables.notifications ?? []
    tables.notifications.push({
      id: `notif-${tables.notifications.length + 1}`,
      sender_id: 'e2e-admin',
      audience_type: 'user',
      target_user_id: userId,
      title,
      body,
    })
  }

  const conError = (fn) => (request) => {
    try {
      return fn(request)
    } catch (err) {
      return { __e2eError: { status: 400, body: { message: err.message } } }
    }
  }

  return {
    llamadas,
    admin_quitar_de_clase: conError((request) => {
      const body = request.postDataJSON()
      llamadas.push({ fn: 'admin_quitar_de_clase', body })
      const resultado = cancelarReserva(body.p_user_id, body.p_class_id, body.p_booking_date, 'quitar')
      notificar(body.p_user_id, 'Cambio en tu reserva', resultado.mensaje_socio)
      return resultado
    }),
    admin_cancelar_clase_dia_v2: conError((request) => {
      const body = request.postDataJSON()
      llamadas.push({ fn: 'admin_cancelar_clase_dia_v2', body })
      const { p_class_id: classId, p_occurrence_date: fecha } = body
      tables.class_occurrence_cancellations = tables.class_occurrence_cancellations ?? []
      if (!tables.class_occurrence_cancellations.some((c) => c.class_id === classId && c.occurrence_date === fecha)) {
        tables.class_occurrence_cancellations.push({ id: `cancel-${classId}-${fecha}`, class_id: classId, occurrence_date: fecha })
      }
      const userIds = (tables.bookings ?? []).filter((b) => b.class_id === classId && b.booking_date === fecha).map((b) => b.user_id)
      const detalle = userIds.map((userId) => {
        const resultado = cancelarReserva(userId, classId, fecha, 'clase_cancelada')
        notificar(userId, 'Clase cancelada', resultado.mensaje_socio)
        return resultado
      })
      return {
        cancelados: detalle.length,
        reintegrados: detalle.filter((d) => d.reintegrado).length,
        no_reintegrados: detalle.filter((d) => !d.reintegrado && d.motivo !== 'aparatos_sin_creditos'),
        aparatos: detalle.filter((d) => d.motivo === 'aparatos_sin_creditos'),
        detalle,
      }
    }),
  }
}
