import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import SociosTabla from '../../components/SociosTabla'

// La tabla renderiza SIEMPRE las dos variantes (tarjetas para mobile, tabla
// para desktop) -- jsdom no evalúa media queries, así que un mismo dato
// puede aparecer 2 veces en el árbol (una por variante). Se usa getAllBy*
// a propósito en vez de getBy* para no chocar con eso.

const HANDLERS = {
  onRegistrarPago: vi.fn(),
  onEditar: vi.fn(),
  onAbrirWhatsapp: vi.fn(),
  onCambiarBaja: vi.fn(),
  seleccionados: new Set(),
  onToggleSeleccionado: vi.fn(),
  onToggleSeleccionarTodos: vi.fn(),
}

const SOCIO_CON_FOTO = {
  id: 's1',
  nombre: 'Martina',
  apellido: 'Ríos',
  dni: '30111222',
  email: 'martina@mail.com',
  plan: ['CrossFit'],
  creditos: 4,
  activo: true,
  estado: 'activo',
  avatarUrl: 'https://cdn.supabase.co/avatars/u1/avatar.jpg',
  nivelXp: 3,
}

const SOCIO_SIN_FOTO = {
  id: 's2',
  nombre: 'Bruno',
  apellido: 'Álvarez',
  dni: '30999888',
  email: 'bruno@mail.com',
  plan: ['Aparatos'],
  creditos: 0,
  activo: true,
  estado: 'activo',
  avatarUrl: null,
  nivelXp: null,
}

describe('SociosTabla -- avatar sincronizado con la PWA + badge de nivel (Ficha 360°, punto a)', () => {
  it('renderiza el avatar_url real como <img> cuando el socio tiene foto', () => {
    render(<SociosTabla socios={[SOCIO_CON_FOTO]} {...HANDLERS} />)
    const imagenes = screen.getAllByRole('img').filter((img) => img.getAttribute('src') === SOCIO_CON_FOTO.avatarUrl)
    expect(imagenes.length).toBeGreaterThan(0)
  })

  it('muestra el badge "N{nivel}" junto al nombre cuando hay XP calculada', () => {
    render(<SociosTabla socios={[SOCIO_CON_FOTO]} {...HANDLERS} />)
    expect(screen.getAllByText('N3').length).toBeGreaterThan(0)
  })

  it('sin foto, cae al fallback de iniciales (no rompe ni muestra un <img> roto)', () => {
    render(<SociosTabla socios={[SOCIO_SIN_FOTO]} {...HANDLERS} />)
    expect(screen.getAllByText('BÁ').length).toBeGreaterThan(0)
  })

  it('sin nivel resuelto todavía, no muestra ningún badge "N..."', () => {
    render(<SociosTabla socios={[SOCIO_SIN_FOTO]} {...HANDLERS} />)
    expect(screen.queryByText(/^N\d+$/)).toBeNull()
  })
})

