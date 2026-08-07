import { useEffect, useRef, useState } from 'react'
import { Clock, Plus, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { DIAS_SEMANA_COMPLETA } from '../utils/horarios'

function formInicial(disciplina) {
  if (disciplina) {
    return {
      name: disciplina.name ?? '',
      description: disciplina.description ?? '',
      kind: disciplina.kind ?? 'credits',
      default_capacity: disciplina.default_capacity != null ? String(disciplina.default_capacity) : '',
      is_active: disciplina.is_active ?? true,
    }
  }
  return { name: '', description: '', kind: 'credits', default_capacity: '', is_active: true }
}

// Una franja horaria = una fila de `classes` (la MISMA tabla que ya usa
// "Elegí tu ritmo" en la landing y la pantalla de Clases) -- `id: null`
// marca una franja nueva todavía no guardada.
function franjaVacia() {
  return { id: null, dias: [], horaInicio: '09:00', horaFin: '10:00' }
}

function DisciplinaModal({ disciplina, onClose, onSaved }) {
  const esEdicion = Boolean(disciplina)
  const [form, setForm] = useState(() => formInicial(disciplina))
  const [franjas, setFranjas] = useState([])
  const [cargandoFranjas, setCargandoFranjas] = useState(esEdicion)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  // Snapshot de los ids de franjas que YA existían en Supabase al abrir el
  // modal -- necesario para saber, al guardar, cuáles se borraron (estaban
  // acá y ya no) sin tener que volver a consultar la base.
  const idsOriginalesRef = useRef(new Set())

  const updateField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }))

  // Las franjas de una disciplina existente salen de `classes` -- ya no
  // importa el `kind`: una disciplina "por vencimiento" (Aparatos) puede
  // tener horario real de gimnasio (ej. 07 a 13 y 16 a 22) igual que una
  // por créditos, simplemente no se usan para reservar cupo.
  useEffect(() => {
    if (!esEdicion) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCargandoFranjas(false)
      return
    }
    let activo = true
    supabase
      .from('classes')
      .select('id, days_of_week, start_time, end_time')
      .eq('discipline_id', disciplina.id)
      .order('start_time')
      .then(({ data, error: fetchError }) => {
        if (!activo) return
        if (fetchError) {
          console.error('No se pudieron cargar los horarios de la disciplina:', fetchError.message)
          setCargandoFranjas(false)
          return
        }
        const filas = (data ?? []).map((c) => ({
          id: c.id,
          dias: [...(c.days_of_week ?? [])].sort((a, b) => a - b),
          horaInicio: (c.start_time ?? '').slice(0, 5),
          horaFin: (c.end_time ?? '').slice(0, 5),
        }))
        idsOriginalesRef.current = new Set(filas.map((f) => f.id))
        setFranjas(filas)
        setCargandoFranjas(false)
      })
    return () => {
      activo = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo debe correr al abrir el modal, no en cada cambio de `disciplina` (es la misma referencia durante toda la vida del modal)
  }, [])

  const agregarFranja = () => setFranjas((prev) => [...prev, franjaVacia()])
  const eliminarFranja = (indice) => setFranjas((prev) => prev.filter((_, i) => i !== indice))
  const actualizarFranja = (indice, cambios) =>
    setFranjas((prev) => prev.map((f, i) => (i === indice ? { ...f, ...cambios } : f)))
  const toggleDiaFranja = (indice, numero) =>
    setFranjas((prev) =>
      prev.map((f, i) =>
        i === indice
          ? { ...f, dias: f.dias.includes(numero) ? f.dias.filter((d) => d !== numero) : [...f.dias, numero].sort((a, b) => a - b) }
          : f,
      ),
    )

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!form.name.trim()) {
      setError('El nombre es obligatorio.')
      return
    }

    // Las franjas horarias ya aplican a cualquier `kind` -- una disciplina
    // "por vencimiento" puede tener horario real de gimnasio, o quedar sin
    // ninguna franja cargada (ahí la landing muestra el fallback de "Pase
    // Libre / Horario de Gimnasio").
    const franjasAGuardar = franjas
    for (const franja of franjasAGuardar) {
      if (franja.dias.length === 0) {
        setError('Cada franja horaria necesita al menos un día seleccionado.')
        return
      }
      if (!franja.horaInicio || !franja.horaFin) {
        setError('Completá la hora de inicio y fin de cada franja horaria.')
        return
      }
    }

    setGuardando(true)
    setError(null)

    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      default_capacity: form.default_capacity ? Number(form.default_capacity) : null,
      is_active: form.is_active,
    }
    // `kind` define si la disciplina se maneja por créditos o por vencimiento
    // en TODO el resto del sistema (packs, user_credits, reservas) -- cambiarlo
    // en una disciplina que ya tiene datos cargados dejaría esos datos
    // inconsistentes, así que solo se define al crear.
    if (!esEdicion) payload.kind = form.kind

    const resultado = esEdicion
      ? await supabase.from('disciplines').update(payload).eq('id', disciplina.id).select()
      : await supabase.from('disciplines').insert(payload).select()

    if (resultado.error || !resultado.data || resultado.data.length === 0) {
      console.error(
        `Error al ${esEdicion ? 'actualizar' : 'crear'} la disciplina en Supabase:`,
        resultado.error?.message ?? 'no se guardó ninguna fila (revisá las políticas RLS)',
      )
      setGuardando(false)
      setError(`No se pudo ${esEdicion ? 'actualizar' : 'crear'} la disciplina. Intentá nuevamente.`)
      return
    }

    const disciplinaId = esEdicion ? disciplina.id : resultado.data[0].id

    // Sincroniza las franjas (crea/actualiza/borra filas de `classes`) --
    // best-effort DESPUÉS de que la disciplina ya se guardó con éxito: si
    // algo falla acá, la disciplina en sí no se pierde ni queda a medio
    // crear (evita el bug de "reintentar" duplicando la disciplina).
    const idsActuales = new Set(franjasAGuardar.filter((f) => f.id).map((f) => f.id))
    const idsABorrar = [...idsOriginalesRef.current].filter((id) => !idsActuales.has(id))
    const erroresHorarios = []

    if (idsABorrar.length > 0) {
      const { error: delError } = await supabase.from('classes').delete().in('id', idsABorrar)
      if (delError) erroresHorarios.push(delError.message)
    }

    for (const franja of franjasAGuardar) {
      if (franja.id) {
        // Solo días/horario -- nunca pisa título/profesor/cupo (se gestionan
        // aparte desde la pantalla de Clases), así este editor simplificado
        // no borra sin querer un título o profesor ya cargado a mano.
        const { error: updError } = await supabase
          .from('classes')
          .update({ days_of_week: franja.dias, start_time: franja.horaInicio, end_time: franja.horaFin })
          .eq('id', franja.id)
        if (updError) erroresHorarios.push(updError.message)
      } else {
        const { error: insError } = await supabase.from('classes').insert({
          title: form.name.trim(),
          discipline_id: disciplinaId,
          instructor: null,
          capacity: form.default_capacity ? Number(form.default_capacity) : 20,
          days_of_week: franja.dias,
          start_time: franja.horaInicio,
          end_time: franja.horaFin,
        })
        if (insError) erroresHorarios.push(insError.message)
      }
    }

    setGuardando(false)

    if (erroresHorarios.length > 0) {
      console.error('Error al sincronizar los horarios de la disciplina:', erroresHorarios.join(' | '))
      onSaved('Disciplina guardada, pero hubo un error al sincronizar algunos horarios. Revisá la consola.')
    } else {
      onSaved()
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div className="mx-auto my-6 w-full max-w-lg rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{esEdicion ? 'Editar Disciplina' : 'Nueva Disciplina'}</h2>
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
            <label htmlFor="nombreDisciplina" className="text-xs font-medium text-gray-400">
              Nombre
            </label>
            <input
              id="nombreDisciplina"
              type="text"
              required
              placeholder="Ej: Danza"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="tipoDisciplina" className="text-xs font-medium text-gray-400">
              Tipo {esEdicion && <span className="text-gray-600">(no se puede cambiar)</span>}
            </label>
            <select
              id="tipoDisciplina"
              value={form.kind}
              disabled={esEdicion}
              onChange={(e) => updateField('kind', e.target.value)}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary disabled:opacity-50"
            >
              <option value="credits">Por créditos (clases)</option>
              <option value="membership">Por vencimiento (membresía)</option>
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="cupoDisciplina" className="text-xs font-medium text-gray-400">
              Cupo predeterminado
            </label>
            <input
              id="cupoDisciplina"
              type="number"
              min="1"
              placeholder="Ej: 20"
              value={form.default_capacity}
              onChange={(e) => updateField('default_capacity', e.target.value)}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <label htmlFor="descripcionDisciplina" className="text-xs font-medium text-gray-400">
              Descripción
            </label>
            <textarea
              id="descripcionDisciplina"
              rows={3}
              placeholder="Opcional"
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 sm:col-span-2">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => updateField('is_active', e.target.checked)}
              className="h-4 w-4 accent-greenfit-primary"
            />
            <span className="text-sm text-gray-300">
              Activa <span className="text-gray-500">(visible para nuevas reservas y compra de créditos en la app)</span>
            </span>
          </label>

          <div className="flex flex-col gap-2 border-t border-white/5 pt-4 sm:col-span-2">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-greenfit-primary" />
              <span className="text-sm font-medium text-white">Horarios</span>
            </div>
            {form.kind === 'membership' && (
              <p className="text-xs text-gray-500">
                Opcional para "Por vencimiento": si es acceso realmente libre, dejá esto vacío -- la landing va a
                mostrar "Pase Libre / Horario de Gimnasio". Si el gimnasio tiene un horario fijo (ej. 07 a 13 y 16 a
                22 hs), cargalo acá y la landing muestra ese rango en su lugar.
              </p>
            )}

            {cargandoFranjas ? (
              <p className="text-xs text-gray-500">Cargando horarios...</p>
            ) : (
              <>
                {franjas.length === 0 && <p className="text-xs text-gray-500">Todavía no hay franjas horarias cargadas.</p>}
                <div className="flex flex-col gap-3">
                  {franjas.map((franja, indice) => (
                    <div key={indice} className="flex flex-col gap-2 rounded-lg border border-white/5 p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-400">Franja {indice + 1}</span>
                        <button
                          type="button"
                          onClick={() => eliminarFranja(indice)}
                          aria-label={`Eliminar franja ${indice + 1}`}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {DIAS_SEMANA_COMPLETA.map(({ numero, corta, nombre }) => (
                          <button
                            key={numero}
                            type="button"
                            title={nombre}
                            onClick={() => toggleDiaFranja(indice, numero)}
                            className={`flex h-9 min-w-[36px] items-center justify-center rounded-lg px-2 text-xs font-medium transition-colors ${
                              franja.dias.includes(numero)
                                ? 'bg-greenfit-primary text-greenfit-dark'
                                : 'border border-white/10 text-gray-300 hover:bg-white/5 hover:text-white'
                            }`}
                          >
                            {corta}
                          </button>
                        ))}
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div className="flex flex-col gap-1">
                          <label htmlFor={`horaInicio-${indice}`} className="text-xs text-gray-500">
                            Desde
                          </label>
                          <input
                            id={`horaInicio-${indice}`}
                            type="time"
                            value={franja.horaInicio}
                            onChange={(e) => actualizarFranja(indice, { horaInicio: e.target.value })}
                            className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label htmlFor={`horaFin-${indice}`} className="text-xs text-gray-500">
                            Hasta
                          </label>
                          <input
                            id={`horaFin-${indice}`}
                            type="time"
                            value={franja.horaFin}
                            onChange={(e) => actualizarFranja(indice, { horaFin: e.target.value })}
                            className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={agregarFranja}
                  className="flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/15 text-xs font-medium text-gray-300 transition-colors hover:border-greenfit-primary/50 hover:text-greenfit-primary"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Agregar franja horaria
                </button>
              </>
            )}
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

export default DisciplinaModal
