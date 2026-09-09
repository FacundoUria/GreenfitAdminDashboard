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

  // Caso real reportado: la grilla mostraba 0 créditos de Kickstrike aunque
  // la PWA sí tuviera un balance real -- socios.plan decía "Kickstrike"
  // pero disciplineName (que sale de disciplines.name, el catálogo real)
  // podía diferir solo en mayúsculas ("kickstrike") por una fila duplicada
  // de catálogo. Antes el Map de balances usaba la clave EXACTA -- ese
  // desfase de tipeo alcanzaba para que nunca matcheara.
  it('el balance real matchea aunque disciplineName difiera en mayúsculas/minúsculas de socios.plan', () => {
    const socioKickstrike = {
      ...SOCIO_MULTI_DISCIPLINA,
      plan: ['Kickstrike'],
      creditosPwaPorDisciplina: [{ disciplineId: 'd-kickstrike', disciplineName: 'kickstrike', remainingCredits: 11 }],
    }
    render(<SociosTabla socios={[socioKickstrike]} {...HANDLERS} />)
    const celdas = screen.getAllByTitle('Créditos reales de Kickstrike en la app')
    expect(celdas.every((el) => el.textContent === '11')).toBe(true)
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

  it('sin fetchCreditosPorDisciplina resuelto todavía (creditosPwaPorDisciplina ausente), muestra 0 en vez de romper', () => {
    const socioSinBatchTodavia = { ...SOCIO_CON_FOTO }
    delete socioSinBatchTodavia.creditosPwaPorDisciplina
    render(<SociosTabla socios={[socioSinBatchTodavia]} {...HANDLERS} />)
    const celdas = screen.getAllByTitle('Créditos reales de CrossFit en la app')
    expect(celdas.every((el) => el.textContent === '0')).toBe(true)
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

  it('con 2+ disciplinas de créditos, cada línea antepone el nombre de la disciplina', () => {
    const socio = {
      ...SOCIO_CON_FOTO,
      plan: ['CrossFit', 'Boxeo'],
      creditosPwaPorDisciplina: [
        { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 4, lotes: [{ id: 'l1', remainingCredits: 4, expiresAt: '2026-10-05T12:00:00.000Z' }] },
        { disciplineId: 'd-boxeo', disciplineName: 'Boxeo', remainingCredits: 2, lotes: [{ id: 'l2', remainingCredits: 2, expiresAt: '2026-11-01T12:00:00.000Z' }] },
      ],
    }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('CrossFit: Vence el 05/10/2026').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Boxeo: Vence el 01/11/2026').length).toBeGreaterThan(0)
  })

  it('Aparatos (membresía) sigue mostrándose exactamente igual -- sin cambios', () => {
    const socio = { ...SOCIO_SIN_FOTO, fechaVencimiento: '2026-12-31' }
    render(<SociosTabla socios={[socio]} {...HANDLERS} />)
    expect(screen.getAllByText('31/12/2026').length).toBeGreaterThan(0)
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
})