// Rediseño (sacar los steppers de la tabla): CreditosCell pasó de tener
// steppers -/+1/+4/+8/+12 por disciplina a ser de SOLO LECTURA -- el ajuste
// ahora vive en "Editar Socio" (CreditosEditablesSocio.jsx), con un input
// para escribir el número exacto (ver supabase_migration_editar_creditos_
// disciplina.sql). Estos tests confirman que la celda sigue mostrando el
// balance REAL de la PWA por disciplina (mismo bug histórico de
// ambigüedad ya resuelto, no se reintroduce), pero SIN ningún control de
// edición ni handler que llamar.
describe('CreditosCell -- de solo lectura tras sacar los steppers (rediseño "Editar Socio")', () => {
  const SOCIO_MULTI_DISCIPLINA = {
    id: 's3',
    nombre: 'Facundo',
    apellido: 'Uria',
    dni: '20333444',
    email: 'facu@mail.com',
    plan: ['CrossFit', 'Boxeo'],
    creditos: 6, // pozo global -- YA NO se muestra ni se usa para decidir el balance por fila
    activo: true,
    estado: 'activo',
    avatarUrl: null,
    nivelXp: null,
    creditosPwaPorDisciplina: [
      { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6 },
      { disciplineId: 'd-boxeo', disciplineName: 'Boxeo', remainingCredits: 0 },
    ],
  }

  it('muestra una fila por disciplina, con nombre para desambiguar cuando hay 2+', () => {
    render(<SociosTabla socios={[SOCIO_MULTI_DISCIPLINA]} {...HANDLERS} />)
    expect(screen.getAllByText('CrossFit:').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Boxeo:').length).toBeGreaterThan(0)
  })

  it('muestra el balance REAL de la PWA por disciplina, no el pozo global de socios.creditos', () => {
    render(<SociosTabla socios={[SOCIO_MULTI_DISCIPLINA]} {...HANDLERS} />)
    // CrossFit real = 6, Boxeo real = 0 -- si mostrara el pozo global (6)
    // en las dos filas, este segundo assert fallaría.
    const ceros = screen.getAllByTitle('Créditos reales de Boxeo en la app')
    expect(ceros.every((el) => el.textContent === '0')).toBe(true)
    const seises = screen.getAllByTitle('Créditos reales de CrossFit en la app')
    expect(seises.every((el) => el.textContent === '6')).toBe(true)
  })

  // Caso real reportado (bug del modelo de "plan único", Facundo Uria DNI
  // 44537978): esta celda dependía de planesDeCreditos(socio.plan) para
  // decidir QUÉ disciplinas mostrar -- una con créditos reales y vigentes
  // pero SIN tildar en el plan (comprada por pack, nunca marcada a mano)
  // no aparecía acá. FIX -- ahora se itera directo
  // socio.creditosPwaPorDisciplina, sin mirar el plan para nada (ver
  // CreditosCell) -- el disciplineName que se muestra ya es el real, así
  // que tampoco puede haber desfase de mayúsculas/minúsculas contra el
  // plan: ese problema quedó estructuralmente eliminado, no solo tapado.
  it('una disciplina con créditos reales, aunque NO esté tildada en socios.plan, aparece igual (caso Kickstrike de Facundo)', () => {
    const socioKickstrikeSinPlan = {
      ...SOCIO_MULTI_DISCIPLINA,
      plan: ['CrossFit', 'Boxeo'], // Kickstrike NO está en el plan
      creditosPwaPorDisciplina: [
        { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6 },
        { disciplineId: 'd-kickstrike', disciplineName: 'Kickstrike', remainingCredits: 12 },
      ],
    }
    render(<SociosTabla socios={[socioKickstrikeSinPlan]} {...HANDLERS} />)
    const celdas = screen.getAllByTitle('Créditos reales de Kickstrike en la app')
    expect(celdas.every((el) => el.textContent === '12')).toBe(true)
  })

  it('no renderiza ningún stepper -- ni +/-1, ni +4/+8/+12 -- en la fila de créditos', () => {
    render(<SociosTabla socios={[SOCIO_MULTI_DISCIPLINA]} {...HANDLERS} />)
    expect(screen.queryByTitle(/Sumar 1 crédito/)).toBeNull()
    expect(screen.queryByTitle(/Asignar pack de/)).toBeNull()
    expect(screen.queryByTitle(/Restar/)).toBeNull()
  })

  it('con una sola disciplina de créditos, no repite el nombre como etiqueta de fila (no hace falta desambiguar)', () => {
    const socioUnaDisciplina = { ...SOCIO_CON_FOTO, creditosPwaPorDisciplina: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 4 }] }
    render(<SociosTabla socios={[socioUnaDisciplina]} {...HANDLERS} />)
    expect(screen.queryByText('CrossFit:')).toBeNull()
  })

  it('sin creditosPwaPorDisciplina (batch todavía no resuelto, o ausente) -- estado vacío en vez de romper', () => {
    // Ya no hay ningún dato de socio.plan para "adivinar" qué disciplina
    // mostrar en 0 mientras el batch no resolvió -- sin nada real todavía,
    // la celda de Créditos directamente no tiene ninguna fila (mismo
    // criterio que CreditosEditablesSocio.jsx: sin datos reales, nada que
    // mostrar). No rompe -- ver el guard `entradas.length === 0` en
    // CreditosCell.
    const socioSinBatchTodavia = { ...SOCIO_CON_FOTO }
    delete socioSinBatchTodavia.creditosPwaPorDisciplina
    render(<SociosTabla socios={[socioSinBatchTodavia]} {...HANDLERS} />)
    expect(screen.queryByTitle(/Créditos reales de/)).toBeNull()
  })
})

