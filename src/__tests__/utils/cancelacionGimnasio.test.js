import { describe, it, expect } from 'vitest'
import { mensajeQuitar, pushesPorMensaje, resumenCancelacionClase } from '../../utils/cancelacionGimnasio'

// Resultados como los devuelve admin_cancelar_clase_dia_v2 / admin_quitar_de_clase.
const DEVUELTO = (id, nombre) => ({
  user_id: id,
  nombre,
  reintegrado: true,
  motivo: 'reintegrado',
  mensaje_socio: 'CrossFit de las 19:00 del 05/11/2026 fue cancelada por el gimnasio. Te devolvimos el crédito (vence el 20/11/2026).',
  mensaje_admin: `${nombre}: crédito devuelto (vence el 20/11/2026).`,
})
const ANULADO = {
  user_id: 'u3',
  nombre: 'Caro',
  reintegrado: false,
  motivo: 'pago_anulado',
  mensaje_socio: 'La clase del 05/11/2026 se canceló. Ese crédito no se reintegró porque pertenecía a un pago anulado. Consultá con el gimnasio.',
  mensaje_admin: 'Caro: NO se devolvió el crédito, era de un pago anulado (del 02/10/2026). Si querés, cargáselo a mano con los créditos manuales.',
}

describe('pushesPorMensaje -- un push por cada texto distinto', () => {
  it('agrupa a los socios con el mismo texto y separa los que tienen otro', () => {
    expect(pushesPorMensaje([DEVUELTO('u1', 'Ana'), DEVUELTO('u2', 'Beto'), ANULADO])).toEqual([
      { body: DEVUELTO('u1', 'Ana').mensaje_socio, targetUserIds: ['u1', 'u2'] },
      { body: ANULADO.mensaje_socio, targetUserIds: ['u3'] },
    ])
  })

  it('sin detalle (o con datos incompletos) no manda nada', () => {
    expect(pushesPorMensaje(undefined)).toEqual([])
    expect(pushesPorMensaje([{ user_id: 'u1' }, null])).toEqual([])
  })
})

describe('textos para Seba', () => {
  it('Quitar de la clase: lo que pasó con el crédito', () => {
    expect(mensajeQuitar(ANULADO)).toBe(`Socio quitado de la clase.\n\n${ANULADO.mensaje_admin}`)
  })

  it('Cancelar la clase del día: cuántos sí y cuántos no, con el motivo', () => {
    const texto = resumenCancelacionClase({
      cancelados: 3,
      reintegrados: 2,
      detalle: [DEVUELTO('u1', 'Ana'), DEVUELTO('u2', 'Beto'), ANULADO],
    })
    expect(texto).toBe(
      [
        'Clase cancelada para ese día. Crédito devuelto a 2 de 3.',
        '',
        'Devueltos (2):',
        '- Ana: crédito devuelto (vence el 20/11/2026).',
        '- Beto: crédito devuelto (vence el 20/11/2026).',
        '',
        'NO devueltos (1):',
        `- ${ANULADO.mensaje_admin}`,
      ].join('\n'),
    )
  })

  it('Aparatos va aparte: no cuenta como devuelto ni como no devuelto', () => {
    const aparatos = {
      user_id: 'u4',
      nombre: 'Dani',
      reintegrado: false,
      motivo: 'aparatos_sin_creditos',
      mensaje_socio: 'Aparatos de las 08:00 del 05/11/2026 fue cancelada por el gimnasio. Aparatos no usa créditos: tu acceso sigue igual hasta el 30/11/2026.',
      mensaje_admin: 'Dani: Aparatos no usa créditos, no había nada que devolver; su acceso sigue igual hasta el 30/11/2026.',
    }
    expect(resumenCancelacionClase({ cancelados: 2, reintegrados: 1, detalle: [DEVUELTO('u1', 'Ana'), aparatos] })).toBe(
      [
        'Clase cancelada para ese día. Crédito devuelto a 1 de 1.',
        '',
        'Devueltos (1):',
        '- Ana: crédito devuelto (vence el 20/11/2026).',
        '',
        'Aparatos, no usa créditos (1):',
        `- ${aparatos.mensaje_admin}`,
      ].join('\n'),
    )
    expect(resumenCancelacionClase({ cancelados: 1, reintegrados: 0, detalle: [aparatos] })).toBe(
      ['Clase cancelada para ese día.', '', 'Aparatos, no usa créditos (1):', `- ${aparatos.mensaje_admin}`].join('\n'),
    )
  })

  it('sin anotados lo dice', () => {
    expect(resumenCancelacionClase({ cancelados: 0, reintegrados: 0, detalle: [] })).toBe(
      'Clase cancelada para ese día. No había nadie anotado.',
    )
  })
})
