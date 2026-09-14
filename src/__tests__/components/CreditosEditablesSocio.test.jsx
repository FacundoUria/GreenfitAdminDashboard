import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../../utils/fichaSocioPwa', () => ({
  resolverUserIdPorDni: vi.fn(),
  fetchCreditosPorDisciplina: vi.fn(),
}))

vi.mock('../../utils/creditosPwa', () => ({
  fijarCreditosDisciplina: vi.fn(),
  ajustarCreditoDisciplina: vi.fn(),
  agregarAparatosSocio: vi.fn(),
  editarFechaVencimientoSocio: vi.fn(),
}))

import { resolverUserIdPorDni, fetchCreditosPorDisciplina } from '../../utils/fichaSocioPwa'
import {
  fijarCreditosDisciplina,
  ajustarCreditoDisciplina,
  agregarAparatosSocio,
  editarFechaVencimientoSocio,
} from '../../utils/creditosPwa'
import CreditosEditablesSocio from '../../components/CreditosEditablesSocio'

// DNI real del ticket (Facundo Uria) -- caso que expuso el bug del modelo de
// "plan único": socios.plan puede estar desactualizado o incompleto (es un
// campo administrativo manual), pero las filas de este componente ya NO
// dependen de él. Salen directo de fetchCreditosPorDisciplina(), que a su
// vez ya filtra a "al menos un lote activo" (ver fichaSocioPwa.js) --
// acá se mockea directo esa función, simulando su contrato ya filtrado.
const DNI_FACUNDO = '44537978'

function mockearCarga({ userId = 'user-1', entradas = [] } = {}) {
  resolverUserIdPorDni.mockResolvedValue(userId)
  const mapa = new Map()
  mapa.set(DNI_FACUNDO, entradas)
  fetchCreditosPorDisciplina.mockResolvedValue(mapa)
}