// Créditos por LOTES (ver supabase_migration_lotes_creditos_fase1/2.sql):
// caso real reportado (Elena Castillo, DNI 34237434) -- la columna
// Vencimiento nunca mostraba nada para disciplinas de créditos, solo la
// fecha de Aparatos. Mismo formato que la PWA (formatCreditosDisponibles).
describe('VencimientoCell -- desglose de vencimiento por lote de créditos (fix Admin↔PWA)', () => {
  it('con 1 solo lote activo, muestra "Vence el dd/mm/yyyy"', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      creditosPwaPorDisciplina: [
        { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 4, lotes: [{ id: 'l1', remainingCredits: 4, expiresAt: '2026-10-05T12:00:00.000Z' }] },
      ],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Vence el 05/10/2026').length).toBeGreaterThan(0)
  })

  // Caso Elena: 2 lotes (8 + 1 = 9), cada uno con su propia fecha -- mismo
  // formato "X vencen el dd/mm · Y vencen el dd/mm" que la PWA, en orden de
  // vencimiento ascendente (el que vence antes, primero).
  it('con 2 lotes activos, muestra el desglose "X vencen el dd/mm · Y vencen el dd/mm" en orden de vencimiento', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      creditosPwaPorDisciplina: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 9,
          lotes: [
            { id: 'l1', remainingCredits: 8, expiresAt: '2026-09-20T12:00:00.000Z' },
            { id: 'l2', remainingCredits: 1, expiresAt: '2026-10-15T12:00:00.000Z' },
          ],
        },
      ],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('8 vencen el 20/09/2026 · 1 vencen el 15/10/2026').length).toBeGreaterThan(0)
  })

  // Rediseño (agrupar por FECHA, no por disciplina): con 2 disciplinas en
  // fechas DISTINTAS, ya no es "una línea por disciplina" -- es UNA sola
  // línea con los 2 grupos de fecha unidos por " · " (mismo criterio que
  // el desglose de lotes de una sola disciplina, ver formatVencimientoLotes).
  it('con 2+ disciplinas de créditos en fechas distintas, arma una sola línea "X vence el dd/mm · Y vence el dd/mm"', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      plan: ['CrossFit', 'Boxeo'],
      creditosPwaPorDisciplina: [
        { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 4, lotes: [{ id: 'l1', remainingCredits: 4, expiresAt: '2026-10-05T12:00:00.000Z' }] },
        { disciplineId: 'd-boxeo', disciplineName: 'Boxeo', remainingCredits: 2, lotes: [{ id: 'l2', remainingCredits: 2, expiresAt: '2026-11-01T12:00:00.000Z' }] },
      ],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('CrossFit vence el 05/10/2026 · Boxeo vence el 01/11/2026').length).toBeGreaterThan(0)
  })

  it('Aparatos (membresía) lleva el mismo prefijo "Vence el " que las líneas de créditos', () => {
    const socio = { ...SOCIO_SIN_FOTO, fechaVencimiento: '2026-12-31' }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Vence el 31/12/2026').length).toBeGreaterThan(0)
  })

  it('sin fecha de Aparatos y sin ningún lote de créditos activo, muestra "—"', () => {
    render(<SociosTabla socios={[SOCIO_CON_FOTO]} {...HANDLERS} />)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })
})

