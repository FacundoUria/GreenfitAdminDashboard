import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../../lib/supabaseClient'
import NuevoSocioModal from '../../components/NuevoSocioModal'

// BUG CRÍTICO (2026-08-07): el formulario de "Nuevo Socio" arrancaba con
// 'Pase Libre' YA TILDADO (PLANES_DISPONIBLES[0]) -- si el staff cargaba un
// socio de Kickstrike/CrossFit sin destildarlo a mano, el socio quedaba con
// un plan extra que nunca pidió ('Pase Libre'), que además termina
// sincronizando un balance de Aparatos en la PWA (ver el comentario de
// formInicial() en NuevoSocioModal.jsx). Ninguna disciplina debe empezar
// pre-seleccionada -- el staff elige cada actividad real a mano. Esto es
// SOLO de alta -- en edición los checkboxes ya no son libremente
// tildables, ver el describe de más abajo.
describe('NuevoSocioModal -- ningún plan arranca pre-tildado en el ALTA (fix del bug de disciplinas fantasma)', () => {
  it('alta nueva: todos los checkboxes de Planes/Actividades arrancan sin marcar', () => {
    render(<NuevoSocioModal onClose={vi.fn()} onSaved={vi.fn()} />)
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.length).toBeGreaterThan(0)
    expect(checkboxes.every((cb) => !cb.checked)).toBe(true)
  })
})