describe('CreditosEditablesSocio (reemplaza a los steppers sueltos de SociosTabla.jsx -- ver ticket "Editar Socio")', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'confirm')
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })

  // CAMBIO 5 -- ANTES (sin "+ Agregar Aparatos" todavía) esto no renderizaba
  // nada: sin lotes activos y sin `disciplinasActivas`, no había nada que
  // agregar. Ahora Aparatos SIEMPRE es addable si no está vigente (no
  // depende de `disciplinasActivas`, que es solo el catálogo de créditos) --
  // la sección se muestra igual, con el botón "+ Agregar Aparatos".
  it('sin ninguna disciplina con lotes activos y sin Aparatos vigente -- igual muestra "+ Agregar Aparatos"', async () => {
    mockearCarga({ entradas: [] })

    render(<CreditosEditablesSocio socio={{ id: 's2', dni: DNI_FACUNDO, plan: ['Aparatos'] }} />)

    await waitFor(() => expect(fetchCreditosPorDisciplina).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: /Agregar Aparatos/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Agregar disciplina/ })).toBeNull()
  })

  // Caso genuinamente vacío: sin lotes, sin disciplinas de créditos para
  // agregar Y con Aparatos YA vigente -- ahí sí no queda nada que mostrar.
  it('sin nada activo, sin disciplinas para agregar Y con Aparatos ya vigente -- no renderiza nada', async () => {
    mockearCarga({ entradas: [] })

    const { container } = render(
      <CreditosEditablesSocio socio={{ id: 's2', dni: DNI_FACUNDO, plan: ['Aparatos'], aparatosVigenteReal: true }} />,
    )

    await waitFor(() => expect(fetchCreditosPorDisciplina).toHaveBeenCalled())
    await waitFor(() => expect(container.innerHTML).toBe(''))
  })

  it('disciplina con créditos reales y vigentes, aunque NO esté tildada en socios.plan -- aparece igual (caso Kickstrike de Facundo)', async () => {
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-kickstrike',
          disciplineName: 'Kickstrike',
          remainingCredits: 12,
          lotes: [{ id: 'l1', remainingCredits: 12, expiresAt: '2026-09-23T12:00:00.000Z' }],
        },
      ],
    })

    // socio.plan NO incluye Kickstrike -- no debería importar en absoluto.
    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit', 'Boxeo'] }} />)

    await waitFor(() => expect(screen.getByText('Kickstrike')).toBeTruthy())
    expect(screen.getByLabelText('Créditos de Kickstrike').value).toBe('12')
  })

  it('disciplina tildada en socios.plan pero SIN ningún lote activo -- no aparece (caso Boxeo de Facundo)', async () => {
    // fetchCreditosPorDisciplina ya filtra a "al menos un lote activo" (ver
    // fichaSocioPwa.js) -- acá se simula exactamente ese contrato: Boxeo
    // está tildado en el plan pero no viene en las entradas.
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 12,
          lotes: [{ id: 'l1', remainingCredits: 12, expiresAt: '2026-09-23T12:00:00.000Z' }],
        },
      ],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit', 'Boxeo'] }} />)

    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    expect(screen.queryByText('Boxeo')).toBeNull()
  })

  it('socio con 1 sola disciplina real -- sin cambios respecto de siempre', async () => {
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 6,
          lotes: [{ id: 'l1', remainingCredits: 6, expiresAt: '2026-09-23T12:00:00.000Z' }],
        },
      ],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    expect(screen.getByText('Vence el 23/09/2026')).toBeTruthy()
    expect(screen.getByLabelText('Créditos de CrossFit').value).toBe('6')
  })

  it('caso completo Facundo Uria -- CrossFit y Kickstrike (12 cada uno) aparecen, Boxeo no', async () => {
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 12,
          lotes: [{ id: 'l1', remainingCredits: 12, expiresAt: '2026-09-23T12:00:00.000Z' }],
        },
        {
          disciplineId: 'd-kickstrike',
          disciplineName: 'Kickstrike',
          remainingCredits: 12,
          lotes: [{ id: 'l2', remainingCredits: 12, expiresAt: '2026-09-23T12:00:00.000Z' }],
        },
      ],
    })

    // socio.plan sigue teniendo "Boxeo" tildado (residuo administrativo) --
    // no debería importar, la sección ya no lo lee.
    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit', 'Boxeo'] }} />)

    await waitFor(() => expect(screen.getByText('CrossFit')).toBeTruthy())
    expect(screen.getByText('Kickstrike')).toBeTruthy()
    expect(screen.queryByText('Boxeo')).toBeNull()
    expect(screen.getByLabelText('Créditos de CrossFit').value).toBe('12')
    expect(screen.getByLabelText('Créditos de Kickstrike').value).toBe('12')
  })

  it('escribir un número distinto y Guardar -- pide confirmación con el texto exacto y, si se confirma, fija el total', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })
    window.confirm.mockReturnValue(true)
    const onCreditosActualizados = vi.fn()

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }}
        onCreditosActualizados={onCreditosActualizados}
      />
    )

    const input = await screen.findByLabelText('Créditos de CrossFit')
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.click(screen.getByText('Guardar'))

    expect(window.confirm).toHaveBeenCalledWith('¿Confirmás modificar los créditos de CrossFit a 20?')
    await waitFor(() => expect(fijarCreditosDisciplina).toHaveBeenCalledWith('user-1', 'd-crossfit', 20))
    await waitFor(() => expect(onCreditosActualizados).toHaveBeenCalled())
  })

  it('si se cancela la confirmación, NO fija nada', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })
    window.confirm.mockReturnValue(false)

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    const input = await screen.findByLabelText('Créditos de CrossFit')
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.click(screen.getByText('Guardar'))

    expect(window.confirm).toHaveBeenCalled()
    expect(fijarCreditosDisciplina).not.toHaveBeenCalled()
  })

  it('+1 -- ajusta de inmediato, SIN pedir confirmación', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })
    const onCreditosActualizados = vi.fn()

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }}
        onCreditosActualizados={onCreditosActualizados}
      />
    )

    fireEvent.click(await screen.findByTitle('Sumar 1 crédito a CrossFit'))

    expect(window.confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(ajustarCreditoDisciplina).toHaveBeenCalledWith('user-1', 'd-crossfit', 1))
    await waitFor(() => expect(onCreditosActualizados).toHaveBeenCalled())
  })

  it('-1 -- ajusta de inmediato, SIN pedir confirmación', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    fireEvent.click(await screen.findByTitle('Restar 1 crédito de CrossFit'))

    expect(window.confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(ajustarCreditoDisciplina).toHaveBeenCalledWith('user-1', 'd-crossfit', -1))
  })

  it('entrada con disciplineId nulo (anomalía de datos) -- avisa y no llama a ningún RPC', async () => {
    // Ya no hay ningún paso de "resolver el id por nombre" -- el disciplineId
    // de cada entrada viene directo de fetchCreditosPorDisciplina() (join
    // real contra user_credits), así que en la práctica siempre está
    // presente. El guard en handleGuardar/handleAjustar queda como defensa
    // ante una anomalía de datos, y este test lo sigue cubriendo.
    mockearCarga({
      entradas: [{ disciplineId: null, disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    fireEvent.click(await screen.findByTitle('Sumar 1 crédito a CrossFit'))

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('No se encontró "CrossFit"'))
    expect(ajustarCreditoDisciplina).not.toHaveBeenCalled()
  })

  it('socio sin cuenta PWA todavía (userId null) -- avisa y no llama a ningún RPC', async () => {
    mockearCarga({
      userId: null,
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    fireEvent.click(await screen.findByTitle('Sumar 1 crédito a CrossFit'))

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('todavía no tiene cuenta en la app'))
    expect(ajustarCreditoDisciplina).not.toHaveBeenCalled()
  })
})

// CAMBIO 2 -- "+ Agregar disciplina": antes esta sección solo podía AJUSTAR
// lo que ya existía (fetchCreditosPorDisciplina, filtrado a "al menos un
// lote activo") -- para darle a un socio créditos de una disciplina SIN
// ningún lote activo todavía había que pasar sí o sí por "Registrar Pago".
// El componente delega 100% en admin_fijar_creditos_disciplina (mismo RPC
// de siempre, ningún cambio) para resolver la fecha correcta -- estos
// tests confirman que el componente NUNCA pasa ni calcula ninguna fecha
// (fijarCreditosDisciplina se llama con exactamente 3 argumentos: userId,
// disciplineId, cantidad), que es justamente lo que garantiza que la
// disciplina nueva termine con la MISMA fecha que el resto (esa garantía
// en sí es responsabilidad del RPC, ya probada en supabase_migration_fix_
// editor_creditos_plan_unico.sql -- acá solo se cubre que el frontend no
// interfiera con eso).
describe('CreditosEditablesSocio -- "+ Agregar disciplina" (CAMBIO 2)', () => {
  const DISCIPLINAS_ACTIVAS = [
    { id: 'd-crossfit', name: 'CrossFit', kind: 'credits' },
    { id: 'd-boxeo', name: 'Boxeo', kind: 'credits' },
    { id: 'd-kickstrike', name: 'Kickstrike', kind: 'credits' },
    { id: 'd-aparatos', name: 'Aparatos', kind: 'membership' },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'confirm')
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })

  it('el selector NO muestra disciplinas que ya están activas (evita duplicar "Fijar en")', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }}
        disciplinasActivas={DISCIPLINAS_ACTIVAS}
      />,
    )

    await screen.findByText('CrossFit')
    fireEvent.click(screen.getByRole('button', { name: /Agregar disciplina/ }))

    const opciones = screen.getByLabelText('Disciplina a agregar').querySelectorAll('option')
    const nombres = Array.from(opciones).map((o) => o.textContent)
    expect(nombres).toContain('Boxeo')
    expect(nombres).toContain('Kickstrike')
    // CrossFit ya está activo (con su fila de "Fijar en" de arriba) -- Aparatos
    // no es de créditos -- ninguno de los dos tiene que aparecer acá.
    expect(nombres).not.toContain('CrossFit')
    expect(nombres).not.toContain('Aparatos')
  })

  it('sin disciplinas disponibles (todas activas ya) -- no muestra el botón "Agregar disciplina"', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }}
        disciplinasActivas={[{ id: 'd-crossfit', name: 'CrossFit', kind: 'credits' }]}
      />,
    )

    await screen.findByText('CrossFit')
    expect(screen.queryByRole('button', { name: /Agregar disciplina/ })).toBeNull()
  })

  it('elegir Boxeo y poner una cantidad -- llama a fijarCreditosDisciplina SIN pasar ninguna fecha (la resuelve el RPC solo)', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })
    const onCreditosActualizados = vi.fn()

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }}
        disciplinasActivas={DISCIPLINAS_ACTIVAS}
        onCreditosActualizados={onCreditosActualizados}
      />,
    )

    await screen.findByText('CrossFit')
    fireEvent.click(screen.getByRole('button', { name: /Agregar disciplina/ }))
    fireEvent.change(screen.getByLabelText('Disciplina a agregar'), { target: { value: 'd-boxeo' } })
    fireEvent.change(screen.getByLabelText('Créditos a agregar'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }))

    // Exactamente 3 argumentos -- ninguna fecha viaja desde acá.
    await waitFor(() => expect(fijarCreditosDisciplina).toHaveBeenCalledWith('user-1', 'd-boxeo', 8))
    expect(fijarCreditosDisciplina.mock.calls[0]).toHaveLength(3)
    await waitFor(() => expect(onCreditosActualizados).toHaveBeenCalled())
  })

  it('socio SIN ninguna disciplina activa -- la sección igual se muestra, con "+ Agregar disciplina" disponible', async () => {
    mockearCarga({ entradas: [] })

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, plan: [] }}
        disciplinasActivas={DISCIPLINAS_ACTIVAS}
      />,
    )

    await waitFor(() => expect(screen.getByRole('button', { name: /Agregar disciplina/ })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Agregar disciplina/ }))
    fireEvent.change(screen.getByLabelText('Disciplina a agregar'), { target: { value: 'd-crossfit' } })
    fireEvent.change(screen.getByLabelText('Créditos a agregar'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }))

    // Mismo criterio -- ninguna fecha desde el frontend: sin nada activo,
    // admin_fijar_creditos_disciplina resuelve sola now()+30 días.
    await waitFor(() => expect(fijarCreditosDisciplina).toHaveBeenCalledWith('user-1', 'd-crossfit', 12))
  })

  it('cantidad inválida (0, vacío o no numérica) -- avisa y no llama a ningún RPC', async () => {
    mockearCarga({ entradas: [] })

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, plan: [] }}
        disciplinasActivas={DISCIPLINAS_ACTIVAS}
      />,
    )

    await waitFor(() => expect(screen.getByRole('button', { name: /Agregar disciplina/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Agregar disciplina/ }))
    fireEvent.change(screen.getByLabelText('Disciplina a agregar'), { target: { value: 'd-crossfit' } })
    fireEvent.change(screen.getByLabelText('Créditos a agregar'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }))

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Ingresá un número entero mayor a 0'))
    expect(fijarCreditosDisciplina).not.toHaveBeenCalled()
  })

  it('Cancelar cierra el mini-form sin llamar a ningún RPC', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }}
        disciplinasActivas={DISCIPLINAS_ACTIVAS}
      />,
    )

    await screen.findByText('CrossFit')
    fireEvent.click(screen.getByRole('button', { name: /Agregar disciplina/ }))
    fireEvent.change(screen.getByLabelText('Disciplina a agregar'), { target: { value: 'd-boxeo' } })
    fireEvent.click(screen.getByText('Cancelar'))

    expect(screen.queryByLabelText('Disciplina a agregar')).toBeNull()
    expect(screen.getByRole('button', { name: /Agregar disciplina/ })).toBeTruthy()
    expect(fijarCreditosDisciplina).not.toHaveBeenCalled()
  })
})

