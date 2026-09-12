import { describe, it, expect } from 'vitest'
import { estadoOperativoSocio, getSocioMetrics } from '../../utils/socioMetrics'

// Fuente única de verdad para "Socios Activos"/"Cuotas Vencidas" -- Home.jsx
// y Socios.jsx antes tenían dos criterios distintos para lo mismo (Home
// ignoraba a los socios sin fecha_vencimiento, Socios caía a un texto
// legacy `estadoDb`), lo que hacía que la misma etiqueta mostrara números
// distintos en las dos pantallas. Estos tests fijan la regla única y cubren
// el caso que causaba la divergencia.
//
// CAMBIO 1 (sacar "En Tolerancia" del todo) -- calcularEstadoCuota() ya no
// tiene un tercer resultado 'tolerancia': pasado el vencimiento, es
// 'vencido' de inmediato. Los casos que antes probaban la ventana de
// tolerancia ahora prueban directamente que ESE MISMO día pasa a 'vencido'.

const HOY = '2026-08-10'
const REF = new Date(`${HOY}T12:00:00`)

describe('estadoOperativoSocio', () => {
  it('vencimiento futuro -> activo', () => {
    expect(estadoOperativoSocio({ fecha_vencimiento: '2026-08-20', activo: true }, REF)).toBe('activo')
  })

  it('vencimiento hoy -> activo', () => {
    expect(estadoOperativoSocio({ fecha_vencimiento: HOY, activo: true }, REF)).toBe('activo')
  })

  it('CAMBIO 1 -- vencido por 1 solo día -> vencido de inmediato, sin ninguna ventana de tolerancia', () => {
    expect(estadoOperativoSocio({ fecha_vencimiento: '2026-08-07', activo: true }, REF)).toBe('vencido')
  })

  it('vencido hace mucho -> vencido', () => {
    expect(estadoOperativoSocio({ fecha_vencimiento: '2026-07-20', activo: true }, REF)).toBe('vencido')
  })

  it('acepta el shape mapeado de Socios.jsx (fechaVencimiento camelCase)', () => {
    expect(estadoOperativoSocio({ fechaVencimiento: '2026-07-20', activo: true }, REF)).toBe('vencido')
  })

  it('dado de baja -> inactivo, sin importar la fecha de vencimiento', () => {
    expect(estadoOperativoSocio({ fecha_vencimiento: '2026-08-20', activo: false }, REF)).toBe('inactivo')
  })

  // CAMBIO 3 (bug real: "Activo" sin nada real) -- sin fecha_vencimiento
  // (nunca tuvo Aparatos), el default YA NO es 'activo' a ciegas: hace
  // falta al menos un crédito real vigente en alguna disciplina.
  describe('sin fecha_vencimiento (nunca tuvo Aparatos -- socio 100% créditos)', () => {
    it('con al menos un crédito real vigente -> activo', () => {
      const socio = {
        fecha_vencimiento: null,
        activo: true,
        creditosPwaPorDisciplina: [{ disciplineName: 'CrossFit', remainingCredits: 4 }],
      }
      expect(estadoOperativoSocio(socio, REF)).toBe('activo')
    })

    it('sin ningún crédito real vigente (todo en 0) -> inactivo, NO activo (bug real del ticket)', () => {
      const socio = {
        fecha_vencimiento: null,
        estado: 'Vencido',
        activo: true,
        creditosPwaPorDisciplina: [{ disciplineName: 'CrossFit', remainingCredits: 0 }],
      }
      expect(estadoOperativoSocio(socio, REF)).toBe('inactivo')
    })

    it('sin creditosPwaPorDisciplina mergeado (undefined) -> inactivo, nunca al viejo default optimista', () => {
      expect(estadoOperativoSocio({ fecha_vencimiento: null, activo: true }, REF)).toBe('inactivo')
    })

    it('con creditosPwaPorDisciplina vacío ([]) -> inactivo', () => {
      expect(estadoOperativoSocio({ fecha_vencimiento: null, activo: true, creditosPwaPorDisciplina: [] }, REF)).toBe(
        'inactivo',
      )
    })
  })
})

describe('getSocioMetrics', () => {
  it('cuenta activos/vencidos/inactivos consistentemente sobre una lista mixta', () => {
    const socios = [
      { fecha_vencimiento: '2026-08-20', activo: true }, // activo
      { fecha_vencimiento: null, activo: true, creditosPwaPorDisciplina: [{ remainingCredits: 4 }] }, // activo (plan de créditos)
      { fecha_vencimiento: '2026-08-07', activo: true }, // vencido (CAMBIO 1 -- ya no "tolerancia")
      { fecha_vencimiento: '2026-07-01', activo: true }, // vencido
      { fecha_vencimiento: '2026-08-20', activo: false }, // inactivo (dado de baja, no cuenta en ningún otro bucket)
      { fecha_vencimiento: null, activo: true, creditosPwaPorDisciplina: [] }, // inactivo (CAMBIO 3 -- sin nada real)
    ]
    expect(getSocioMetrics(socios, REF)).toEqual({ activos: 2, vencidos: 2, inactivos: 2 })
  })

  it('da el MISMO resultado con filas crudas de Supabase (snake_case) que con el shape mapeado de Socios.jsx (camelCase) -- la garantía real detrás de "Home y Socios muestran el mismo número"', () => {
    const filasCrudas = [
      { fecha_vencimiento: '2026-08-20', activo: true },
      { fecha_vencimiento: '2026-07-01', activo: true },
      { fecha_vencimiento: null, activo: true, creditosPwaPorDisciplina: [] },
    ]
    const filasMapeadas = filasCrudas.map((f) => ({
      fechaVencimiento: f.fecha_vencimiento,
      activo: f.activo,
      creditosPwaPorDisciplina: f.creditosPwaPorDisciplina,
    }))

    expect(getSocioMetrics(filasCrudas, REF)).toEqual(getSocioMetrics(filasMapeadas, REF))
  })
})