// Caso real (Agustina Barbero): 2 lotes de la misma disciplina que vencen
// el MISMO día calendario en Argentina (típico de datos de antes del fix
// de zona horaria de la fusión, supabase_migration_fix_zona_horaria_fusion_
// lotes.sql, que quedaron en 2 filas separadas aunque deberían haber
// fusionado) se mostraban como líneas redundantes -- "8 vencen el 23/09 ·
// 4 vencen el 23/09" -- en vez de unificadas. Mismo agrupamiento que ya
// aplica formatCreditosDisponibles() del lado de la PWA (creditsApi.ts).
describe('VencimientoCell -- agrupa lotes que vencen el MISMO día calendario en Argentina (fix Agustina Barbero)', () => {
  it('2 lotes el mismo día -- se unifican en "Vence el dd/mm/yyyy" con la suma (mismo formato "1 lote" de siempre)', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      creditosPwaPorDisciplina: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 12,
          // 8 (10:00 UTC) + 4 (18:00 UTC) -- ambos caen en 23/09 hora
          // Argentina (UTC-3): 07:00 y 15:00 del mismo día.
          lotes: [
            { id: 'l1', remainingCredits: 8, expiresAt: '2026-09-23T10:00:00.000Z' },
            { id: 'l2', remainingCredits: 4, expiresAt: '2026-09-23T18:00:00.000Z' },
          ],
        },
      ],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Vence el 23/09/2026').length).toBeGreaterThan(0)
    expect(screen.queryByText(/vencen el/)).toBeNull()
  })

  it('lotes en DÍAS DISTINTOS siguen mostrándose separados -- sin cambios respecto de hoy', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      creditosPwaPorDisciplina: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 12,
          lotes: [
            { id: 'l1', remainingCredits: 8, expiresAt: '2026-09-20T12:00:00.000Z' },
            { id: 'l2', remainingCredits: 4, expiresAt: '2026-09-23T12:00:00.000Z' },
          ],
        },
      ],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('8 vencen el 20/09/2026 · 4 vencen el 23/09/2026').length).toBeGreaterThan(0)
  })
})

// Caso real (Agustina Barbero, DNI 43151174, plan=solo CrossFit):
// socios.fecha_vencimiento mostraba SIEMPRE que hubiera un valor y el
// socio estuviera activo, sin chequear si el socio REALMENTE tiene
// Aparatos/Pase Libre tildado -- una fecha residual (dato sucio, nunca le
// correspondió) se veía como una segunda fecha sin etiqueta,
// indistinguible de la de créditos reales. Ahora exige tener Aparatos o
// Pase Libre en el plan, y etiqueta TODO (Aparatos + créditos) apenas hay
// 2 o más líneas en total, no solo cuando hay 2+ disciplinas de créditos.
describe('VencimientoCell -- fecha_vencimiento solo se muestra si el socio tiene Aparatos/Pase Libre (fix Agustina Barbero)', () => {
  it('socio con 1 sola disciplina de créditos y SIN Aparatos: 1 fecha sin etiqueta, ni rastro de fecha_vencimiento', () => {
    const socio = {
      ...SOCIO_CON_FOTO, // plan: ['CrossFit']
      fechaVencimiento: '2026-09-11', // dato residual -- no le corresponde a nada de su plan actual
      creditosPwaPorDisciplina: [
        { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 12, lotes: [{ id: 'l1', remainingCredits: 12, expiresAt: '2026-09-23T12:00:00.000Z' }] },
      ],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Vence el 23/09/2026').length).toBeGreaterThan(0)
    // La fecha vieja (11/09) no aparece en NINGÚN lado de la fila.
    expect(screen.queryByText(/11\/09\/2026/)).toBeNull()
    expect(screen.queryByText(/CrossFit:/)).toBeNull() // 1 sola línea -- sin etiqueta
  })

  it('socio con Aparatos + 1 disciplina de créditos en fechas distintas: una sola línea con las 2 fechas', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      plan: ['CrossFit', 'Aparatos'],
      fechaVencimiento: '2026-11-10', // vigente -- ver fix de mostrarAparatos, ya compara contra la fecha real
      creditosPwaPorDisciplina: [
        { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 12, lotes: [{ id: 'l1', remainingCredits: 12, expiresAt: '2026-09-23T12:00:00.000Z' }] },
      ],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Aparatos vence el 10/11/2026 · CrossFit vence el 23/09/2026').length).toBeGreaterThan(0)
  })

  it('socio con 2 disciplinas de créditos en fechas distintas y SIN Aparatos: una sola línea, sin fecha_vencimiento residual', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      plan: ['CrossFit', 'Boxeo'],
      fechaVencimiento: '2026-09-11', // residual -- tampoco tiene que aparecer acá
      creditosPwaPorDisciplina: [
        { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 4, lotes: [{ id: 'l1', remainingCredits: 4, expiresAt: '2026-10-05T12:00:00.000Z' }] },
        { disciplineId: 'd-boxeo', disciplineName: 'Boxeo', remainingCredits: 2, lotes: [{ id: 'l2', remainingCredits: 2, expiresAt: '2026-11-01T12:00:00.000Z' }] },
      ],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('CrossFit vence el 05/10/2026 · Boxeo vence el 01/11/2026').length).toBeGreaterThan(0)
    expect(screen.queryByText(/11\/09\/2026/)).toBeNull()
  })

  it('socio con Aparatos solamente: 1 fecha sin etiqueta de disciplina, pero CON el prefijo "Vence el "', () => {
    const socio = { ...SOCIO_SIN_FOTO, fechaVencimiento: '2026-12-31' } // plan: ['Aparatos']
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Vence el 31/12/2026').length).toBeGreaterThan(0)
    expect(screen.queryByText(/Aparatos:/)).toBeNull()
  })
})

