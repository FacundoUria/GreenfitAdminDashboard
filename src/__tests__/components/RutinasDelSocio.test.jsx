import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// Historial de rutinas (F1): rutina actual arriba, "Historial de rutinas" abajo (más
// nueva primero), cada una se abre en solo lectura; "Volver a asignar" (con
// confirmación) solo con acciones. El mismo componente vive en la Ficha 360° (sin
// acciones) y en Rutinas > Asignación (con acciones).

vi.mock('../../utils/routinesApi', () => ({
  asignarRutina: vi.fn(),
  fetchEntrenamientosPorRutina: vi.fn(),
  fetchRoutineFull: vi.fn(),
  fetchRutinasDelSocio: vi.fn(),
  fetchSesionesDeRutina: vi.fn(),
}))

import * as api from '../../utils/routinesApi'
import RutinasDelSocio from '../../components/rutinas/RutinasDelSocio'

const VIGENTE = { id: 'r-3', title: 'Hipertrofia', vigenteDesde: '2026-10-01T13:00:00Z', vigenteHasta: null }
const ANTERIORES = [
  { id: 'r-2', title: 'Fuerza', vigenteDesde: '2026-08-01T13:00:00Z', vigenteHasta: '2026-10-01T13:00:00Z' },
  { id: 'r-1', title: 'Adaptación', vigenteDesde: '2026-06-01T13:00:00Z', vigenteHasta: '2026-08-01T13:00:00Z' },
]
const FULL = (id, title, extra = {}) => ({
  id,
  title,
  notes: '',
  vigenteDesde: '2026-10-01T13:00:00Z',
  vigenteHasta: null,
  days: [
    {
      id: `${id}-d1`,
      title: 'Día 1',
      exercises: [
        { id: `${id}-e1`, exerciseName: 'Sentadilla', muscleGroup: 'Piernas', sets: 4, reps: '8', restSeconds: 90, weightSuggestion: '60kg', notes: '' },
      ],
    },
  ],
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchRutinasDelSocio.mockResolvedValue({ vigente: VIGENTE, anteriores: ANTERIORES })
  api.fetchEntrenamientosPorRutina.mockResolvedValue(new Map([['r-2', 7]]))
  api.fetchRoutineFull.mockImplementation(async (id) =>
    id === 'r-2'
      ? FULL('r-2', 'Fuerza', { vigenteDesde: '2026-08-01T13:00:00Z', vigenteHasta: '2026-10-01T13:00:00Z' })
      : FULL(id, 'Hipertrofia'),
  )
  api.fetchSesionesDeRutina.mockResolvedValue([])
})