// CAMBIO 5 -- "+ Agregar Aparatos": camino corto para volver a darle
// Aparatos a un socio al que se le sacó (admin_quitar_disciplina_socio),
// sin pasar por "Registrar Pago" completo. Sin cantidad -- solo confirmar.
describe('CreditosEditablesSocio -- "+ Agregar Aparatos" (CAMBIO 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'confirm')
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })

  it('Aparatos NO vigente (sin fila real) -- muestra el botón "+ Agregar Aparatos"', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    await screen.findByText('CrossFit')
    expect(screen.getByRole('button', { name: /Agregar Aparatos/ })).toBeTruthy()
  })

  it('Aparatos YA vigente (fila real en user_credits) -- NO muestra el botón', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })

    render(
      <CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'], aparatosVigenteReal: true }} />,
    )

    await screen.findByText('CrossFit')
    expect(screen.queryByRole('button', { name: /Agregar Aparatos/ })).toBeNull()
  })

  // BUG REAL (caso Arianna Isgro, DNI 51705419) -- ANTES una
  // fechaVencimiento futura SOLA (sin ninguna fila real de user_credits)
  // ya bastaba para ocultar este botón, justo cuando era LO ÚNICO que
  // podía corregirla. Ahora depende de `aparatosVigenteReal` -- una fecha
  // residual sin nada real detrás no oculta el botón.
  it('fechaVencimiento futura residual, SIN fila real de Aparatos -- el botón sigue disponible (caso Arianna)', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'], fechaVencimiento: '2099-01-01', aparatosVigenteReal: false }}
      />,
    )

    await screen.findByText('CrossFit')
    expect(screen.getByRole('button', { name: /Agregar Aparatos/ })).toBeTruthy()
  })

  it('confirmar -- llama a agregarAparatosSocio(userId), sin cantidad ni fecha, y refresca al padre', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })
    window.confirm.mockReturnValue(true)
    const onCreditosActualizados = vi.fn()

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, nombre: 'Facundo', apellido: 'Uria', plan: ['CrossFit'] }}
        onCreditosActualizados={onCreditosActualizados}
      />,
    )

    await screen.findByText('CrossFit')
    fireEvent.click(screen.getByRole('button', { name: /Agregar Aparatos/ }))

    expect(window.confirm).toHaveBeenCalledWith('¿Confirmás agregarle Aparatos a Facundo Uria?')
    await waitFor(() => expect(agregarAparatosSocio).toHaveBeenCalledWith('user-1'))
    expect(agregarAparatosSocio.mock.calls[0]).toHaveLength(1) // solo userId -- sin discipline_id ni cantidad
    await waitFor(() => expect(onCreditosActualizados).toHaveBeenCalled())
    // El botón desaparece de inmediato en esta misma sesión del modal, sin
    // esperar a que el padre vuelva a pasar `socio.aparatosVigenteReal` actualizado.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Agregar Aparatos/ })).toBeNull())
  })

  it('si se cancela la confirmación, NO llama a ningún RPC', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })
    window.confirm.mockReturnValue(false)

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    await screen.findByText('CrossFit')
    fireEvent.click(screen.getByRole('button', { name: /Agregar Aparatos/ }))

    expect(window.confirm).toHaveBeenCalled()
    expect(agregarAparatosSocio).not.toHaveBeenCalled()
  })

  // Mismo criterio de "ausencia de UI en vez de alert en runtime" que ya
  // rige el resto de esta sección (ver creditos-sin-dni.spec.js) -- sin
  // userId resuelto, el botón directamente no se muestra (destinado a
  // fallar siempre), en vez de mostrarse y alertar recién al clickearlo.
  it('socio sin cuenta PWA todavía (userId null) -- no muestra el botón "+ Agregar Aparatos"', async () => {
    mockearCarga({
      userId: null,
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    await screen.findByText('CrossFit')
    expect(screen.queryByRole('button', { name: /Agregar Aparatos/ })).toBeNull()
    expect(agregarAparatosSocio).not.toHaveBeenCalled()
  })

  it('si el RPC rechaza (ej. "ya vigente" por una carrera con otro cambio), avisa el mensaje real y el botón sigue disponible', async () => {
    mockearCarga({
      entradas: [{ disciplineId: 'd-crossfit', disciplineName: 'CrossFit', remainingCredits: 6, lotes: [] }],
    })
    window.confirm.mockReturnValue(true)
    agregarAparatosSocio.mockRejectedValue(new Error('El socio ya tiene Aparatos vigente -- no hay nada que agregar.'))

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    await screen.findByText('CrossFit')
    fireEvent.click(screen.getByRole('button', { name: /Agregar Aparatos/ }))

    await waitFor(() =>
      expect(window.alert).toHaveBeenCalledWith('El socio ya tiene Aparatos vigente -- no hay nada que agregar.'),
    )
    expect(screen.getByRole('button', { name: /Agregar Aparatos/ })).toBeTruthy()
  })
})

