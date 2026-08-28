import { useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'

const MESES_RAPIDOS = [
  { label: '1 Mes', dias: 30 },
  { label: '2 Meses', dias: 60 },
  { label: '3 Meses', dias: 90 },
]

function creditosDesdeDb(pack) {
  if (!Array.isArray(pack?.creditos)) return []
  return pack.creditos.map((c) => ({ disciplineId: c.discipline_id, credits: String(c.credits ?? '') }))
}

function formInicial(pack) {
  if (pack) {
    return {
      name: pack.name ?? '',
      price: String(pack.price ?? ''),
      incluyeAparatos: pack.incluye_aparatos ?? false,
      diasVigencia: pack.dias_vigencia != null ? String(pack.dias_vigencia) : '',
      creditos: creditosDesdeDb(pack),
      isActive: pack.is_active ?? true,
    }
  }
  return { name: '', price: '', incluyeAparatos: false, diasVigencia: '', creditos: [], isActive: true }
}

// Alta/edición de UN pack real de `packs` -- la MISMA tabla que lee "Elegí
// tu pack" en la PWA (fetchPacks() en creditsApi.ts) y que la Edge Function
// create-payment-preference usa para resolver el precio real de Mercado
// Pago. Un pack ya no es "1 disciplina <-> 1 pack": ahora es un combo real
// -- de 0 a N disciplinas de créditos (selector dinámico de filas) +
// opcionalmente Aparatos (switch independiente, con sus propios días de
// vigencia configurables -- nunca un número fijo).
function PackModal({ pack, disciplinas, onClose, onSaved }) {
  const esEdicion = Boolean(pack)
  const [form, setForm] = useState(() => formInicial(pack))
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  // Aparatos (kind='membership') se maneja con el switch de abajo, no como
  // una fila de créditos más -- el selector de "Agregar Disciplina" solo
  // ofrece disciplinas de crédito real (CrossFit, Boxeo, Kickstrike, etc.).
  const disciplinasDeCredito = disciplinas.filter((d) => d.kind !== 'membership')

  const updateField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }))

  const agregarFilaCredito = () => {
    setForm((prev) => ({
      ...prev,
      creditos: [...prev.creditos, { disciplineId: disciplinasDeCredito[0]?.id ?? '', credits: '' }],
    }))
  }

  const quitarFilaCredito = (index) => {
    setForm((prev) => ({ ...prev, creditos: prev.creditos.filter((_, i) => i !== index) }))
  }

  const actualizarFilaCredito = (index, campo, valor) => {
    setForm((prev) => ({
      ...prev,
      creditos: prev.creditos.map((fila, i) => (i === index ? { ...fila, [campo]: valor } : fila)),
    }))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError(null)

    if (!form.name.trim()) {
      setError('El nombre es obligatorio.')
      return
    }
    const price = Number(form.price)
    if (!price || price <= 0) {
      setError('El precio tiene que ser mayor a 0.')
      return
    }
    if (form.incluyeAparatos) {
      const dias = Number(form.diasVigencia)
      if (!dias || dias <= 0) {
        setError('Los días de vigencia de Aparatos tienen que ser mayores a 0.')
        return
      }
    }
    for (const fila of form.creditos) {
      if (!fila.disciplineId) {
        setError('Elegí una disciplina para cada fila de créditos (o quitá la fila).')
        return
      }
      const credits = Number(fila.credits)
      if (!credits || credits <= 0) {
        setError('La cantidad de créditos de cada fila tiene que ser mayor a 0.')
        return
      }
    }
    const disciplinasElegidas = form.creditos.map((f) => f.disciplineId)
    if (new Set(disciplinasElegidas).size !== disciplinasElegidas.length) {
      setError('No podés repetir la misma disciplina en dos filas -- sumá los créditos en una sola.')
      return
    }
    if (form.creditos.length === 0 && !form.incluyeAparatos) {
      setError('El combo tiene que incluir al menos una disciplina de créditos o Aparatos.')
      return
    }

    setGuardando(true)

    const payload = {
      name: form.name.trim(),
      price,
      incluye_aparatos: form.incluyeAparatos,
      dias_vigencia: form.incluyeAparatos ? Number(form.diasVigencia) : null,
      creditos: form.creditos.map((f) => ({ discipline_id: f.disciplineId, credits: Number(f.credits) })),
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

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="packName" className="text-xs font-medium text-gray-400">
              Nombre del Plan/Combo
            </label>
            <input
              id="packName"
              type="text"
              required
              placeholder="Ej: Combo 8+8"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="packPrecio" className="text-xs font-medium text-gray-400">
              Precio ($)
            </label>
            <input
              id="packPrecio"
              type="number"
              min="0"
              placeholder="Ej: 55000"
              value={form.price}
              onChange={(e) => updateField('price', e.target.value)}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-greenfit-dark px-3">
            <input
              type="checkbox"
              role="switch"
              checked={form.incluyeAparatos}
              onChange={(e) => updateField('incluyeAparatos', e.target.checked)}
              className="h-4 w-4 accent-greenfit-primary"
            />
            <span className="text-sm text-gray-300">¿Incluye Aparatos / Musculación?</span>
          </label>

          {form.incluyeAparatos && (
            <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-greenfit-dark p-3">
              <label htmlFor="packDiasVigencia" className="text-xs font-medium text-gray-400">
                Días de Vigencia
              </label>
              <input
                id="packDiasVigencia"
                type="number"
                min="1"
                placeholder="Ej: 60"
                value={form.diasVigencia}
                onChange={(e) => updateField('diasVigencia', e.target.value)}
                className="rounded-lg border border-white/10 bg-greenfit-card px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
              />
              <div className="flex flex-wrap gap-2">
                {MESES_RAPIDOS.map((m) => (
                  <button
                    key={m.dias}
                    type="button"
                    onClick={() => updateField('diasVigencia', String(m.dias))}
                    className="rounded-full border border-white/10 px-3 py-1 text-xs text-gray-300 transition-colors hover:border-greenfit-primary hover:text-greenfit-primary"
                  >
                    {m.label} ({m.dias} días)
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-400">Créditos por Disciplinas</span>
              <button
                type="button"
                onClick={agregarFilaCredito}
                disabled={disciplinasDeCredito.length === 0}
                className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:border-greenfit-primary hover:text-greenfit-primary disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                Agregar Disciplina
              </button>
            </div>

            {form.creditos.length === 0 && (
              <p className="text-xs text-gray-500">
                Sin disciplinas de créditos -- este pack es solo Aparatos (Pase Libre).
              </p>
            )}

            {form.creditos.map((fila, index) => (
              <div key={index} className="flex items-center gap-2">
                <select
                  aria-label={`Disciplina ${index + 1}`}
                  value={fila.disciplineId}
                  onChange={(e) => actualizarFilaCredito(index, 'disciplineId', e.target.value)}
                  className="flex-1 rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
                >
                  {disciplinasDeCredito.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Créditos ${index + 1}`}
                  type="number"
                  min="1"
                  placeholder="Créditos"
                  value={fila.credits}
                  onChange={(e) => actualizarFilaCredito(index, 'credits', e.target.value)}
                  className="w-28 rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
                />
                <button
                  type="button"
                  onClick={() => quitarFilaCredito(index)}
                  aria-label={`Quitar disciplina ${index + 1}`}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>

          <label className="flex min-h-[44px] cursor-pointer items-center gap-2">
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

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="mt-2 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
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