// Rediseño (agrupar Vencimiento por FECHA, no por disciplina): antes,
// 2 disciplinas que vencían el MISMO día se mostraban en líneas separadas
// con etiquetas distintas, repitiendo la fecha dos veces. Ahora se agrupa
// primero por fecha exacta (día calendario Argentina) y recién ahí se
// decide el texto -- "Ambos vencen"/"Las N disciplinas vencen" cuando
// TODO cae en una sola fecha, sin importar cuántas disciplinas sean.
describe('VencimientoCell -- agrupa por FECHA, no por disciplina (rediseño)', () => {
  it('2 disciplinas el MISMO día -- "Ambos vencen el dd/mm/yyyy"', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      plan: ['CrossFit', 'Aparatos'],
      fechaVencimiento: '2026-10-08',
      creditosPwaPorDisciplina: [
        { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 4, lotes: [{ id: 'l1', remainingCredits: 4, expiresAt: '2026-10-08T12:00:00.000Z' }] },
      ],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Ambos vencen el 08/10/2026').length).toBeGreaterThan(0)
  })

  it('3 disciplinas, todas el MISMO día -- "Las 3 disciplinas vencen el dd/mm/yyyy"', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      plan: ['CrossFit', 'Boxeo', 'Aparatos'],
      fechaVencimiento: '2026-10-08',
      creditosPwaPorDisciplina: [
        { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 4, lotes: [{ id: 'l1', remainingCredits: 4, expiresAt: '2026-10-08T12:00:00.000Z' }] },
        { disciplineId: 'd-boxeo', disciplineName: 'Boxeo', remainingCredits: 2, lotes: [{ id: 'l2', remainingCredits: 2, expiresAt: '2026-10-08T15:00:00.000Z' }] },
      ],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Las 3 disciplinas vencen el 08/10/2026').length).toBeGreaterThan(0)
  })

  // Caso del ticket -- 3 disciplinas, 2 fechas: Aparatos y CrossFit
  // comparten un día, Boxeo vence otro día distinto.
  it('3 disciplinas con 2+1 -- "Aparatos y CrossFit vencen el dd/mm · Boxeo vence el dd/mm"', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      plan: ['CrossFit', 'Boxeo', 'Aparatos'],
      fechaVencimiento: '2026-10-08',
      creditosPwaPorDisciplina: [
        { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 4, lotes: [{ id: 'l1', remainingCredits: 4, expiresAt: '2026-10-08T12:00:00.000Z' }] },
        { disciplineId: 'd-boxeo', disciplineName: 'Boxeo', remainingCredits: 2, lotes: [{ id: 'l2', remainingCredits: 2, expiresAt: '2026-10-15T12:00:00.000Z' }] },
      ],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Aparatos y CrossFit vencen el 08/10/2026 · Boxeo vence el 15/10/2026').length).toBeGreaterThan(0)
  })

  it('estilo visual unificado -- la línea de Aparatos usa la MISMA clase que la de créditos (sin distinción de tamaño/color)', () => {
    const socio = { ...SOCIO_SIN_FOTO, fechaVencimiento: '2026-12-31' } // plan: ['Aparatos']
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    const lineas = screen.getAllByText('Vence el 31/12/2026')
    expect(lineas.length).toBeGreaterThan(0)
    expect(lineas.every((el) => el.className.includes('text-xs') && el.className.includes('text-gray-400'))).toBe(true)
  })

  // FIX (modelo de "plan único", caso real Facundo Uria DNI 44537978) --
  // este loop iteraba antes planesDeCreditos(socio.plan) para decidir QUÉ
  // disciplinas de créditos buscar -- una con lotes activos pero SIN
  // tildar en el plan (Kickstrike) nunca se llegaba a buscar, así que
  // faltaba de esta celda igual que le faltaba a CreditosCell. Ahora
  // itera directo creditosPwaPorDisciplina.
  it('disciplina con lote activo, aunque NO esté tildada en socios.plan, aparece igual en el desglose (caso Kickstrike de Facundo)', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      plan: ['CrossFit', 'Boxeo'], // Kickstrike NO está en el plan
      creditosPwaPorDisciplina: [
        { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 12, lotes: [{ id: 'l1', remainingCredits: 12, expiresAt: '2026-10-08T12:00:00.000Z' }] },
        { disciplineId: 'd-kickstrike', disciplineName: 'Kickstrike', remainingCredits: 12, lotes: [{ id: 'l2', remainingCredits: 12, expiresAt: '2026-10-08T12:00:00.000Z' }] },
      ],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Ambos vencen el 08/10/2026').length).toBeGreaterThan(0)
  })
})

