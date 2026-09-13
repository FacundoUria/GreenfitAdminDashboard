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
//
// BUG REAL #2 (Agustina Aguero, DNI 43418750) -- desde ese ticket,
// fecha_vencimiento FUTURA por sí sola YA NO alcanza para 'activo': hace
// falta `aparatosVigenteReal: true` (una fila real confirmada en
// user_credits, ver fetchAparatosVigentePorDni). Los fixtures de este
// archivo que representan un socio con Aparatos GENUINAMENTE vigente lo
// declaran explícito -- los que no lo declaran están representando a
// propósito el caso "fecha sin nada real detrás".

const HOY = '2026-08-10'
const REF = new Date(`${HOY}T12:00:00`)

describe('estadoOperativoSocio', () => {
  it('vencimiento futuro CON Aparatos real vigente -> activo', () => {
    expect(
      estadoOperativoSocio({ fecha_vencimiento: '2026-08-20', activo: true, aparatosVigenteReal: true }, REF),
    ).toBe('activo')
  })

  it('vencimiento hoy CON Aparatos real vigente -> activo', () => {
    expect(estadoOperativoSocio({ fecha_vencimiento: HOY, activo: true, aparatosVigenteReal: true }, REF)).toBe(
      'activo',
    )
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

  it('dado de baja -> inactivo, sin importar la fecha de vencimiento ni Aparatos real', () => {
    expect(
      estadoOperativoSocio({ fecha_vencimiento: '2026-08-20', activo: false, aparatosVigenteReal: true }, REF),
    ).toBe('inactivo')
  })

  // BUG REAL #2, URGENTE (filtro "Activo" de Socios.jsx mostrando socios
  // con badge "Inactivo", caso real Agustina Aguero DNI 43418750) -- ANTES
  // una fecha_vencimiento futura por sí sola alcanzaba para 'activo', sin
  // confirmar que existiera una fila real de Aparatos detrás -- un residuo
  // (import de CrossFy, campo viejo ya eliminado) podía dejar esa columna
  // en el futuro sin que le correspondiera nada real. EstadoBadge (que ya
  // exige la fila real, ver aparatosActivoReal en SociosTabla.jsx) la
  // mostraba "Inactivo" -- pero el filtro "Activo" (que usaba esta función)
  // igual la dejaba pasar. Ahora, sin Aparatos real NI créditos reales, una
  // fecha_vencimiento futura sola ya no alcanza.
  describe('fecha_vencimiento futura SIN Aparatos real vigente -- ya no alcanza para "activo" (fix filtro "Activo")', () => {
    it('fecha_vencimiento futura, aparatosVigenteReal explícitamente false, sin créditos -> inactivo, no activo', () => {
      const socio = {
        fecha_vencimiento: '2026-08-20', // fantasma -- sin fila real detrás
        activo: true,
        aparatosVigenteReal: false,
        creditosPwaPorDisciplina: [],
      }
      expect(estadoOperativoSocio(socio, REF)).toBe('inactivo')
    })

    // Distinto de "aparatosVigenteReal: false" -- `undefined` significa
    // "el socio NO TIENE cuenta PWA" (dni que nunca resolvió ningún
    // profile, ver fetchAparatosVigentePorDni), no "tiene cuenta pero sin
    // nada real". Sin cuenta PWA no existe NINGUNA fila de user_credits
    // posible -- socios.fecha_vencimiento es la ÚNICA fuente de verdad que
    // puede haber para este socio (ej. cobrado 100% por mostrador,
    // Registrar Pago, nunca se registró en la app -- caso real: Lucía
    // Paz). Tratar esto igual que `false` rompería ese flujo entero.
    it('fecha_vencimiento futura, SIN cuenta PWA (aparatosVigenteReal undefined) -> activo -- fecha_vencimiento es la única fuente posible', () => {
      const socio = { fecha_vencimiento: '2026-08-20', activo: true }
      expect(estadoOperativoSocio(socio, REF)).toBe('activo')
    })

    it('fecha_vencimiento VENCIDA, SIN cuenta PWA (aparatosVigenteReal undefined) -> vencido -- misma fuente única', () => {
      const socio = { fecha_vencimiento: '2026-07-01', activo: true }
      expect(estadoOperativoSocio(socio, REF)).toBe('vencido')
    })

    it('fecha_vencimiento futura SIN Aparatos real, pero CON créditos reales en otra disciplina -> activo igual (por los créditos)', () => {
      const socio = {
        fecha_vencimiento: '2026-08-20',
        activo: true,
        aparatosVigenteReal: false,
        creditosPwaPorDisciplina: [{ disciplineName: 'CrossFit', remainingCredits: 4 }],
      }
      expect(estadoOperativoSocio(socio, REF)).toBe('activo')
    })
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

  // BUG REAL, URGENTE (filtro "Inactivo" de Socios.jsx mostrando socios con
  // badge "Activo") -- un socio puede tener fecha_vencimiento vencida/
  // residual (Aparatos nunca renovado, o nunca real -- ver ticket "Aparatos
  // fantasma") mientras tiene créditos REALES vigentes en otra disciplina
  // (admin_fijar_creditos_disciplina/admin_ajustar_credito_disciplina nunca
  // tocan fecha_vencimiento a propósito -- las dos fechas pueden divergir).
  // ANTES, fecha_vencimiento decidía SOLA apenas existía -- este socio caía
  // a 'vencido' acá (contado como "Inactivo" en el filtro) mientras
  // EstadoBadge (SociosTabla.jsx, que mira créditos reales directo, sin
  // pasar por fecha_vencimiento) lo mostraba "Activo" -- la fila aparecía
  // con badge "Activo" bajo el filtro "Inactivo". Un crédito real vigente
  // ahora gana SIEMPRE, sin importar qué diga fecha_vencimiento.
  describe('créditos reales vigentes GANAN sobre una fecha_vencimiento vencida o residual (fix filtro "Inactivo")', () => {
    it('fecha_vencimiento VENCIDA + créditos reales vigentes en otra disciplina -> activo, no vencido', () => {
      const socio = {
        fecha_vencimiento: '2026-07-01', // Aparatos vencido hace rato
        activo: true,
        creditosPwaPorDisciplina: [{ disciplineName: 'CrossFit', remainingCredits: 6 }],
      }
      expect(estadoOperativoSocio(socio, REF)).toBe('activo')
    })

    it('fecha_vencimiento vencida SIN créditos reales -> sigue siendo vencido (no se rompió el caso normal)', () => {
      const socio = {
        fecha_vencimiento: '2026-07-01',
        activo: true,
        creditosPwaPorDisciplina: [],
      }
      expect(estadoOperativoSocio(socio, REF)).toBe('vencido')
    })

    it('dado de baja + créditos reales vigentes -> sigue siendo inactivo (la baja gana siempre, sin excepción)', () => {
      const socio = {
        fecha_vencimiento: '2026-07-01',
        activo: false,
        creditosPwaPorDisciplina: [{ disciplineName: 'CrossFit', remainingCredits: 6 }],
      }
      expect(estadoOperativoSocio(socio, REF)).toBe('inactivo')
    })
  })
})

describe('getSocioMetrics', () => {
  it('cuenta activos/vencidos/inactivos consistentemente sobre una lista mixta', () => {
    const socios = [
      { fecha_vencimiento: '2026-08-20', activo: true, aparatosVigenteReal: true }, // activo (Aparatos real)
      { fecha_vencimiento: null, activo: true, creditosPwaPorDisciplina: [{ remainingCredits: 4 }] }, // activo (plan de créditos)
      { fecha_vencimiento: '2026-08-07', activo: true }, // vencido (CAMBIO 1 -- ya no "tolerancia")
      { fecha_vencimiento: '2026-07-01', activo: true }, // vencido
      { fecha_vencimiento: '2026-08-20', activo: false }, // inactivo (dado de baja, no cuenta en ningún otro bucket)
      { fecha_vencimiento: null, activo: true, creditosPwaPorDisciplina: [] }, // inactivo (CAMBIO 3 -- sin nada real)
      { fecha_vencimiento: '2026-08-20', activo: true, aparatosVigenteReal: false }, // inactivo (BUG REAL #2 -- fecha fantasma, sin nada real)
    ]
    expect(getSocioMetrics(socios, REF)).toEqual({ activos: 2, vencidos: 2, inactivos: 3 })
  })

  it('da el MISMO resultado con filas crudas de Supabase (snake_case) que con el shape mapeado de Socios.jsx (camelCase) -- la garantía real detrás de "Home y Socios muestran el mismo número"', () => {
    const filasCrudas = [
      { fecha_vencimiento: '2026-08-20', activo: true, aparatosVigenteReal: true },
      { fecha_vencimiento: '2026-07-01', activo: true },
      { fecha_vencimiento: null, activo: true, creditosPwaPorDisciplina: [] },
    ]
    const filasMapeadas = filasCrudas.map((f) => ({
      fechaVencimiento: f.fecha_vencimiento,
      activo: f.activo,
      aparatosVigenteReal: f.aparatosVigenteReal,
      creditosPwaPorDisciplina: f.creditosPwaPorDisciplina,
    }))

    expect(getSocioMetrics(filasCrudas, REF)).toEqual(getSocioMetrics(filasMapeadas, REF))
  })
})
