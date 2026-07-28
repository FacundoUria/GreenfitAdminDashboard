import { useMemo, useState } from 'react'
import { CalendarDays, Percent, Plus, Users } from 'lucide-react'
import ClasesGrid from '../components/ClasesGrid'
import InscriptosModal from '../components/InscriptosModal'
import NuevaClaseModal from '../components/NuevaClaseModal'

const dias = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']

const sociosPool = [
  ['Lucía', 'Gómez'],
  ['Martín', 'Fernández'],
  ['Sofía', 'Ramírez'],
  ['Nicolás', 'Torres'],
  ['Valentina', 'Suárez'],
  ['Diego', 'Molina'],
  ['Camila', 'Ibáñez'],
  ['Federico', 'Álvarez'],
  ['Agustina', 'Paz'],
  ['Tomás', 'Herrera'],
  ['Milagros', 'Ríos'],
  ['Bruno', 'Acosta'],
]

function generarInscriptos(cantidad, semilla) {
  return Array.from({ length: cantidad }, (_, index) => {
    const [nombre, apellido] = sociosPool[(semilla + index) % sociosPool.length]
    return {
      id: `${semilla}-${index}`,
      nombre,
      apellido,
      asistio: null,
    }
  })
}

let siguienteId = 1000

function crearClase({ disciplina, profesor, dia, horaInicio, horaFin, cupoMaximo, inscriptos }) {
  return {
    id: siguienteId++,
    disciplina,
    profesor,
    dia,
    horaInicio,
    horaFin,
    cupoMaximo,
    inscriptos,
  }
}

const clasesIniciales = [
  crearClase({
    disciplina: 'Crossfit',
    profesor: 'Franco Díaz',
    dia: 'Lunes',
    horaInicio: '08:00',
    horaFin: '09:00',
    cupoMaximo: 20,
    inscriptos: generarInscriptos(18, 0),
  }),
  crearClase({
    disciplina: 'Musculación',
    profesor: 'Ana Belén Castro',
    dia: 'Lunes',
    horaInicio: '10:00',
    horaFin: '11:00',
    cupoMaximo: 15,
    inscriptos: generarInscriptos(8, 2),
  }),
  crearClase({
    disciplina: 'Yoga',
    profesor: 'Martina Ruiz',
    dia: 'Lunes',
    horaInicio: '18:00',
    horaFin: '19:00',
    cupoMaximo: 20,
    inscriptos: generarInscriptos(14, 4),
  }),
  crearClase({
    disciplina: 'Funcional',
    profesor: 'Rodrigo Pereyra',
    dia: 'Martes',
    horaInicio: '07:30',
    horaFin: '08:30',
    cupoMaximo: 18,
    inscriptos: generarInscriptos(17, 1),
  }),
  crearClase({
    disciplina: 'Crossfit',
    profesor: 'Franco Díaz',
    dia: 'Martes',
    horaInicio: '19:00',
    horaFin: '20:00',
    cupoMaximo: 20,
    inscriptos: generarInscriptos(12, 3),
  }),
  crearClase({
    disciplina: 'Yoga',
    profesor: 'Martina Ruiz',
    dia: 'Miércoles',
    horaInicio: '09:00',
    horaFin: '10:00',
    cupoMaximo: 20,
    inscriptos: generarInscriptos(9, 5),
  }),
  crearClase({
    disciplina: 'Musculación',
    profesor: 'Ana Belén Castro',
    dia: 'Miércoles',
    horaInicio: '17:00',
    horaFin: '18:00',
    cupoMaximo: 15,
    inscriptos: generarInscriptos(14, 6),
  }),
  crearClase({
    disciplina: 'Funcional',
    profesor: 'Rodrigo Pereyra',
    dia: 'Jueves',
    horaInicio: '08:00',
    horaFin: '09:00',
    cupoMaximo: 18,
    inscriptos: generarInscriptos(10, 7),
  }),
  crearClase({
    disciplina: 'Crossfit',
    profesor: 'Franco Díaz',
    dia: 'Jueves',
    horaInicio: '19:00',
    horaFin: '20:00',
    cupoMaximo: 20,
    inscriptos: generarInscriptos(20, 8),
  }),
  crearClase({
    disciplina: 'Yoga',
    profesor: 'Martina Ruiz',
    dia: 'Viernes',
    horaInicio: '18:30',
    horaFin: '19:30',
    cupoMaximo: 20,
    inscriptos: generarInscriptos(11, 9),
  }),
  crearClase({
    disciplina: 'Musculación',
    profesor: 'Ana Belén Castro',
    dia: 'Viernes',
    horaInicio: '10:00',
    horaFin: '11:00',
    cupoMaximo: 15,
    inscriptos: generarInscriptos(6, 10),
  }),
  crearClase({
    disciplina: 'Funcional',
    profesor: 'Rodrigo Pereyra',
    dia: 'Sábado',
    horaInicio: '10:00',
    horaFin: '11:00',
    cupoMaximo: 18,
    inscriptos: generarInscriptos(15, 11),
  }),
]