// Modelo de "un solo plan activo" (acreditar_pack): antes, mostrarAparatos
// dependía de `socio.estado === 'activo'` como proxy de "¿Aparatos sigue
// vigente?" -- `socio.estado` viene de estadoOperativoSocio(), que da una
// ventana de tolerancia de varios días antes de pasar a 'vencido'. Con
// fecha_vencimiento representando ahora específicamente la vigencia de
// Aparatos del ÚLTIMO pack (no la cuota general de siempre), esa ventana
// de gracia ya no tiene sentido -- si Aparatos no está genuinamente
// vigente, no se muestra nada, punto. Caso real: Facundo Uria, DNI
// 44537978 (compró un pack sin Aparatos, pero seguía viendo "Aparatos:
// Vence el ...").
describe('VencimientoCell -- Aparatos solo se muestra si está VIGENTE de verdad (fix Facundo Uria)', () => {
  it('Aparatos con fecha claramente pasada (reseteado por un pack sin Aparatos) -- NO se muestra nada de Aparatos', () => {
    const socio = { ...SOCIO_SIN_FOTO, estado: 'activo', fechaVencimiento: '2020-01-01' } // plan: ['Aparatos']
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.queryByText(/Vence el/)).toBeNull()
    expect(screen.queryByText(/2020/)).toBeNull()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('Aparatos con fecha reseteada, aunque socio.estado siga en "activo" (ventana de tolerancia) -- sigue sin mostrarse', () => {
    // Simula el caso real exacto: estadoOperativoSocio() todavía no pasó a
    // 'vencido' (dentro de dias_tolerancia), pero la fecha ya es pasada --
    // antes esto alcanzaba para seguir mostrando Aparatos.
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const fechaAyer = `${ayer.getFullYear()}-${String(ayer.getMonth() + 1).padStart(2, '0')}-${String(ayer.getDate()).padStart(2, '0')}`
    const socio = { ...SOCIO_SIN_FOTO, estado: 'activo', fechaVencimiento: fechaAyer }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.queryByText(/Vence el/)).toBeNull()
  })

  it('Aparatos genuinamente vigente -- sigue mostrándose normal', () => {
    const socio = { ...SOCIO_SIN_FOTO, estado: 'activo', fechaVencimiento: '2099-01-01' }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Vence el 01/01/2099').length).toBeGreaterThan(0)
  })

  it('socio.plan tildado en "Aparatos" pero sin ninguna fecha vigente -- tampoco se muestra (ya no depende de socio.plan/estado)', () => {
    const socio = { ...SOCIO_SIN_FOTO, plan: ['Aparatos'], estado: 'tolerancia', fechaVencimiento: '2020-06-15' }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.queryByText(/Vence el/)).toBeNull()
  })
})