// FIX (checkboxes "reflejan la realidad", caso real Valentina Ramon): los
// checkboxes de Planes/Actividades en Editar Socio dejaron de leer
// socio.plan (un campo editado a mano, desincronizado de la realidad --
// Valentina figuraba con CrossFit activo sin tenerlo tildado). Ahora se
// calculan en vivo: tildado = tiene un lote de créditos activo, o es
// Aparatos con fecha_vencimiento en el futuro. Una disciplina sin nada
// activo se muestra destildada Y DESHABILITADA (tildarla acá no acredita
// nada); la única acción posible es destildar una activa, que la saca del
// socio (con confirmación) vía admin_quitar_disciplina_socio.
describe('NuevoSocioModal -- edición: los checkboxes reflejan lo que el socio tiene activo HOY (fix Valentina Ramon)', () => {
  const DISCIPLINAS_ACTIVAS = [
    { id: 'd-crossfit', name: 'CrossFit', kind: 'credits' },
    { id: 'd-boxeo', name: 'Boxeo', kind: 'credits' },
    { id: 'd-kickstrike', name: 'Kickstrike', kind: 'credits' },
    { id: 'd-aparatos', name: 'Aparatos', kind: 'membership' },
  ]

  // Caso real del ticket: CrossFit y Kickstrike activos, Aparatos no --
  // plan (texto legacy) queda deliberadamente desalineado, para probar que
  // ya no se lee para nada.
  const SOCIO_CROSSFIT_KICKSTRIKE = {
    id: 's-edicion-1',
    nombre: 'Facundo',
    apellido: 'Uria',
    dni: '44537978',
    email: 'facu@test.com',
    telefono: '',
    plan: ['Boxeo'],
    fechaVencimiento: null,
    creditosPwaPorDisciplina: [
      { disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 12 },
      { disciplineId: 'd-kickstrike', disciplineName: 'Kickstrike', remainingCredits: 12 },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    supabase.from.mockReset()
  })

  it('CrossFit+Kickstrike activos, Aparatos no -- los checkboxes muestran exactamente eso, Aparatos deshabilitado', () => {
    render(
      <NuevoSocioModal socio={SOCIO_CROSSFIT_KICKSTRIKE} disciplinasActivas={DISCIPLINAS_ACTIVAS} onClose={vi.fn()} onSaved={vi.fn()} />,
    )

    const crossfit = screen.getByRole('checkbox', { name: 'CrossFit' })
    const kickstrike = screen.getByRole('checkbox', { name: 'Kickstrike' })
    const boxeo = screen.getByRole('checkbox', { name: 'Boxeo' })
    const aparatos = screen.getByRole('checkbox', { name: 'Aparatos' })

    expect(crossfit.checked).toBe(true)
    expect(crossfit.disabled).toBe(false)
    expect(kickstrike.checked).toBe(true)
    expect(kickstrike.disabled).toBe(false)
    // Boxeo está en socio.plan (texto legacy) pero SIN ningún crédito
    // activo real -- tiene que aparecer destildado y deshabilitado.
    expect(boxeo.checked).toBe(false)
    expect(boxeo.disabled).toBe(true)
    expect(aparatos.checked).toBe(false)
    expect(aparatos.disabled).toBe(true)
  })

  it('intentar tildar Boxeo (sin créditos activos) -- el checkbox está deshabilitado, clickearlo no lo tilda', () => {
    render(
      <NuevoSocioModal socio={SOCIO_CROSSFIT_KICKSTRIKE} disciplinasActivas={DISCIPLINAS_ACTIVAS} onClose={vi.fn()} onSaved={vi.fn()} />,
    )
    const boxeo = screen.getByRole('checkbox', { name: 'Boxeo' })
    expect(boxeo.disabled).toBe(true)
    fireEvent.click(boxeo)
    expect(boxeo.checked).toBe(false)
  })

  it('destildar CrossFit y confirmar -- llama a admin_quitar_disciplina_socio con su discipline_id, Kickstrike no se toca', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    supabase.from.mockImplementation((tabla) => {
      if (tabla === 'profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'user-1' }, error: null }) }) }) }
      }
      if (tabla === 'socios') {
        return {
          update: () => ({
            eq: () => ({ select: () => Promise.resolve({ data: [{ id: SOCIO_CROSSFIT_KICKSTRIKE.id }], error: null }) }),
          }),
        }
      }
      throw new Error(`tabla inesperada: ${tabla}`)
    })
    supabase.rpc.mockResolvedValue({ data: null, error: null })

    render(
      <NuevoSocioModal socio={SOCIO_CROSSFIT_KICKSTRIKE} disciplinasActivas={DISCIPLINAS_ACTIVAS} onClose={vi.fn()} onSaved={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'CrossFit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('CrossFit'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Perderá sus 12 créditos activos de CrossFit.'))

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_quitar_disciplina_socio', {
        p_user_id: 'user-1',
        p_discipline_id: 'd-crossfit',
      }),
    )
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      'admin_quitar_disciplina_socio',
      expect.objectContaining({ p_discipline_id: 'd-kickstrike' }),
    )
    // Sigue con el resto del guardado -- el UPDATE de socios se llega a disparar.
    await waitFor(() => expect(supabase.from).toHaveBeenCalledWith('socios'))
  })

  it('destildar CrossFit y CANCELAR la confirmación -- no cambia nada, el checkbox vuelve a tildado', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(
      <NuevoSocioModal socio={SOCIO_CROSSFIT_KICKSTRIKE} disciplinasActivas={DISCIPLINAS_ACTIVAS} onClose={vi.fn()} onSaved={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'CrossFit' }))
    expect(screen.getByRole('checkbox', { name: 'CrossFit' }).checked).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(window.confirm).toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
    // CreditosEditablesSocio.jsx consulta 'profiles' solo (sin credenciales)
    // apenas monta, independiente de este flujo -- lo que importa acá es
    // que el guardado real ('socios') nunca se dispara.
    expect(supabase.from).not.toHaveBeenCalledWith('socios')
    // Vuelve a mostrarse tildado -- se deshizo el destilde local.
    expect(screen.getByRole('checkbox', { name: 'CrossFit' }).checked).toBe(true)
  })

  // Caso límite real del ticket: Aparatos es lo ÚNICO activo -- destildarlo
  // deja al socio sin ninguna disciplina, y eso tiene que poder guardarse
  // igual (no es alta, "quedarse sin nada" es un resultado válido de sacar
  // la última disciplina).
  const SOCIO_SOLO_APARATOS = {
    id: 's-edicion-2',
    nombre: 'Marina',
    apellido: 'Gómez',
    dni: '30555444',
    email: 'marina@test.com',
    telefono: '',
    plan: [],
    fechaVencimiento: '2099-01-01',
    creditosPwaPorDisciplina: [],
  }

  it('destildar Aparatos (lo único activo) y confirmar -- llama a admin_quitar_disciplina_socio con su discipline_id, se apaga', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    supabase.from.mockImplementation((tabla) => {
      if (tabla === 'profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'user-2' }, error: null }) }) }) }
      }
      if (tabla === 'socios') {
        return {
          update: () => ({
            eq: () => ({ select: () => Promise.resolve({ data: [{ id: SOCIO_SOLO_APARATOS.id }], error: null }) }),
          }),
        }
      }
      throw new Error(`tabla inesperada: ${tabla}`)
    })
    supabase.rpc.mockResolvedValue({ data: null, error: null })

    render(
      <NuevoSocioModal socio={SOCIO_SOLO_APARATOS} disciplinasActivas={DISCIPLINAS_ACTIVAS} onClose={vi.fn()} onSaved={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'Aparatos' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Perderá el acceso a Aparatos.'))
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_quitar_disciplina_socio', {
        p_user_id: 'user-2',
        p_discipline_id: 'd-aparatos',
      }),
    )
    // No se bloquea por "seleccioná al menos un plan" -- eso es solo para el alta.
    expect(screen.queryByText('Seleccioná al menos un plan/actividad.')).toBeNull()
  })
})

