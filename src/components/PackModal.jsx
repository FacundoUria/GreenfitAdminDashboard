import { useState } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'

function formInicial(pack, disciplinas) {
  if (pack) {
    return {
      name: pack.name ?? '',
      disciplineId: pack.discipline_id ?? disciplinas[0]?.id ?? '',
      price: String(pack.price ?? ''),
      credits: pack.credits != null ? String(pack.credits) : '',
      durationDays: pack.duration_days != null ? String(pack.duration_days) : '',
      isActive: pack.is_active ?? true,
    }
  }
  return {
    name: '',
    disciplineId: disciplinas[0]?.id ?? '',
    price: '',
    credits: '',
    durationDays: '',
    isActive: true,
  }
}

// Alta/edición de UN pack real de `packs` -- la MISMA tabla que lee
// "Elegí tu pack" en la PWA (fetchPacks() en creditsApi.ts) y que la Edge
// Function create-payment-preference usa para resolver el precio real de
// Mercado Pago. Un pack de una disciplina 'credits' (CrossFit/Boxeo/
// Kickboxing) carga `credits`; uno de una disciplina 'membership'
// (Aparatos) carga `duration_days` -- nunca los dos a la vez, el campo que
// no aplica según la disciplina elegida ni se muestra.
function PackModal({ pack, disciplinas, onClose, onSaved }) {
  const esEdicion = Boolean(pack)
  const [form, setForm] = useState(() => formInicial(pack, disciplinas))
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  const updateField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }))

  const disciplinaElegida = disciplinas.find((d) => d.id === form.disciplineId)
  const esMembresia = disciplinaElegida?.kind === 'membership'

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError(null)

    if (!form.name.trim()) {
      setError('El nombre es obligatorio.')
      return
    }
    if (!form.disciplineId) {
      setError('Elegí una disciplina.')
      return
    }
    const price = Number(form.price)
    if (!price || price <= 0) {
      setError('El precio tiene que ser mayor a 0.')
      return
    }
    const credits = esMembresia ? null : Number(form.credits)
    const durationDays = esMembresia ? Number(form.durationDays) : null
    if (esMembresia && (!durationDays || durationDays <= 0)) {
      setError('Los días de vigencia tienen que ser mayores a 0.')
      return
    }
    if (!esMembresia && (!credits || credits <= 0)) {
      setError('La cantidad de créditos tiene que ser mayor a 0.')
      return
    }

    setGuardando(true)

    const payload = {
      name: form.name.trim(),
      discipline_id: form.disciplineId,
      price,
      credits,
      duration_days: durationDays,
      is_active: form.isActive,
    }

    const resultado = esEdicion
      ? await supabase.from('packs').update(payload).eq('id', pack.id).select()
      : await supabase.from('packs').insert(payload).select()

    setGuardando(false)

    if (resultado.error || !resultado.data || resultado.data.length === 0) {
      console.error(
        `Error al ${esEdicion ? 'actualizar' : 'crear'} el pack en Supabase:`,
        resultado.error?.message ?? 'no se guardó ninguna fila (revisá las políticas RLS)',
      )
      // `name` es UNIQUE en `packs`.
      const mensaje = resultado.error?.code === '23505'
        ? `Ya existe un pack llamado "${form.name.trim()}".`
        : `No se pudo ${esEdicion ? 'actualizar' : 'crear'} el pack. Intentá nuevamente.`
      setError(mensaje)
      return
    }

    onSaved()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div className="mx-auto my-6 w-full max-w-lg rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{esEdicion ? 'Editar Pack' : 'Nuevo Pack'}</h2>
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
            <label htmlFor="packName" className="text-xs font-medium text-gray-400">
              Nombre
            </label>
            <input
              id="packName"
              type="text"
              required
              placeholder="Ej: Pack 6 clases CrossFit"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="packDisciplina" className="text-xs font-medium text-gray-400">
              Disciplina
            </label>
            <select
              id="packDisciplina"
              value={form.disciplineId}
              onChange={(e) => updateField('disciplineId', e.target.value)}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            >
              {disciplinas.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="packPrecio" className="text-xs font-medium text-gray-400">
              Precio
            </label>
            <input
              id="packPrecio"
              type="number"
              min="0"
              placeholder="Ej: 20000"
              value={form.price}
              onChange={(e) => updateField('price', e.target.value)}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          {esMembresia ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="packDuracion" className="text-xs font-medium text-gray-400">
                Días de vigencia
              </label>
              <input
                id="packDuracion"
                type="number"
                min="1"
                placeholder="Ej: 30"
                value={form.durationDays}
                onChange={(e) => updateField('durationDays', e.target.value)}
                className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="packCreditos" className="text-xs font-medium text-gray-400">
                Cantidad de créditos
              </label>
              <input
                id="packCreditos"
                type="number"
                min="1"
                placeholder="Ej: 6"
                value={form.credits}
                onChange={(e) => updateField('credits', e.target.value)}
                className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
              />
            </div>
          )}

          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 sm:col-span-2">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => updateField('isActive', e.target.checked)}
              className="h-4 w-4 accent-greenfit-primary"
            />
            <span className="text-sm text-gray-300">
              Activo <span className="text-gray-500">(visible para comprar en "Elegí tu pack" de la app)</span>
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

export default PackModal
