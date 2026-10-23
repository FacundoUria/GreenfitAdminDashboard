// Cancelaciones que hace EL GIMNASIO desde Clases ("Quitar de la clase" y
// "Cancelar la clase del día"). Las RPC admin_quitar_de_clase y
// admin_cancelar_clase_dia_v2 (supabase_migration_cancelacion_gimnasio_
// reintegro.sql) devuelven, por cada socio, qué pasó con su crédito:
//   { user_id, nombre, reintegrado, motivo, vence, mensaje_socio, mensaje_admin }
// Acá solo se arman los textos para Seba y los push: siempre la verdad sobre
// cada crédito (antes decía "Ya te reintegramos el crédito" a todos).

// Un push por cada texto distinto, con los socios que lo reciben.
export function pushesPorMensaje(detalle) {
  const grupos = new Map()
  for (const item of detalle ?? []) {
    if (!item?.user_id || !item?.mensaje_socio) continue
    const userIds = grupos.get(item.mensaje_socio) ?? []
    if (!userIds.includes(item.user_id)) userIds.push(item.user_id)
    grupos.set(item.mensaje_socio, userIds)
  }
  return [...grupos.entries()].map(([body, targetUserIds]) => ({ body, targetUserIds }))
}

// Texto para Seba después de "Quitar de la clase".
export function mensajeQuitar(resultado) {
  return `Socio quitado de la clase.\n\n${resultado?.mensaje_admin ?? 'No se pudo saber qué pasó con el crédito: revisá sus créditos.'}`
}

// Resumen para Seba después de "Cancelar la clase del día".
export function resumenCancelacionClase(resultado) {
  const detalle = resultado?.detalle ?? []
  const cancelados = resultado?.cancelados ?? detalle.length
  if (cancelados === 0) return 'Clase cancelada para ese día. No había nadie anotado.'

  // Aparatos no usa créditos: no es "devuelto" ni "no devuelto", va aparte.
  const aparatos = detalle.filter((d) => d.motivo === 'aparatos_sin_creditos')
  const devueltos = detalle.filter((d) => d.reintegrado)
  const sinDevolver = detalle.filter((d) => !d.reintegrado && d.motivo !== 'aparatos_sin_creditos')
  const conCreditos = cancelados - aparatos.length
  const lineas = [
    conCreditos > 0
      ? `Clase cancelada para ese día. Crédito devuelto a ${devueltos.length} de ${conCreditos}.`
      : 'Clase cancelada para ese día.',
  ]
  if (devueltos.length > 0) {
    lineas.push('', `Devueltos (${devueltos.length}):`, ...devueltos.map((d) => `- ${d.mensaje_admin}`))
  }
  if (sinDevolver.length > 0) {
    lineas.push('', `NO devueltos (${sinDevolver.length}):`, ...sinDevolver.map((d) => `- ${d.mensaje_admin}`))
  }
  if (aparatos.length > 0) {
    lineas.push('', `Aparatos, no usa créditos (${aparatos.length}):`, ...aparatos.map((d) => `- ${d.mensaje_admin}`))
  }
  return lineas.join('\n')
}