// Antes, el Admin no validaba el formato de DNI en ningún lado -- un DNI mal
// tipeado se guardaba sin error visible, y como no matcheaba el mismo patrón
// que usa el trigger handle_socio_dni_upsert() en SQL, el socio quedaba con
// su ficha completa acá pero SIN cuenta de PWA, sin que nadie se enterara.
// Mismo patrón ^\d{6,10}$ que ya usa isValidDni() en la PWA (dni.ts).
describe('NuevoSocioModal -- valida el formato de DNI antes de guardar (mismo patrón que la PWA)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    supabase.from.mockReset()
  })

  function completarCamposObligatorios() {
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Facundo' } })
    fireEvent.change(screen.getByLabelText('Apellido'), { target: { value: 'Test' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'facu@test.com' } })
  }

  it('DNI con letras: bloquea el guardado con un error claro, sin llamar a Supabase', () => {
    render(<NuevoSocioModal onClose={vi.fn()} onSaved={vi.fn()} />)
    completarCamposObligatorios()
    fireEvent.change(screen.getByLabelText('DNI'), { target: { value: '30abc999' } })

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(screen.getByText(/DNI tiene que tener entre 6 y 10 dígitos/)).toBeTruthy()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('DNI de menos de 6 dígitos: bloquea el guardado', () => {
    render(<NuevoSocioModal onClose={vi.fn()} onSaved={vi.fn()} />)
    completarCamposObligatorios()
    fireEvent.change(screen.getByLabelText('DNI'), { target: { value: '123' } })

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(screen.getByText(/DNI tiene que tener entre 6 y 10 dígitos/)).toBeTruthy()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('DNI de más de 10 dígitos: bloquea el guardado', () => {
    render(<NuevoSocioModal onClose={vi.fn()} onSaved={vi.fn()} />)
    completarCamposObligatorios()
    fireEvent.change(screen.getByLabelText('DNI'), { target: { value: '123456789012' } })

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(screen.getByText(/DNI tiene que tener entre 6 y 10 dígitos/)).toBeTruthy()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('DNI válido (7 dígitos) y al menos un plan: no bloquea por el DNI -- sigue de largo hasta guardar en Supabase', () => {
    // 'socios': el alta real. 'profiles': lo consulta esperarCuentaPwa() justo
    // después del insert (espera a que el trigger on_socio_dni_upsert termine
    // de aprovisionar la cuenta de la PWA) -- sin mockear esta segunda tabla
    // también, esa llamada revienta con un TypeError asíncrono no manejado.
    supabase.from.mockImplementation((tabla) => {
      if (tabla === 'socios') {
        return { insert: () => ({ select: () => Promise.resolve({ data: [{ id: 'nuevo-1' }], error: null }) }) }
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }
    })
    render(<NuevoSocioModal onClose={vi.fn()} onSaved={vi.fn()} />)
    completarCamposObligatorios()
    fireEvent.change(screen.getByLabelText('DNI'), { target: { value: '3099988' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'CrossFit' }))

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(screen.queryByText(/DNI tiene que tener entre 6 y 10 dígitos/)).toBeNull()
    expect(supabase.from).toHaveBeenCalledWith('socios')
  })
})

// Sentido inverso de la sincronización PWA -> Admin (sincronizar_telefono_a_socio,
// ProfileScreen.tsx del otro repo): si Seba edita el teléfono de un socio ya
// existente desde el panel, tiene que reflejarse en profiles.phone -- antes
// de este fix, el socio seguía viendo su teléfono viejo en su propio perfil
// de la PWA para siempre.
describe('NuevoSocioModal -- sincroniza el teléfono editado con profiles.phone (RPC sincronizar_telefono_a_profile)', () => {
  // Necesita al menos una disciplina activa real -- sin ninguna, el modal
  // de edición no tendría nada que guardar salvo en el caso explícito de
  // "sacar la última" (ver el describe de arriba), que no es lo que este
  // describe está probando.
  const socioExistente = {
    id: 's-edit-1',
    nombre: 'Marina',
    apellido: 'Gómez',
    dni: '30555444',
    email: 'marina@test.com',
    telefono: '2610000000',
    plan: ['Boxeo'],
    fechaVencimiento: null,
    creditosPwaPorDisciplina: [{ disciplineId: 'd-boxeo', disciplineName: 'Boxeo', remainingCredits: 4 }],
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('editar el teléfono de un socio existente llama a sincronizar_telefono_a_profile con el DNI y el teléfono nuevo', async () => {
    supabase.from.mockReturnValue({
      update: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [{ id: socioExistente.id }], error: null }) }) }),
    })
    supabase.rpc.mockResolvedValue({ data: null, error: null })

    render(<NuevoSocioModal socio={socioExistente} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Teléfono'), { target: { value: '2610009999' } })

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('sincronizar_telefono_a_profile', {
        p_dni: '30555444',
        p_telefono: '2610009999',
      }),
    )
  })

  it('un alta nueva (socio recién creado) NO llama a sincronizar_telefono_a_profile -- ya le llega solo vía el trigger on_socio_dni_upsert', async () => {
    supabase.from.mockImplementation((tabla) => {
      if (tabla === 'socios') {
        return { insert: () => ({ select: () => Promise.resolve({ data: [{ id: 'nuevo-2' }], error: null }) }) }
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }
    })

    render(<NuevoSocioModal onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Nuevo' } })
    fireEvent.change(screen.getByLabelText('Apellido'), { target: { value: 'Socio' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nuevo@test.com' } })
    fireEvent.change(screen.getByLabelText('DNI'), { target: { value: '3099988' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'CrossFit' }))

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(supabase.from).toHaveBeenCalledWith('socios'))
    expect(supabase.rpc).not.toHaveBeenCalledWith('sincronizar_telefono_a_profile', expect.anything())
  })

  it('si la sincronización de teléfono falla, no bloquea el guardado (best-effort, no crítico)', async () => {
    const onSaved = vi.fn()
    const onClose = vi.fn()
    supabase.from.mockReturnValue({
      update: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [{ id: socioExistente.id }], error: null }) }) }),
    })
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'function not found in schema cache' } })

    render(<NuevoSocioModal socio={socioExistente} onClose={onClose} onSaved={onSaved} />)
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })
})

