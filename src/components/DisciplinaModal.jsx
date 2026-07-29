import { useState } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'

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

function DisciplinaModal({ disciplina, onClose, onSaved }) {
  const esEdicion = Boolean(disciplina)
  const [form, setForm] = useState(() => formInicial(disciplina))
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  const updateField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }))

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!form.name.trim()) {
      setError('El nombre es obligatorio.')
      return
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

    setGuardando(false)

    if (resultado.error || !resultado.data || resultado.data.length === 0) {
      console.error(
        `Error al ${esEdicion ? 'actualizar' : 'crear'} la disciplina en Supabase:`,
        resultado.error?.message ?? 'no se guardó ninguna fila (revisá las políticas RLS)',
      )
      setError(`No se pudo ${esEdicion ? 'actualizar' : 'crear'} la disciplina. Intentá nuevamente.`)
      return
    }

    onSaved()
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