// Bug real detectado en la auditoría de Socios: EstadoBadge ("Con
// Créditos"/"Sin Créditos") leía `socio.creditos` -- el pozo global viejo,
// que no se siembra al alta (sincronizarCreditosPwa solo escribe
// user_credits) ni baja con el consumo real (book_class/cancel_booking
// tampoco lo tocan). Ahora usa la misma fuente real que CreditosCell/
// VencimientoCell -- `socio.creditosPwaPorDisciplina` (suma de lotes
// activos) + `socio.fechaVencimiento` para Aparatos.
describe('EstadoBadge -- "Con/Sin Créditos" migrado a la fuente real (lotes activos), no socios.creditos', () => {
  it('caso "alta nueva": créditos reales pero socios.creditos=0 -- ahora muestra "Con Créditos"', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      creditos: 0, // el pozo global nunca se sembró al alta
      creditosPwaPorDisciplina: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 12, lotes: [{ id: 'l1', remainingCredits: 12, expiresAt: '2099-01-01T12:00:00.000Z' }] }],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Con Créditos').length).toBeGreaterThan(0)
    expect(screen.queryByText('Sin Créditos')).toBeNull()
  })

  it('caso "gastó todo": socios.creditos>0 pero sin ningún lote activo real -- ahora muestra "Sin Créditos"', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      creditos: 8, // el pozo global nunca bajó con el consumo real
      creditosPwaPorDisciplina: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 0, lotes: [] }],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Sin Créditos').length).toBeGreaterThan(0)
    expect(screen.queryByText('Con Créditos')).toBeNull()
  })

  it('Aparatos vigente sin créditos de otras disciplinas -- muestra "Con Créditos" (plan combinado)', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      plan: ['CrossFit', 'Aparatos'],
      creditos: 0,
      creditosPwaPorDisciplina: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 0, lotes: [] }],
      fechaVencimiento: '2099-01-01',
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Con Créditos').length).toBeGreaterThan(0)
    expect(screen.queryByText('Sin Créditos')).toBeNull()
  })

  it('sin créditos activos y sin Aparatos vigente -- sigue "Sin Créditos"', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      creditos: 0,
      creditosPwaPorDisciplina: [],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Sin Créditos').length).toBeGreaterThan(0)
    expect(screen.queryByText('Con Créditos')).toBeNull()
  })

  // Caso real (Agustina Barbero, DNI 43151174, plan=solo CrossFit): una
  // fecha_vencimiento residual (sin Aparatos real en el plan) NO tiene que
  // poder disfrazar a un socio sin créditos reales como "Con Créditos".
  it('fecha_vencimiento residual (futura) SIN Aparatos en el plan -- NO cuenta como "vigente", sigue "Sin Créditos"', () => {
    const socio = {
      ...SOCIO_CON_FOTO, // plan: ['CrossFit']
      creditos: 0,
      fechaVencimiento: '2099-01-01', // stray -- no le corresponde a nada de su plan actual
      creditosPwaPorDisciplina: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 0, lotes: [] }],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('Sin Créditos').length).toBeGreaterThan(0)
    expect(screen.queryByText('Con Créditos')).toBeNull()
  })
})
