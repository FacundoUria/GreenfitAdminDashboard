import { useEffect, useState } from 'react'
import { CalendarOff, Loader2, Plus, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { formatFecha } from '../utils/fecha'

function DiasCerradosCard() {
  const [dias, setDias] = useState([])
  const [cargando, setCargando] = useState(true)
  const [fecha, setFecha] = useState('')
  const [motivo, setMotivo] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  const fetchDias = async () => {
    setCargando(true)
    const { data, error: fetchError } = await supabase
      .from('closed_days')
      .select('id, fecha, motivo')
      .order('fecha', { ascending: true })

    if (fetchError) {
      console.error('Error al cargar días de cierre desde Supabase:', fetchError.message)
    }
    setDias(data ?? [])
    setCargando(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchDias()
  }, [])

  const handleAgregar = async (event) => {
    event.preventDefault()
    setError(null)

    if (!fecha) {
      setError('Elegí una fecha.')
      return
    }

    setGuardando(true)
    const {
      data: { user },
    } = await supabase.auth.getUser()

    const { error: insertError } = await supabase.from('closed_days').insert({
      fecha,
      motivo: motivo.trim() || null,
      created_by: user?.id ?? null,
    })
    setGuardando(false)

    if (insertError) {
      setError(insertError.code === '23505' ? 'Esa fecha ya está marcada como cerrada.' : 'No se pudo guardar la fecha.')
      return
    }

    setFecha('')
    setMotivo('')
    fetchDias()
  }

  const handleEliminar = async (id) => {
    const confirmado = window.confirm('¿Quitar esta fecha de la lista de cierres?')
    if (!confirmado) return

    const { error: deleteError } = await supabase.from('closed_days').delete().eq('id', id)
    if (deleteError) {
      console.error('Error al eliminar día de cierre:', deleteError.message)
      window.alert('No se pudo eliminar la fecha. Intentá nuevamente.')
      return
    }
    setDias((prev) => prev.filter((d) => d.id !== id))
  }

  return (
    <div className="rounded-xl border border-white/5 bg-greenfit-card p-5 lg:col-span-2">
      <h3 className="mb-4 border-b border-white/5 pb-3 text-base font-semibold text-white">
        📅 Días de Cierre / Feriados / Mantenimiento
      </h3>

      <form onSubmit={handleAgregar} className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-1.5 sm:w-48">
          <label className="text-xs font-medium text-gray-400">Fecha</label>
          <input
            type="date"
            value={fecha}
            onChange={(event) => setFecha(event.target.value)}
            className="min-h-[44px] rounded-lg border border-white/10 bg-greenfit-dark px-3 text-sm text-white outline-none focus:border-greenfit-primary"
          />
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-400">Motivo (opcional)</label>
          <input
            type="text"
            value={motivo}
            onChange={(event) => setMotivo(event.target.value)}
            placeholder="Ej: 25 de Mayo - Feriado Nacional"
            className="min-h-[44px] rounded-lg border border-white/10 bg-greenfit-dark px-3 text-sm text-white outline-none placeholder:text-gray-600 focus:border-greenfit-primary"
          />
        </div>
        <button
          type="submit"
          disabled={guardando}
          className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          <Plus className="h-4 w-4" />
          {guardando ? 'Guardando...' : 'Agregar'}
        </button>
      </form>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {cargando ? (
        <div className="flex items-center gap-2 py-6 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Cargando...
        </div>
      ) : dias.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-gray-400">
          <CalendarOff className="h-6 w-6 text-gray-600" />
          No hay fechas de cierre cargadas.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {dias.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-greenfit-dark px-4 py-2.5"
            >
              <div>
                <p className="text-sm font-medium text-white">{formatFecha(d.fecha)}</p>
                {d.motivo && <p className="text-xs text-gray-400">{d.motivo}</p>}
              </div>
              <button
                type="button"
                onClick={() => handleEliminar(d.id)}
                aria-label="Eliminar fecha de cierre"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default DiasCerradosCard
