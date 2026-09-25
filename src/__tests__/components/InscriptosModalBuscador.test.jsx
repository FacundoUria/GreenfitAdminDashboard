import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import InscriptosModal from '../../components/InscriptosModal'

// Buscador de "Ver inscriptos": filtra en memoria por DNI / nombre / apellido,
// muestra los créditos de cada socio y anota con el camino correcto (DNI
// exacto -> onAgregarSocio; socio elegido -> onAgregarSocioPorId con el id).
const CLASE = {
  id: 'clase-1',
  disciplina: 'CrossFit',
  diasSemana: [1],
  horaInicio: '18:00',
  horaFin: '19:00',
  profesor: 'Seba',
  inscriptos: [{ id: 'b1', userId: 'u3', nombre: 'José Ángel Núñez', dni: '44537978', asistio: null }],
}

const SOCIOS = [
  { id: 'u1', full_name: 'Martina Ríos', dni: '30111222' },
  { id: 'u2', full_name: 'Mariano Ibáñez', dni: '28999888' },
  { id: 'u3', full_name: 'José Ángel Núñez', dni: '44537978' },
  { id: 'u4', full_name: 'Lucía Martínez', dni: '31222333' },
]

const CREDITOS = new Map([
  ['u1', 4],
  ['u2', 1],
  ['u3', 7],
])

function renderModal(extra = {}) {
  const props = {
    open: true,
    clase: CLASE,
    onClose: vi.fn(),
    onMarcarAsistencia: vi.fn(),
    onAgregarSocio: vi.fn().mockResolvedValue(undefined),
    onAgregarSocioPorId: vi.fn().mockResolvedValue(undefined),
    onQuitarInscripto: vi.fn(),
    onAbrirFicha: vi.fn(),
    socios: SOCIOS,
    creditosPorSocio: CREDITOS,
    ...extra,
  }
  render(<InscriptosModal {...props} />)
  return props
}

const buscador = () => screen.getByPlaceholderText('Buscar socio por DNI, nombre o apellido...')
const escribir = (texto) => fireEvent.change(buscador(), { target: { value: texto } })