// CAMBIO 3 -- "Vencimiento del plan": editar la fecha única del plan
// (créditos + Aparatos) sin tocar cantidades. ADITIVO -- admin_editar_
// fecha_vencimiento_socio() es un RPC nuevo y separado, no reemplaza a
// "Cobrar" (fijarCreditosDisciplina/agregarAparatosSocio siguen intactos,
// ver los describe de arriba, sin un solo cambio).
describe('CreditosEditablesSocio -- "Vencimiento del plan" (CAMBIO 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'confirm')
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })

  it('socio con créditos vigentes -- muestra "Vencimiento del plan" con la fecha real', async () => {
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 6,
          lotes: [{ id: 'l1', remainingCredits: 6, expiresAt: '2026-10-05T12:00:00.000Z' }],
        },
      ],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    await screen.findByText('CrossFit')
    expect(screen.getByText('Vencimiento del plan:')).toBeTruthy()
    expect(screen.getByText('05/10/2026')).toBeTruthy()
  })

  it('socio SOLO con Aparatos vigente (sin créditos) -- igual muestra "Vencimiento del plan"', async () => {
    mockearCarga({ entradas: [] })

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['Aparatos'], aparatosVigenteReal: true, fechaVencimiento: '2026-11-20' }}
      />,
    )

    await waitFor(() => expect(fetchCreditosPorDisciplina).toHaveBeenCalled())
    expect(await screen.findByText('Vencimiento del plan:')).toBeTruthy()
    expect(screen.getByText('20/11/2026')).toBeTruthy()
  })

  it('socio SIN nada activo -- no muestra "Vencimiento del plan" en absoluto (mismo criterio que "+ Agregar disciplina")', async () => {
    mockearCarga({ entradas: [] })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: [] }} />)

    await waitFor(() => expect(fetchCreditosPorDisciplina).toHaveBeenCalled())
    expect(screen.queryByText('Vencimiento del plan:')).toBeNull()
  })

  it('tocar el lápiz, elegir una fecha y confirmar -- llama a editarFechaVencimientoSocio con el texto de confirmación exacto', async () => {
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 6,
          lotes: [{ id: 'l1', remainingCredits: 6, expiresAt: '2026-10-05T12:00:00.000Z' }],
        },
      ],
    })
    window.confirm.mockReturnValue(true)
    const onCreditosActualizados = vi.fn()

    render(
      <CreditosEditablesSocio
        socio={{ id: 's1', dni: DNI_FACUNDO, nombre: 'Facundo', apellido: 'Uria', plan: ['CrossFit'] }}
        onCreditosActualizados={onCreditosActualizados}
      />,
    )

    await screen.findByText('CrossFit')
    fireEvent.click(screen.getByRole('button', { name: 'Editar vencimiento del plan' }))

    const input = screen.getByLabelText('Nueva fecha de vencimiento del plan')
    expect(input.value).toBe('2026-10-05') // precargado con la fecha actual
    fireEvent.change(input, { target: { value: '2027-01-15' } })
    fireEvent.click(screen.getByText('Guardar fecha'))

    expect(window.confirm).toHaveBeenCalledWith(
      '¿Confirmás cambiar el vencimiento de TODO el plan de Facundo Uria a 15/01/2027? Esto afecta a todas sus disciplinas activas por igual.',
    )
    await waitFor(() => expect(editarFechaVencimientoSocio).toHaveBeenCalledWith('user-1', '2027-01-15'))
    await waitFor(() => expect(onCreditosActualizados).toHaveBeenCalled())
  })

  it('si se cancela la confirmación, NO llama al RPC', async () => {
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 6,
          lotes: [{ id: 'l1', remainingCredits: 6, expiresAt: '2026-10-05T12:00:00.000Z' }],
        },
      ],
    })
    window.confirm.mockReturnValue(false)

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    await screen.findByText('CrossFit')
    fireEvent.click(screen.getByRole('button', { name: 'Editar vencimiento del plan' }))
    fireEvent.change(screen.getByLabelText('Nueva fecha de vencimiento del plan'), { target: { value: '2027-01-15' } })
    fireEvent.click(screen.getByText('Guardar fecha'))

    expect(window.confirm).toHaveBeenCalled()
    expect(editarFechaVencimientoSocio).not.toHaveBeenCalled()
  })

  it('Cancelar cierra el editor sin llamar al RPC', async () => {
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 6,
          lotes: [{ id: 'l1', remainingCredits: 6, expiresAt: '2026-10-05T12:00:00.000Z' }],
        },
      ],
    })

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    await screen.findByText('CrossFit')
    fireEvent.click(screen.getByRole('button', { name: 'Editar vencimiento del plan' }))
    fireEvent.click(screen.getByText('Cancelar'))

    expect(screen.queryByLabelText('Nueva fecha de vencimiento del plan')).toBeNull()
    expect(screen.getByText('Vencimiento del plan:')).toBeTruthy()
    expect(editarFechaVencimientoSocio).not.toHaveBeenCalled()
  })

  it('si el RPC rechaza (ej. el socio se quedó sin nada activo por otra vía mientras tanto), avisa el mensaje real', async () => {
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 6,
          lotes: [{ id: 'l1', remainingCredits: 6, expiresAt: '2026-10-05T12:00:00.000Z' }],
        },
      ],
    })
    window.confirm.mockReturnValue(true)
    editarFechaVencimientoSocio.mockRejectedValue(
      new Error('Este socio no tiene ningún plan activo -- para asignarle una fecha nueva, hay que usar Cobrar, no editar la fecha.'),
    )

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    await screen.findByText('CrossFit')
    fireEvent.click(screen.getByRole('button', { name: 'Editar vencimiento del plan' }))
    fireEvent.change(screen.getByLabelText('Nueva fecha de vencimiento del plan'), { target: { value: '2027-01-15' } })
    fireEvent.click(screen.getByText('Guardar fecha'))

    await waitFor(() =>
      expect(window.alert).toHaveBeenCalledWith(
        'Este socio no tiene ningún plan activo -- para asignarle una fecha nueva, hay que usar Cobrar, no editar la fecha.',
      ),
    )
  })

  // Confirma que este cambio NUNCA toca fijarCreditosDisciplina/
  // ajustarCreditoDisciplina/agregarAparatosSocio -- editar la fecha es un
  // camino 100% separado.
  it('editar la fecha NUNCA llama a ningún otro RPC de créditos', async () => {
    mockearCarga({
      entradas: [
        {
          disciplineId: 'd-crossfit',
          disciplineName: 'CrossFit',
          remainingCredits: 6,
          lotes: [{ id: 'l1', remainingCredits: 6, expiresAt: '2026-10-05T12:00:00.000Z' }],
        },
      ],
    })
    window.confirm.mockReturnValue(true)

    render(<CreditosEditablesSocio socio={{ id: 's1', dni: DNI_FACUNDO, plan: ['CrossFit'] }} />)

    await screen.findByText('CrossFit')
    fireEvent.click(screen.getByRole('button', { name: 'Editar vencimiento del plan' }))
    fireEvent.change(screen.getByLabelText('Nueva fecha de vencimiento del plan'), { target: { value: '2027-01-15' } })
    fireEvent.click(screen.getByText('Guardar fecha'))

    await waitFor(() => expect(editarFechaVencimientoSocio).toHaveBeenCalled())
    expect(fijarCreditosDisciplina).not.toHaveBeenCalled()
    expect(ajustarCreditoDisciplina).not.toHaveBeenCalled()
    expect(agregarAparatosSocio).not.toHaveBeenCalled()
  })
})
