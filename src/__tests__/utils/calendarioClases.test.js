import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import { mapearClasesDesdeBookings } from '../../utils/clases'
import {
  avisoDiaPasado,
  clasesDeUnDiaPasado,
  contarPorDia,
  diaSemanaISO,
  diasDeLaTira,
  esSoloLectura,
  etiquetaDiaISO,
  fechaCortaISO,
  fetchPrimeraReserva,
  fetchResumenMes,
  mesDe,
  nombreMes,
  semanasDelMes,
  sumarDiasISO,
  sumarMeses,
  ultimoDiaDelMes,
} from '../../utils/calendarioClases'

describe('fechas como texto YYYY-MM-DD (sin depender de la zona de la PC)', () => {
  it('sumarDiasISO cruza meses y años', () => {
    expect(sumarDiasISO('2026-10-31', 1)).toBe('2026-11-01')
    expect(sumarDiasISO('2026-03-01', -1)).toBe('2026-02-28')
    expect(sumarDiasISO('2028-03-01', -1)).toBe('2028-02-29') // bisiesto
    expect(sumarDiasISO('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('diaSemanaISO usa 0 = domingo, como classes.days_of_week', () => {
    expect(diaSemanaISO('2026-10-22')).toBe(4) // jueves
    expect(diaSemanaISO('2026-08-18')).toBe(2) // martes
    expect(diaSemanaISO('2026-10-25')).toBe(0) // domingo
  })

  it('meses: primer día, último día (28 a 31) y suma de meses', () => {
    expect(mesDe('2026-10-22')).toBe('2026-10-01')
    expect(ultimoDiaDelMes('2026-02-01')).toBe('2026-02-28')
    expect(ultimoDiaDelMes('2026-10-01')).toBe('2026-10-31')
    expect(ultimoDiaDelMes('2026-09-01')).toBe('2026-09-30')
    expect(sumarMeses('2026-01-01', -1)).toBe('2025-12-01')
    expect(sumarMeses('2026-12-01', 1)).toBe('2027-01-01')
    expect(nombreMes('2026-10-01')).toBe('Octubre 2026')
    expect(fechaCortaISO('2026-08-05')).toBe('05/08')
  })

  it('semanasDelMes arranca el lunes y rellena con null', () => {
    const semanas = semanasDelMes('2026-10-01') // 1/10/2026 es jueves
    expect(semanas[0]).toEqual([null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
    expect(semanas.every((s) => s.length === 7)).toBe(true)
    expect(semanas.flat().filter(Boolean)).toHaveLength(31)
    expect(semanas[semanas.length - 1]).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', null])
  })
})

describe('tira de días y solo lectura', () => {
  it('la tira son los 7 días anteriores + hoy + los 6 siguientes', () => {
    const tira = diasDeLaTira('2026-10-22')
    expect(tira).toHaveLength(14)
    expect(tira[0]).toBe('2026-10-15')
    expect(tira[7]).toBe('2026-10-22')
    expect(tira[13]).toBe('2026-10-28')
  })

  it('etiquetas: Ayer / Hoy / Mañana, el resto el día abreviado', () => {
    expect(etiquetaDiaISO('2026-10-21', '2026-10-22')).toBe('Ayer')
    expect(etiquetaDiaISO('2026-10-22', '2026-10-22')).toBe('Hoy')
    expect(etiquetaDiaISO('2026-10-23', '2026-10-22')).toBe('Mañana')
    expect(etiquetaDiaISO('2026-10-20', '2026-10-22')).toBe('mar')
    expect(etiquetaDiaISO('2026-11-01', '2026-10-31')).toBe('Mañana') // cambio de mes
  })

  it('solo lectura: anteriores a "ayer" sí; ayer, hoy y futuro no', () => {
    expect(esSoloLectura('2026-10-20', '2026-10-22')).toBe(true)
    expect(esSoloLectura('2026-08-18', '2026-10-22')).toBe(true)
    expect(esSoloLectura('2026-10-21', '2026-10-22')).toBe(false)
    expect(esSoloLectura('2026-10-22', '2026-10-22')).toBe(false)
    expect(esSoloLectura('2026-10-28', '2026-10-22')).toBe(false)
    expect(esSoloLectura('2026-10-31', '2026-11-01')).toBe(false) // ayer, con cambio de mes
    expect(esSoloLectura('2026-10-30', '2026-11-01')).toBe(true)
  })
})

describe('clasesDeUnDiaPasado + avisoDiaPasado', () => {
  // Caso real de producción: "CrossFit - Turno Noche" hoy es lun/mié/vie,
  // pero tiene 21 reservas de martes y jueves (18/08 al 15/09).
  const TURNO_NOCHE = {
    id: '56e73799-640c-478c-8b55-69b0cc2d816e',
    title: 'CrossFit - Turno Noche',
    discipline_id: 'd-cf',
    instructor: 'Seba',
    start_time: '20:00:00',
    end_time: '21:00:00',
    capacity: 20,
    days_of_week: [1, 3, 5],
    created_at: '2026-07-01T12:00:00Z',
  }
  const BOXEO_MARTES = { ...TURNO_NOCHE, id: 'boxeo', title: 'Boxeo', days_of_week: [2], capacity: 2, start_time: '18:00:00' }
  const NUEVA = { ...TURNO_NOCHE, id: 'nueva', title: 'Clase nueva', days_of_week: [2], created_at: '2026-09-01T12:00:00Z' }
  const SIN_FECHA = { ...TURNO_NOCHE, id: 'sin-fecha', title: 'Sin created_at', days_of_week: [2], created_at: undefined }
  const OCULTA = { ...TURNO_NOCHE, id: 'oculta', title: 'Oculta en agenda', days_of_week: [1] }
  const reserva = (id, classId) => ({ id, class_id: classId, user_id: `u-${id}`, attended: null, profiles: { full_name: id, dni: null } })

  const armar = ({ fecha, plantillas, todasLasClases, reservas = [], canceladas = [] }) =>
    mapearClasesDesdeBookings(
      clasesDeUnDiaPasado({
        fecha,
        plantillas,
        todasLasClases,
        classIdsConReserva: new Set(reservas.map((r) => r.class_id)),
        classIdsCanceladas: new Set(canceladas),
      }),
      reservas,
    ).map((c) => ({ ...c, aviso: avisoDiaPasado(c, fecha) }))

  it('martes 18/08: aparece Turno Noche (hoy lun/mié/vie) por sus reservas, con aviso', () => {
    const clases = armar({
      fecha: '2026-08-18',
      plantillas: [TURNO_NOCHE, BOXEO_MARTES],
      todasLasClases: [TURNO_NOCHE, BOXEO_MARTES],
      reservas: [reserva('r1', TURNO_NOCHE.id), reserva('r2', TURNO_NOCHE.id)],
    })
    const noche = clases.find((c) => c.id === TURNO_NOCHE.id)
    expect(noche.inscriptos).toHaveLength(2)
    expect(noche.aviso).toBe('Hoy esta clase se dicta lun, mié y vie: el título, el horario o el cupo de ese día pueden haber sido otros.')
    // La plantilla de los martes sigue apareciendo (0 inscriptos), sin aviso.
    expect(clases.find((c) => c.id === 'boxeo')).toMatchObject({ inscriptos: [], aviso: null })
  })

  it('una clase creada DESPUÉS de esa fecha no aparece ese día; una sin created_at sí', () => {
    const clases = armar({ fecha: '2026-08-18', plantillas: [NUEVA, SIN_FECHA], todasLasClases: [NUEVA, SIN_FECHA] })
    expect(clases.map((c) => c.id)).toEqual(['sin-fecha'])
  })

  it('created_at se compara como día de Argentina: 02:00Z del 19/08 todavía es el 18/08', () => {
    const creada18Noche = { ...NUEVA, created_at: '2026-08-19T02:00:00Z' }
    expect(armar({ fecha: '2026-08-18', plantillas: [creada18Noche], todasLasClases: [creada18Noche] }).map((c) => c.id)).toEqual(['nueva'])
  })

  it('una clase cancelada ese día aparece aunque hoy no se dicte ese día de la semana', () => {
    const clases = armar({ fecha: '2026-08-18', plantillas: [TURNO_NOCHE], todasLasClases: [TURNO_NOCHE], canceladas: [TURNO_NOCHE.id] })
    expect(clases.map((c) => c.id)).toEqual([TURNO_NOCHE.id])
  })

  it('con reservas aparece aunque su disciplina esté oculta de la agenda (no está en plantillas)', () => {
    const clases = armar({ fecha: '2026-08-17', plantillas: [], todasLasClases: [OCULTA], reservas: [reserva('r1', 'oculta')] })
    expect(clases.map((c) => c.id)).toEqual(['oculta'])
  })

  it('más inscriptos que el cupo actual -> aviso de cupo', () => {
    const clases = armar({
      fecha: '2026-08-18',
      plantillas: [BOXEO_MARTES],
      todasLasClases: [BOXEO_MARTES],
      reservas: [reserva('a', 'boxeo'), reserva('b', 'boxeo'), reserva('c', 'boxeo')],
    })
    expect(clases[0].aviso).toBe('Hubo más inscriptos que el cupo actual: el cupo cambió.')
  })
})

describe('datos del mes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('contarPorDia', () => {
    const conteo = contarPorDia([{ d: '2026-10-01' }, { d: '2026-10-01' }, { d: '2026-10-02' }, { d: null }], 'd')
    expect(Object.fromEntries(conteo)).toEqual({ '2026-10-01': 2, '2026-10-02': 1 })
  })

  // Cadena que guarda los filtros y devuelve la página pedida con .range().
  function tablaPaginada(filas, llamadas) {
    return () => {
      const q = { filtros: [] }
      const chain = {
        select: () => chain,
        order: () => chain,
        gte: (c, v) => (q.filtros.push(['gte', c, v]), chain),
        lte: (c, v) => (q.filtros.push(['lte', c, v]), chain),
        range: (desde, hasta) => {
          llamadas.push({ filtros: q.filtros, desde, hasta })
          return Promise.resolve({ data: filas.slice(desde, hasta + 1), error: null })
        },
      }
      return chain
    }
  }

  it('una consulta por rango para el mes, paginada (1220 reservas en 2 páginas)', async () => {
    const reservas = Array.from({ length: 1220 }, (_, i) => ({ id: `b${i}`, booking_date: i < 1000 ? '2026-10-05' : '2026-10-31' }))
    const llamadasReservas = []
    const llamadasCancelaciones = []
    const reservasTabla = tablaPaginada(reservas, llamadasReservas)
    const cancelacionesTabla = tablaPaginada([{ id: 'x', occurrence_date: '2026-10-09' }], llamadasCancelaciones)
    supabase.from.mockImplementation((t) => (t === 'bookings' ? reservasTabla() : cancelacionesTabla()))

    const { inscriptosPorDia, diasConCancelacion } = await fetchResumenMes('2026-10-01')

    expect(inscriptosPorDia.get('2026-10-05')).toBe(1000)
    expect(inscriptosPorDia.get('2026-10-31')).toBe(220)
    expect([...diasConCancelacion]).toEqual(['2026-10-09'])
    expect(llamadasReservas.map((l) => [l.desde, l.hasta])).toEqual([[0, 999], [1000, 1999]])
    expect(llamadasReservas[0].filtros).toEqual([['gte', 'booking_date', '2026-10-01'], ['lte', 'booking_date', '2026-10-31']])
    expect(llamadasCancelaciones[0].filtros).toEqual([['gte', 'occurrence_date', '2026-10-01'], ['lte', 'occurrence_date', '2026-10-31']])
  })

  it('si falla la consulta del mes, tira el error (la pantalla lo muestra)', async () => {
    supabase.from.mockImplementation(() => {
      const chain = { select: () => chain, order: () => chain, gte: () => chain, lte: () => chain }
      chain.range = () => Promise.resolve({ data: null, error: { message: 'network' } })
      return chain
    })
    await expect(fetchResumenMes('2026-10-01')).rejects.toThrow('network')
  })

  it('fetchPrimeraReserva devuelve la fecha más vieja o null', async () => {
    const chain = { select: () => chain, order: () => chain, limit: () => Promise.resolve({ data: [{ booking_date: '2026-07-03' }], error: null }) }
    supabase.from.mockReturnValue(chain)
    expect(await fetchPrimeraReserva()).toBe('2026-07-03')
    chain.limit = () => Promise.resolve({ data: [], error: null })
    expect(await fetchPrimeraReserva()).toBeNull()
  })
})
