import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { DIAS_SEMANA } from '../utils/clases'
import { ahoraEnArgentina } from '../utils/ahoraArgentina'
import { diasYFechaParaGuardar, mensajeErrorGuardarClase, textoFechaUnica } from '../utils/claseUnaSolaVez'

// `modo`: 'semanal' (todas las semanas, días de la semana) o 'unica' (una sola
// vez, una fecha). Se guardan los dos valores aunque se cambie el switch, así
// ir y volver no pierde lo que ya se había elegido.
function formInicial(clase, diaPorDefecto, fechaPorDefecto) {
  if (clase) {
    return {
      titulo: clase.disciplina,
      disciplinaId: clase.disciplinaId ?? '',
      profesor: clase.profesor,
      modo: clase.fechaUnica ? 'unica' : 'semanal',
      // En una de una sola vez es {día de su fecha}: si se pasa a semanal, arranca ahí.
      diasSemana: clase.diasSemana,
      fechaUnica: clase.fechaUnica ?? fechaPorDefecto,
      horaInicio: clase.horaInicio,
      horaFin: clase.horaFin,
      cupoMaximo: clase.cupoMaximo,
    }
  }

  return {
    titulo: '',
    disciplinaId: '',
    profesor: '',
    modo: 'semanal',
    diasSemana: [diaPorDefecto],
    fechaUnica: fechaPorDefecto,
    horaInicio: '09:00',
    horaFin: '10:00',
    cupoMaximo: 20,
  }
}

const MODOS = [
  { valor: 'semanal', etiqueta: 'Todas las semanas' },
  { valor: 'unica', etiqueta: 'Una sola vez' },
]

