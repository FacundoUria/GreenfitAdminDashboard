import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Switch "Todas las semanas / Una sola vez" de Nueva clase / Editar clase.

const estado = { payloads: [], respuesta: null }

vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (tabla) => {
      if (tabla === 'disciplines') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => Promise.resolve({ data: [{ id: 'd1', name: 'CrossFit', is_active: true }], error: null }),
        }
        return chain
      }
      // classes: insert(...).select() / update(...).eq(...).select()
      const guardar = (payload) => {
        estado.payloads.push(payload)
        const fin = { select: () => Promise.resolve(estado.respuesta ?? { data: [{ id: 'c-nueva' }], error: null }) }
        return { ...fin, eq: () => fin }
      }
      return { insert: guardar, update: guardar }
    },
  },
}))

import NuevaClaseModal from '../../components/NuevaClaseModal'

const HOY = '2026-10-28' // miércoles

function abrir(props = {}) {
  const onSaved = vi.fn()
  render(<NuevaClaseModal diaPorDefecto={3} hoy={HOY} fechaPorDefecto="2026-11-04" onClose={vi.fn()} onSaved={onSaved} {...props} />)
  return { onSaved }
}

async function completarYGuardar() {
  fireEvent.change(screen.getByLabelText('Título de la clase'), { target: { value: 'Clase especial' } })
  fireEvent.change(screen.getByLabelText('Profesor'), { target: { value: 'Seba' } })
  await waitFor(() => expect(screen.getByLabelText('Disciplina').value).toBe('d1'))
  fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
}

beforeEach(() => {
  estado.payloads = []
  estado.respuesta = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('NuevaClaseModal -- Todas las semanas / Una sola vez', () => {
  it('arranca en "Todas las semanas" con los días de la semana, como siempre', () => {
    abrir()
    expect(screen.getByRole('radio', { name: 'Todas las semanas' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Días de la semana')).toBeTruthy()
    expect(screen.queryByLabelText('Fecha')).toBeNull()
  })

  it('"Una sola vez" cambia los días por una fecha, con mínimo hoy y la fecha escrita', () => {
    abrir()
    fireEvent.click(screen.getByRole('radio', { name: 'Una sola vez' }))
    const fecha = screen.getByLabelText('Fecha')
    expect(fecha.getAttribute('min')).toBe(HOY)
    expect(fecha.value).toBe('2026-11-04')
    expect(screen.getByText('Solo el Miércoles 4 de noviembre. No se repite.')).toBeTruthy()
    expect(screen.queryByText('Días de la semana')).toBeNull()
  })

  it('guardar "Una sola vez" manda fecha_unica y days_of_week = {día de esa fecha}', async () => {
    const { onSaved } = abrir()
    fireEvent.click(screen.getByRole('radio', { name: 'Una sola vez' }))
    fireEvent.change(screen.getByLabelText('Fecha'), { target: { value: '2026-11-05' } })
    await completarYGuardar()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(estado.payloads[0]).toMatchObject({ days_of_week: [4], fecha_unica: '2026-11-05', title: 'Clase especial' })
  })

  it('guardar "Todas las semanas" manda fecha_unica: null', async () => {
    const { onSaved } = abrir()
    await completarYGuardar()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(estado.payloads[0]).toMatchObject({ days_of_week: [3], fecha_unica: null })
  })

  it('una fecha anterior a hoy no se manda', async () => {
    abrir()
    fireEvent.click(screen.getByRole('radio', { name: 'Una sola vez' }))
    fireEvent.change(screen.getByLabelText('Fecha'), { target: { value: '2026-10-27' } })
    await completarYGuardar()
    // El `min` del input ya frena el botón (como el navegador). Si igual llega
    // el submit (ej. navegador sin validación nativa), la validación propia lo frena.
    expect(estado.payloads).toEqual([])
    fireEvent.submit(screen.getByRole('button', { name: 'Guardar' }).closest('form'))
    expect(await screen.findByText('La fecha no puede ser anterior a hoy.')).toBeTruthy()
    expect(estado.payloads).toEqual([])
  })

  it('si la base lo frena por reservas futuras, se muestra su mensaje (qué fechas y qué hacer)', async () => {
    const mensaje =
      'Hay reservas de hoy en adelante en fechas donde la clase ya no se dictaría: 11/11 (2). Cancelá primero la clase en esas fechas (reintegra el crédito y avisa a los socios).'
    estado.respuesta = { data: null, error: { message: mensaje } }
    const { onSaved } = abrir({
      clase: {
        id: 'c1',
        disciplina: 'CrossFit',
        disciplinaId: 'd1',
        profesor: 'Seba',
        diasSemana: [3],
        fechaUnica: null,
        horaInicio: '19:00',
        horaFin: '20:00',
        cupoMaximo: 20,
      },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Una sola vez' }))
    await waitFor(() => expect(screen.getByLabelText('Disciplina').value).toBe('d1'))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(await screen.findByText(mensaje)).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('editar una de una sola vez abre en "Una sola vez" con su fecha; pasar a semanal arranca en su día', () => {
    abrir({
      clase: {
        id: 'c2',
        disciplina: 'Especial',
        disciplinaId: 'd1',
        profesor: 'Seba',
        diasSemana: [3],
        fechaUnica: '2026-11-04',
        horaInicio: '19:00',
        horaFin: '20:00',
        cupoMaximo: 20,
      },
    })
    expect(screen.getByRole('radio', { name: 'Una sola vez' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('Fecha').value).toBe('2026-11-04')
    fireEvent.click(screen.getByRole('radio', { name: 'Todas las semanas' }))
    expect(screen.getByRole('button', { name: 'Miércoles' }).className).toMatch(/bg-greenfit-primary/)
  })
})
