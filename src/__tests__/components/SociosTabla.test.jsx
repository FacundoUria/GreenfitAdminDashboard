import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SociosTabla from '../../components/SociosTabla'

// La tabla renderiza SIEMPRE las dos variantes (tarjetas para mobile, tabla
// para desktop) -- jsdom no evalúa media queries, así que un mismo dato
// puede aparecer 2 veces en el árbol (una por variante). Se usa getAllBy*
// a propósito en vez de getBy* para no chocar con eso.

const HANDLERS = {
  onRegistrarPago: vi.fn(),
  onEditar: vi.fn(),
  onAjustarCredito: vi.fn(),
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
  plan: ['Aparatos / Musculación'],
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

// Bug crítico de sincronización (2026-08-07): un socio con más de una
// disciplina de créditos mostraba UN SOLO número global (socio.creditos)
// con un <select> oculto para elegir a cuál disciplina viajaba el ajuste --
// fácil de dejar en la disciplina equivocada. Fix: una fila por disciplina,
// cada una con su propio stepper y mostrando el balance REAL de la PWA
// (socio.creditosPwaPorDisciplina), nunca ambiguo sobre a cuál va el click.
describe('CreditosCell -- ajuste de créditos SIN AMBIGÜEDAD de disciplina (fix del bug Admin↔PWA)', () => {
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

  it('ya NO existe el selector "Disciplina a ajustar" -- cada disciplina tiene su propia fila con steppers propios', () => {
    render(<SociosTabla socios={[SOCIO_MULTI_DISCIPLINA]} {...HANDLERS} />)
    expect(screen.queryByLabelText('Disciplina a ajustar')).toBeNull()
    expect(screen.getAllByText('CrossFit').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Boxeo').length).toBeGreaterThan(0)
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

  it('tocar "+4" en la fila de Boxeo llama a onAjustarCredito con la disciplina Boxeo -- NUNCA CrossFit por default', () => {
    render(<SociosTabla socios={[SOCIO_MULTI_DISCIPLINA]} {...HANDLERS} />)
    const botonesBoxeo = screen.getAllByTitle('Asignar pack de 4 créditos a Boxeo')
    fireEvent.click(botonesBoxeo[0])
    expect(HANDLERS.onAjustarCredito).toHaveBeenCalledWith(SOCIO_MULTI_DISCIPLINA, 4, 'Boxeo')
  })

  it('tocar "+1" en la fila de CrossFit llama a onAjustarCredito con la disciplina CrossFit', () => {
    render(<SociosTabla socios={[SOCIO_MULTI_DISCIPLINA]} {...HANDLERS} />)
    const masCrossfit = screen.getAllByTitle('Sumar 1 crédito a CrossFit')
    fireEvent.click(masCrossfit[0])
    expect(HANDLERS.onAjustarCredito).toHaveBeenCalledWith(SOCIO_MULTI_DISCIPLINA, 1, 'CrossFit')
  })

  it('con una sola disciplina de créditos, no repite el nombre como etiqueta de fila (no hace falta desambiguar)', () => {
    const socioUnaDisciplina = { ...SOCIO_CON_FOTO, creditosPwaPorDisciplina: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 4 }] }
    render(<SociosTabla socios={[socioUnaDisciplina]} {...HANDLERS} />)
    // Los títulos de los botones SÍ mencionan la disciplina (son el
    // contrato con onAjustarCredito) -- lo que no debe aparecer es la
    // etiqueta de fila en mayúsculas que se agrega solo cuando hay 2+.
    expect(screen.queryByText('CROSSFIT')).toBeNull()
  })

  it('sin fetchCreditosPorDisciplina resuelto todavía (creditosPwaPorDisciplina ausente), muestra 0 en vez de romper', () => {
    const socioSinBatchTodavia = { ...SOCIO_CON_FOTO }
    delete socioSinBatchTodavia.creditosPwaPorDisciplina
    render(<SociosTabla socios={[socioSinBatchTodavia]} {...HANDLERS} />)
    const celdas = screen.getAllByTitle('Créditos reales de CrossFit en la app')
    expect(celdas.every((el) => el.textContent === '0')).toBe(true)
  })
})