// Caso real (Agustina Barbero, DNI 43151174, plan=solo CrossFit): este
// campo escribe SIEMPRE en socios.fecha_vencimiento, sin importar el plan
// -- la MISMA columna que SociosTabla.jsx ya no muestra para un socio sin
// Aparatos/Pase Libre. No se oculta acá (un socio 100% créditos SÍ tiene
// que poder renovar su vencimiento, ver editar-vencimiento.spec.js) --
// pero la etiqueta ahora aclara siempre a qué disciplina se aplica, para
// que no se confunda con "el vencimiento de Aparatos" cuando el socio no
// lo tiene.
//
// Sigue leyendo form.planes (socio.plan), a propósito NO planesActuales --
// es un campo aparte de este ticket (checkboxes "reflejan la realidad"):
// existe justamente para poder corregir a mano la fecha de un socio SIN
// nada realmente activo hoy (ver "Editar Socio (aislado): sigue mostrando
// la fecha_vencimiento REAL y vencida" en fecha-inteligente-cobro.spec.js)
// -- gatearlo por lo realmente activo lo ocultaría justo en ese caso.
describe('NuevoSocioModal -- el campo de vencimiento aclara a qué disciplina se aplica (fix Agustina Barbero)', () => {
  it('socio con Aparatos: el campo se llama "Fecha de vencimiento (Aparatos)"', () => {
    const socio = {
      id: 's-aparatos',
      nombre: 'Lucía',
      apellido: 'Paz',
      dni: '30222333',
      email: 'lucia@test.com',
      telefono: '',
      plan: ['Aparatos'],
      fechaVencimiento: '2099-01-01',
    }
    render(<NuevoSocioModal socio={socio} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByLabelText('Fecha de vencimiento (Aparatos)')).toBeTruthy()
  })

  it('socio 100% de créditos (sin Aparatos): el campo se llama "Renovar vencimiento de créditos (...)", no el genérico de antes', () => {
    const socio = {
      id: 's-solo-creditos',
      nombre: 'Bruno',
      apellido: 'Álvarez',
      dni: '30999888',
      email: 'bruno@test.com',
      telefono: '',
      plan: ['Boxeo'],
      fechaVencimiento: '2020-01-01', // residual -- no le corresponde a Aparatos, que no tiene
    }
    render(<NuevoSocioModal socio={socio} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByLabelText('Renovar vencimiento de créditos (Boxeo)')).toBeTruthy()
    expect(screen.queryByText('Fecha de vencimiento')).toBeNull()
  })

  it('socio con Aparatos + una disciplina de créditos: la etiqueta sigue asociada a Aparatos (una sola fecha, una sola membresía real)', () => {
    const socio = {
      id: 's-combinado',
      nombre: 'Facundo',
      apellido: 'Uria',
      dni: '20333444',
      email: 'facu@test.com',
      telefono: '',
      plan: ['Aparatos', 'CrossFit'],
      fechaVencimiento: '2099-01-01',
    }
    render(<NuevoSocioModal socio={socio} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByLabelText('Fecha de vencimiento (Aparatos)')).toBeTruthy()
  })
})