describe('InscriptosModal -- buscador de socios', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sin texto no muestra resultados', () => {
    renderModal()
    expect(screen.queryByTestId('resultados-busqueda')).not.toBeInTheDocument()
  })

  it('filtra por nombre ignorando tildes y mayúsculas, sin ir a la red', () => {
    renderModal()
    escribir('RIOS')
    expect(screen.getByTestId('resultado-socio-u1')).toBeInTheDocument()
    expect(screen.queryByTestId('resultado-socio-u2')).not.toBeInTheDocument()
  })

  it('filtra por DNI parcial y con puntos', () => {
    renderModal()
    escribir('30.111')
    expect(screen.getByTestId('resultado-socio-u1')).toBeInTheDocument()
    expect(screen.queryByTestId('resultado-socio-u4')).not.toBeInTheDocument()
  })

  it('muestra los créditos de cada socio: N créditos / 1 crédito', () => {
    renderModal()
    escribir('mar') // Martina (4), Mariano (1); Lucía Martínez no tiene y no aparece
    expect(screen.getByTestId('resultado-socio-u1')).toHaveTextContent('4 créditos')
    expect(screen.getByTestId('resultado-socio-u2')).toHaveTextContent('1 crédito')
    expect(screen.getByTestId('resultado-socio-u2')).not.toHaveTextContent('1 créditos')
  })

  it('los socios SIN créditos vigentes (0 o sin filas) no aparecen en los resultados, aunque coincidan con la búsqueda', () => {
    renderModal({ creditosPorSocio: new Map([['u1', 4], ['u2', 0]]) }) // u2 en 0, u4 sin entrada
    escribir('mar') // coinciden Martina, Mariano y Lucía Martínez
    expect(screen.getByTestId('resultado-socio-u1')).toBeInTheDocument()
    expect(screen.queryByTestId('resultado-socio-u2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resultado-socio-u4')).not.toBeInTheDocument()
    expect(screen.queryByText('Sin créditos')).not.toBeInTheDocument()
  })

  it('si coinciden pero ninguno tiene créditos, lo dice (y recuerda que el DNI completo igual se intenta)', () => {
    renderModal()
    escribir('lucia')
    expect(screen.queryByTestId('resultado-socio-u4')).not.toBeInTheDocument()
    expect(screen.getByText(/no tienen créditos vigentes en esta disciplina/)).toBeInTheDocument()
    expect(screen.queryByText('Ningún socio coincide con esa búsqueda.')).not.toBeInTheDocument()
  })

  it('un DNI completo de alguien SIN créditos no aparece en la lista, pero Enter igual lo intenta (el RPC decide)', async () => {
    const props = renderModal()
    escribir('31222333') // Lucía Martínez, sin créditos
    expect(screen.queryByTestId('resultado-socio-u4')).not.toBeInTheDocument()
    fireEvent.submit(buscador().closest('form'))
    await waitFor(() => expect(props.onAgregarSocio).toHaveBeenCalledWith(CLASE, '31222333'))
  })

  it('si los créditos no se pudieron cargar, no se filtra nada (no se sabe quién tiene) ni se muestran badges', () => {
    renderModal({ creditosPorSocio: null })
    escribir('mar')
    expect(screen.getByTestId('resultado-socio-u1')).not.toHaveTextContent(/crédito/i)
    expect(screen.getByTestId('resultado-socio-u4')).toBeInTheDocument() // Lucía sigue apareciendo
  })

  it('tocar un resultado anota con ESE id (onAgregarSocioPorId), sin pasar por el DNI', async () => {
    const props = renderModal()
    escribir('martina')
    fireEvent.click(screen.getByTestId('resultado-socio-u1'))

    await waitFor(() => expect(props.onAgregarSocioPorId).toHaveBeenCalledWith(CLASE, SOCIOS[0]))
    expect(props.onAgregarSocio).not.toHaveBeenCalled()
    await waitFor(() => expect(buscador()).toHaveValue('')) // se limpia como antes
  })

  it('un DNI exacto + Enter usa el camino de siempre: onAgregarSocio con el DNI (sin puntos)', async () => {
    const props = renderModal()
    escribir('30.111.222')
    fireEvent.submit(buscador().closest('form'))

    await waitFor(() => expect(props.onAgregarSocio).toHaveBeenCalledWith(CLASE, '30111222'))
    expect(props.onAgregarSocioPorId).not.toHaveBeenCalled()
  })

  it('un DNI que no está en la lista igual se intenta por DNI (la base decide)', async () => {
    const props = renderModal()
    escribir('12345678')
    expect(screen.queryByTestId(/^resultado-socio-/)).not.toBeInTheDocument()
    fireEvent.submit(buscador().closest('form'))

    await waitFor(() => expect(props.onAgregarSocio).toHaveBeenCalledWith(CLASE, '12345678'))
  })

  it('un nombre con VARIOS resultados: Enter no anota a nadie (hay que tocar uno)', () => {
    const props = renderModal()
    escribir('mar')
    expect(screen.getByRole('button', { name: /Anotar/ })).toBeDisabled()
    fireEvent.submit(buscador().closest('form'))
    expect(props.onAgregarSocio).not.toHaveBeenCalled()
    expect(props.onAgregarSocioPorId).not.toHaveBeenCalled()
  })

  it('un nombre con UN solo resultado: Enter lo anota por id', async () => {
    const props = renderModal()
    escribir('ibanez')
    fireEvent.submit(buscador().closest('form'))

    await waitFor(() => expect(props.onAgregarSocioPorId).toHaveBeenCalledWith(CLASE, SOCIOS[1]))
    expect(props.onAgregarSocio).not.toHaveBeenCalled()
  })

  it('un socio que ya está en la clase aparece como "Ya anotado" y no se puede tocar', () => {
    const props = renderModal()
    escribir('nunez')
    const fila = screen.getByTestId('resultado-socio-u3')
    expect(fila).toHaveTextContent('Ya anotado')
    expect(fila).toBeDisabled()
    fireEvent.click(fila)
    expect(props.onAgregarSocioPorId).not.toHaveBeenCalled()
  })

  it('sin coincidencias avisa, sin romper', () => {
    renderModal()
    escribir('zzzz')
    expect(screen.getByText('Ningún socio coincide con esa búsqueda.')).toBeInTheDocument()
  })

  it('mientras carga la lista muestra "Cargando socios..."; si falla, avisa y deja anotar por DNI', () => {
    const { unmount } = render(
      <InscriptosModal open clase={CLASE} onClose={vi.fn()} onMarcarAsistencia={vi.fn()} onAgregarSocio={vi.fn()} onQuitarInscripto={vi.fn()} onAbrirFicha={vi.fn()} socios={null} cargandoSocios />,
    )
    fireEvent.change(screen.getByPlaceholderText('Buscar socio por DNI, nombre o apellido...'), { target: { value: 'mar' } })
    expect(screen.getByText('Cargando socios...')).toBeInTheDocument()
    unmount()

    const props = renderModal({ socios: null, errorSocios: true, creditosPorSocio: null })
    escribir('30111222')
    expect(screen.getByText(/No se pudo cargar la lista de socios/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Anotar/ })).toBeEnabled()
    expect(props.onAgregarSocio).not.toHaveBeenCalled()
  })

  it('sin las props nuevas (uso viejo) sigue anotando por DNI exacto', async () => {
    const onAgregarSocio = vi.fn().mockResolvedValue(undefined)
    render(
      <InscriptosModal open clase={CLASE} onClose={vi.fn()} onMarcarAsistencia={vi.fn()} onAgregarSocio={onAgregarSocio} onQuitarInscripto={vi.fn()} onAbrirFicha={vi.fn()} />,
    )
    fireEvent.change(screen.getByPlaceholderText('Buscar socio por DNI, nombre o apellido...'), { target: { value: '30111222' } })
    fireEvent.submit(screen.getByPlaceholderText('Buscar socio por DNI, nombre o apellido...').closest('form'))
    await waitFor(() => expect(onAgregarSocio).toHaveBeenCalledWith(CLASE, '30111222'))
  })
})