function NuevaClaseModal({ clase, diaPorDefecto, hoy: hoyProp, fechaPorDefecto, onClose, onSaved }) {
  // "Hoy" en hora de Argentina: la fecha de una clase de una sola vez no puede ser anterior.
  const [hoy] = useState(() => hoyProp ?? ahoraEnArgentina().fecha)
  const [form, setForm] = useState(() => formInicial(clase, diaPorDefecto, fechaPorDefecto ?? hoy))
  const [disciplinas, setDisciplinas] = useState([])
  const [cargandoDisciplinas, setCargandoDisciplinas] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  // Las disciplinas salen de la tabla real (la misma que usan los créditos
  // y las reservas), no de una lista de texto suelta -- una clase sin
  // discipline_id válido queda invisible para el chequeo de créditos de la
  // PWA y nadie puede reservarla nunca, sin ningún error visible.
  useEffect(() => {
    let activo = true
    supabase
      .from('disciplines')
      .select('id, name, is_active')
      .eq('is_active', true)
      .order('name')
      .then(async ({ data, error: fetchError }) => {
        if (!activo) return
        if (fetchError) {
          console.error('Error al cargar disciplinas:', fetchError.message)
          setCargandoDisciplinas(false)
          return
        }
        let lista = data ?? []
        // Si se está editando una clase cuya disciplina ya fue desactivada,
        // la agregamos igual a la lista (marcada) para no perder/cambiar sin
        // querer la disciplina real de la clase -- solo se excluyen las
        // inactivas como opción para clases NUEVAS.
        const idActual = clase?.disciplinaId
        if (idActual && !lista.some((d) => d.id === idActual)) {
          const { data: actual } = await supabase.from('disciplines').select('id, name').eq('id', idActual).maybeSingle()
          if (actual) lista = [...lista, { ...actual, is_active: false }]
        }
        if (!activo) return
        setDisciplinas(lista)
        setForm((prev) => (prev.disciplinaId ? prev : { ...prev, disciplinaId: lista?.[0]?.id ?? '' }))
        setCargandoDisciplinas(false)
      })
    return () => {
      activo = false
    }
  }, [])

  const handleChange = (field) => (event) => {
    const value = field === 'cupoMaximo' ? Number(event.target.value) : event.target.value
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const handleToggleDia = (numero) => {
    setForm((prev) => ({
      ...prev,
      diasSemana: prev.diasSemana.includes(numero)
        ? prev.diasSemana.filter((d) => d !== numero)
        : [...prev.diasSemana, numero].sort((a, b) => a - b),
    }))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()

    const diasYFecha = diasYFechaParaGuardar(form, hoy)
    if (diasYFecha.error) {
      setError(diasYFecha.error)
      return
    }
    if (!form.disciplinaId) {
      setError('Elegí una disciplina.')
      return
    }

    setGuardando(true)
    setError(null)

    const payload = {
      title: form.titulo.trim(),
      discipline_id: form.disciplinaId,
      instructor: form.profesor,
      // Una sola vez: days_of_week = {día de esa fecha} + fecha_unica (la base
      // lo exige con un CHECK). Todas las semanas: fecha_unica en null.
      days_of_week: diasYFecha.days_of_week,
      fecha_unica: diasYFecha.fecha_unica,
      start_time: form.horaInicio,
      end_time: form.horaFin,
      capacity: form.cupoMaximo,
    }

    const { data, error: dbError } = clase
      ? await supabase.from('classes').update(payload).eq('id', clase.id).select()
      : await supabase.from('classes').insert(payload).select()

    setGuardando(false)

    // Un UPDATE bloqueado por RLS puede volver sin `error` pero sin filas afectadas.
    if (dbError || !data || data.length === 0) {
      console.error(
        'Error al guardar la clase en Supabase:',
        dbError?.message ?? 'no se guardó ninguna fila (revisá las políticas RLS)',
      )
      // Si la base lo frenó por reservas futuras o por una fecha pasada, el
      // mensaje dice qué fechas y qué hacer -- se muestra tal cual.
      setError(mensajeErrorGuardarClase(dbError))
      return
    }

    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div className="mx-auto my-6 w-full max-w-lg rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">
            {clase ? 'Editar Clase' : 'Nueva Clase'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <label htmlFor="titulo" className="text-xs font-medium text-gray-400">
              Título de la clase
            </label>
            <input
              id="titulo"
              type="text"
              required
              placeholder="Ej: CrossFit - Turno Mañana"
              value={form.titulo}
              onChange={handleChange('titulo')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="disciplina" className="text-xs font-medium text-gray-400">
              Disciplina
            </label>
            <select
              id="disciplina"
              required
              disabled={cargandoDisciplinas}
              value={form.disciplinaId}
              onChange={handleChange('disciplinaId')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary disabled:opacity-60"
            >
              {cargandoDisciplinas && <option value="">Cargando...</option>}
              {!cargandoDisciplinas && disciplinas.length === 0 && <option value="">Sin disciplinas cargadas</option>}
              {disciplinas.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.is_active === false ? ' (inactiva)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="profesor" className="text-xs font-medium text-gray-400">
              Profesor
            </label>
            <input
              id="profesor"
              type="text"
              required
              value={form.profesor}
              onChange={handleChange('profesor')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span id="repeticion" className="text-xs font-medium text-gray-400">
              Repetición
            </span>
            <div role="radiogroup" aria-labelledby="repeticion" className="grid grid-cols-2 gap-1 rounded-lg bg-greenfit-dark p-1">
              {MODOS.map(({ valor, etiqueta }) => (
                <button
                  key={valor}
                  type="button"
                  role="radio"
                  aria-checked={form.modo === valor}
                  onClick={() => setForm((prev) => ({ ...prev, modo: valor }))}
                  className={`min-h-[44px] rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                    form.modo === valor ? 'bg-greenfit-primary text-greenfit-dark' : 'text-gray-300 hover:text-white'
                  }`}
                >
                  {etiqueta}
                </button>
              ))}
            </div>
          </div>

          {form.modo === 'unica' ? (
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <label htmlFor="fechaUnica" className="text-xs font-medium text-gray-400">
              Fecha
            </label>
            <input
              id="fechaUnica"
              type="date"
              required
              min={hoy}
              value={form.fechaUnica}
              onChange={handleChange('fechaUnica')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
            {form.fechaUnica && (
              <p className="text-xs text-gray-400">
                Solo el {textoFechaUnica(form.fechaUnica)}. No se repite.
              </p>
            )}
          </div>
          ) : (
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-gray-400">Días de la semana</span>
            <div className="flex flex-wrap gap-2">
              {DIAS_SEMANA.map(({ numero, nombre }) => (
                <button
                  key={numero}
                  type="button"
                  onClick={() => handleToggleDia(numero)}
                  className={`min-h-[44px] rounded-lg px-3.5 py-2 text-xs font-medium transition-colors ${
                    form.diasSemana.includes(numero)
                      ? 'bg-greenfit-primary text-greenfit-dark'
                      : 'border border-white/10 text-gray-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  {nombre}
                </button>
              ))}
            </div>
          </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="cupoMaximo" className="text-xs font-medium text-gray-400">
              Cupo máximo
            </label>
            <input
              id="cupoMaximo"
              type="number"
              min="1"
              required
              value={form.cupoMaximo}
              onChange={handleChange('cupoMaximo')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="horaInicio" className="text-xs font-medium text-gray-400">
              Hora inicio
            </label>
            <input
              id="horaInicio"
              type="time"
              required
              value={form.horaInicio}
              onChange={handleChange('horaInicio')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="horaFin" className="text-xs font-medium text-gray-400">
              Hora fin
            </label>
            <input
              id="horaFin"
              type="time"
              required
              value={form.horaFin}
              onChange={handleChange('horaFin')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          {error && <p className="text-sm text-red-400 sm:col-span-2">{error}</p>}

          <div className="mt-2 flex flex-col-reverse gap-3 sm:col-span-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="flex min-h-[44px] items-center justify-center rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={guardando}
              className="flex min-h-[44px] items-center justify-center rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {guardando ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default NuevaClaseModal