describe('RutinasDelSocio', () => {
  it('rutina actual arriba (con su fecha de inicio) y el historial abajo, del más nuevo al más viejo, con fechas y entrenamientos', async () => {
    render(<RutinasDelSocio userId="u-1" />)

    const actual = await screen.findByRole('region', { name: 'Rutina actual' })
    expect(within(actual).getByText('Hipertrofia')).toBeTruthy()
    expect(within(actual).getByText(/Desde el 01\/10\/2026/)).toBeTruthy()
    expect(within(actual).getByText(/Día 1/)).toBeTruthy()

    const historial = screen.getByRole('region', { name: 'Historial de rutinas' })
    expect(within(historial).getByText('Historial de rutinas (2)')).toBeTruthy()
    const titulos = within(historial).getAllByText(/^(Fuerza|Adaptación)$/).map((n) => n.textContent)
    expect(titulos).toEqual(['Fuerza', 'Adaptación'])
    expect(within(historial).getByText(/Del 01\/08\/2026 al 01\/10\/2026 · 7 entrenamientos/)).toBeTruthy()
    expect(within(historial).getByText(/Del 01\/06\/2026 al 01\/08\/2026$/)).toBeTruthy()
  })

  it('sin acciones (Ficha 360°): no hay Editar ni Volver a asignar, pero se puede ver cada una', async () => {
    render(<RutinasDelSocio userId="u-1" />)
    await screen.findByText('Hipertrofia')
    expect(screen.queryByRole('button', { name: /editar/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /volver a asignar/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Ver Fuerza' })).toBeTruthy()
  })

  it('"Ver" abre la rutina anterior en solo lectura: sin inputs, con su aviso y sus entrenamientos', async () => {
    api.fetchSesionesDeRutina.mockResolvedValue([
      {
        sesionId: 's-1',
        creadoEn: '2026-09-10T22:00:00Z',
        tituloDia: 'Día 1',
        totalEjercicios: 1,
        oculta: true,
        ejercicios: [{ id: 'h-1', nombre: 'Sentadilla', series: 4, repeticiones: '8', peso: '62kg' }],
      },
    ])
    render(<RutinasDelSocio userId="u-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver Fuerza' }))

    const modal = await screen.findByRole('dialog', { name: 'Detalle de la rutina' })
    await waitFor(() => expect(within(modal).getByText(/Rutina del historial: solo lectura/)).toBeTruthy())
    expect(within(modal).getByText('Del 01/08/2026 al 01/10/2026')).toBeTruthy()
    expect(within(modal).getByText(/4 × 8 · 90 s · Carga sugerida 60kg/)).toBeTruthy()
    expect(within(modal).getByText('Entrenamientos registrados en esta rutina (1)')).toBeTruthy()
    expect(within(modal).getByText(/62kg/)).toBeTruthy()
    expect(within(modal).getByText('Oculto por el socio')).toBeTruthy()
    expect(modal.querySelectorAll('input, textarea, select')).toHaveLength(0)
    expect(api.fetchSesionesDeRutina).toHaveBeenCalledWith('r-2')
  })

  it('con acciones: "Volver a asignar" pide confirmación (nombrando la actual) y asigna esa rutina', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    api.asignarRutina.mockResolvedValue('r-4')
    const onCambio = vi.fn()
    render(<RutinasDelSocio userId="u-1" acciones onCambio={onCambio} onEditarVigente={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Volver a asignar Fuerza' }))

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('La rutina actual ("Hipertrofia") pasa al historial'))
    await waitFor(() => expect(api.asignarRutina).toHaveBeenCalledWith('u-1', 'r-2'))
    await waitFor(() => expect(onCambio).toHaveBeenCalled())
    // Recarga la lista.
    await waitFor(() => expect(api.fetchRutinasDelSocio).toHaveBeenCalledTimes(2))
    confirmSpy.mockRestore()
  })

  it('si cancela la confirmación, no asigna nada', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<RutinasDelSocio userId="u-1" acciones />)
    fireEvent.click(await screen.findByRole('button', { name: 'Volver a asignar Adaptación' }))
    expect(api.asignarRutina).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('con acciones: "Editar" es solo para la vigente', async () => {
    const onEditarVigente = vi.fn()
    render(<RutinasDelSocio userId="u-1" acciones onEditarVigente={onEditarVigente} />)
    const editar = await screen.findAllByRole('button', { name: /editar/i })
    expect(editar).toHaveLength(1)
    fireEvent.click(editar[0])
    expect(onEditarVigente).toHaveBeenCalledWith('r-3')
  })

  it('sin rutina: lo dice, y con acciones ofrece crear una desde cero; avisa al padre que no hay vigente', async () => {
    api.fetchRutinasDelSocio.mockResolvedValue({ vigente: null, anteriores: [] })
    const onCrearRutina = vi.fn()
    const onCargado = vi.fn()
    render(<RutinasDelSocio userId="u-1" acciones onCrearRutina={onCrearRutina} onCargado={onCargado} />)

    expect(await screen.findByText('Este socio todavía no tiene una rutina asignada.')).toBeTruthy()
    expect(screen.getByText('Todavía no tiene rutinas anteriores.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /crear rutina desde cero/i }))
    expect(onCrearRutina).toHaveBeenCalled()
    expect(onCargado).toHaveBeenCalledWith(null)
  })

  it('si falla el conteo de entrenamientos, la lista se muestra igual', async () => {
    api.fetchEntrenamientosPorRutina.mockRejectedValue(new Error('permission denied'))
    render(<RutinasDelSocio userId="u-1" />)
    expect(await screen.findByText('Fuerza')).toBeTruthy()
  })
})