function diaActualPorDefecto() {
  const indiceHoy = new Date().getDay()
  const mapa = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado' }
  return mapa[indiceHoy] ?? 'Lunes'
}

function Clases() {
  const [clases, setClases] = useState(clasesIniciales)
  const [diaSeleccionado, setDiaSeleccionado] = useState(diaActualPorDefecto)
  const [claseInscriptos, setClaseInscriptos] = useState(null)
  const [modalNuevaClaseAbierto, setModalNuevaClaseAbierto] = useState(false)
  const [claseEnEdicion, setClaseEnEdicion] = useState(null)

  const clasesDelDia = useMemo(
    () => clases.filter((clase) => clase.dia === diaSeleccionado),
    [clases, diaSeleccionado],
  )

  const kpis = useMemo(() => {
    const cuposTotales = clasesDelDia.reduce((total, clase) => total + clase.cupoMaximo, 0)
    const inscriptosHoy = clasesDelDia.reduce((total, clase) => total + clase.inscriptos.length, 0)
    const ocupacion = cuposTotales === 0 ? 0 : Math.round((inscriptosHoy / cuposTotales) * 100)

    return [
      { label: 'Clases Hoy', value: clasesDelDia.length, icon: CalendarDays },
      { label: 'Cupos Totales', value: cuposTotales, icon: Users },
      { label: 'Inscriptos Hoy', value: inscriptosHoy, icon: Users },
      { label: 'Ocupación', value: `${ocupacion}%`, icon: Percent },
    ]
  }, [clasesDelDia])

  const handleVerInscriptos = (clase) => setClaseInscriptos(clase)

  const handleMarcarAsistencia = (claseId, inscriptoId, asistio) => {
    setClases((prev) =>
      prev.map((clase) =>
        clase.id !== claseId
          ? clase
          : {
              ...clase,
              inscriptos: clase.inscriptos.map((inscripto) =>
                inscripto.id === inscriptoId ? { ...inscripto, asistio } : inscripto,
              ),
            },
      ),
    )
    setClaseInscriptos((prev) =>
      prev && prev.id === claseId
        ? {
            ...prev,
            inscriptos: prev.inscriptos.map((inscripto) =>
              inscripto.id === inscriptoId ? { ...inscripto, asistio } : inscripto,
            ),
          }
        : prev,
    )
  }

  const handleAbrirNuevaClase = () => {
    setClaseEnEdicion(null)
    setModalNuevaClaseAbierto(true)
  }

  const handleEditar = (clase) => {
    setClaseEnEdicion(clase)
    setModalNuevaClaseAbierto(true)
  }

  const handleCancelarClase = (clase) => {
    const confirmado = window.confirm(
      `¿Seguro que querés cancelar la clase de ${clase.disciplina} de las ${clase.horaInicio}?`,
    )
    if (confirmado) {
      setClases((prev) => prev.filter((c) => c.id !== clase.id))
    }
  }

  const handleGuardarClase = (form) => {
    if (claseEnEdicion) {
      setClases((prev) =>
        prev.map((clase) =>
          clase.id === claseEnEdicion.id ? { ...clase, ...form } : clase,
        ),
      )
    } else {
      setClases((prev) => [
        ...prev,
        crearClase({ ...form, inscriptos: [] }),
      ])
      setDiaSeleccionado(form.dia)
    }
    setModalNuevaClaseAbierto(false)
    setClaseEnEdicion(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map(({ label, value, icon: Icon }) => (
          <div key={label} className="flex items-center gap-4 rounded-xl bg-greenfit-card p-5">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-greenfit-primary/15">
              <Icon className="h-5 w-5 text-greenfit-primary" />
            </div>
            <div>
              <p className="text-sm text-gray-400">{label}</p>
              <p className="text-2xl font-semibold text-white">{value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {dias.map((dia) => (
            <button
              key={dia}
              type="button"
              onClick={() => setDiaSeleccionado(dia)}
              className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                diaSeleccionado === dia
                  ? 'bg-greenfit-primary text-greenfit-dark'
                  : 'bg-greenfit-card text-gray-300 hover:text-white'
              }`}
            >
              {dia}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={handleAbrirNuevaClase}
          className="flex items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Nueva Clase
        </button>
      </div>

      <ClasesGrid
        clases={clasesDelDia}
        onVerInscriptos={handleVerInscriptos}
        onEditar={handleEditar}
        onCancelar={handleCancelarClase}
      />

      <InscriptosModal
        open={Boolean(claseInscriptos)}
        clase={claseInscriptos}
        onClose={() => setClaseInscriptos(null)}
        onMarcarAsistencia={handleMarcarAsistencia}
      />

      {modalNuevaClaseAbierto && (
        <NuevaClaseModal
          key={claseEnEdicion?.id ?? 'nueva'}
          clase={claseEnEdicion}
          diaPorDefecto={diaSeleccionado}
          onClose={() => {
            setModalNuevaClaseAbierto(false)
            setClaseEnEdicion(null)
          }}
          onSave={handleGuardarClase}
        />
      )}
    </div>
  )
}

export default Clases
