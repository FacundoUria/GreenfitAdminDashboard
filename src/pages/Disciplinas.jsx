import { useEffect, useState } from 'react'
import { CheckCircle2, Clock, Loader2, Pencil, Plus, Power, Tags, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import DisciplinaModal from '../components/DisciplinaModal'
import { agruparClasesPorBloqueHorario, formatearFranjaHoraria } from '../utils/horarios'

function Toast({ message }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg bg-greenfit-card px-4 py-3 shadow-xl ring-1 ring-white/10">
      <CheckCircle2 className="h-5 w-5 text-greenfit-primary" />
      <span className="text-sm font-medium text-white">{message}</span>
    </div>
  )
}

function Disciplinas() {
  const [disciplinas, setDisciplinas] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [modalAbierto, setModalAbierto] = useState(false)
  const [disciplinaEnEdicion, setDisciplinaEnEdicion] = useState(null)
  const [toastMessage, setToastMessage] = useState(null)
  // Franjas horarias (tabla `classes`) agrupadas por discipline_id -- la
  // MISMA tabla que ya consume "Elegí tu ritmo" en la landing y la pantalla
  // de Clases, así la tarjeta acá muestra exactamente lo que vería un
  // visitante del sitio. Se trae en batch (1 query para todas las tarjetas).
  const [bloquesPorDisciplina, setBloquesPorDisciplina] = useState(new Map())

  const fetchDisciplinas = async () => {
    setLoading(true)
    setError(null)
    const { data, error: fetchError } = await supabase.from('disciplines').select('*').order('name')
    if (fetchError) {
      console.error('Error al cargar disciplinas desde Supabase:', fetchError.message)
      setError('No se pudieron cargar las disciplinas. Verificá la conexión con Supabase.')
      setDisciplinas([])
      setLoading(false)
      return
    }

    const filas = data ?? []
    setDisciplinas(filas)
    setLoading(false)

    // Best-effort, aparte del fetch principal -- si falla no debe bloquear
    // el catálogo, es un dato "de más" (horarios), no crítico para
    // administrar altas/bajas de disciplinas. Se pide para TODAS las
    // disciplinas, sin importar `kind`: una "por vencimiento" (Aparatos)
    // también puede tener horario real de gimnasio cargado ahora.
    const idsDisciplinas = filas.map((d) => d.id)
    if (idsDisciplinas.length === 0) {
      setBloquesPorDisciplina(new Map())
      return
    }
    const { data: clases, error: clasesError } = await supabase
      .from('classes')
      .select('discipline_id, days_of_week, start_time, end_time')
      .in('discipline_id', idsDisciplinas)
    if (clasesError) {
      console.error('No se pudieron cargar los horarios de las disciplinas:', clasesError.message)
      return
    }
    const porDisciplina = new Map()
    for (const clase of clases ?? []) {
      const lista = porDisciplina.get(clase.discipline_id) ?? []
      lista.push(clase)
      porDisciplina.set(clase.discipline_id, lista)
    }
    const bloques = new Map()
    for (const [discId, clasesDeEsta] of porDisciplina) {
      bloques.set(discId, agruparClasesPorBloqueHorario(clasesDeEsta))
    }
    setBloquesPorDisciplina(bloques)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchDisciplinas()
  }, [])

  const mostrarToast = (mensaje) => {
    setToastMessage(mensaje)
    setTimeout(() => setToastMessage(null), 2500)
  }

  const handleToggleActiva = async (disciplina) => {
    const { data, error: updateError } = await supabase
      .from('disciplines')
      .update({ is_active: !disciplina.is_active })
      .eq('id', disciplina.id)
      .select()

    if (updateError || !data || data.length === 0) {
      console.error(
        'Error al cambiar el estado de la disciplina:',
        updateError?.message ?? 'no se actualizó ninguna fila (revisá las políticas RLS)',
      )
      window.alert('No se pudo cambiar el estado de la disciplina. Intentá nuevamente.')
      return
    }
    mostrarToast(disciplina.is_active ? 'Disciplina desactivada' : 'Disciplina activada')
    fetchDisciplinas()
  }

  const handleEliminar = async (disciplina) => {
    // Antes de intentar borrar, chequeamos si tiene datos dependientes (packs,
    // clases, créditos ya cargados) -- borrarla ahí rompería la integridad
    // referencial de reservas/pagos existentes. Si tiene uso real, la única
    // opción segura es desactivarla, no eliminarla.
    const [{ count: packs }, { count: clases }, { count: creditos }] = await Promise.all([
      supabase.from('packs').select('id', { count: 'exact', head: true }).eq('discipline_id', disciplina.id),
      supabase.from('classes').select('id', { count: 'exact', head: true }).eq('discipline_id', disciplina.id),
      supabase.from('user_credits').select('id', { count: 'exact', head: true }).eq('discipline_id', disciplina.id),
    ])

    const enUso = (packs ?? 0) > 0 || (clases ?? 0) > 0 || (creditos ?? 0) > 0
    if (enUso) {
      window.alert(
        `"${disciplina.name}" tiene datos asociados (packs, clases o créditos ya cargados) y no se puede eliminar sin romper el historial. Desactivala en su lugar.`,
      )
      return
    }

    if (!window.confirm(`¿Eliminar la disciplina "${disciplina.name}"? Esta acción no se puede deshacer.`)) return

    const { error: deleteError } = await supabase.from('disciplines').delete().eq('id', disciplina.id)
    if (deleteError) {
      console.error('Error al eliminar la disciplina:', deleteError.message)
      window.alert('No se pudo eliminar la disciplina. Intentá nuevamente.')
      return
    }
    mostrarToast('Disciplina eliminada')
    fetchDisciplinas()
  }

  const handleAbrirNueva = () => {
    setDisciplinaEnEdicion(null)
    setModalAbierto(true)
  }

  const handleEditar = (disciplina) => {
    setDisciplinaEnEdicion(disciplina)
    setModalAbierto(true)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Disciplinas</h2>
          <p className="text-sm text-gray-400">Catálogo de actividades del gimnasio.</p>
        </div>
        <button
          type="button"
          onClick={handleAbrirNueva}
          className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Nueva Disciplina
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl bg-greenfit-card p-10 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Cargando disciplinas...
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 p-10 text-center text-sm text-red-400">
          <p>{error}</p>
          <button
            type="button"
            onClick={fetchDisciplinas}
            className="rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10"
          >
            Reintentar
          </button>
        </div>
      ) : disciplinas.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl bg-greenfit-card p-10 text-center text-sm text-gray-400">
          <Tags className="h-8 w-8 text-gray-600" />
          Todavía no hay disciplinas cargadas.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {disciplinas.map((disciplina) => (
            <div
              key={disciplina.id}
              data-testid={`disciplina-card-${disciplina.id}`}
              className="flex flex-col gap-3 rounded-xl border border-white/5 bg-greenfit-card p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-white">{disciplina.name}</p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {disciplina.kind === 'membership' ? 'Por vencimiento' : 'Por créditos'}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                    disciplina.is_active
                      ? 'bg-greenfit-primary/15 text-greenfit-primary'
                      : 'bg-white/10 text-gray-400'
                  }`}
                >
                  {disciplina.is_active ? 'Activa' : 'Inactiva'}
                </span>
              </div>

              {disciplina.description && <p className="text-xs text-gray-400">{disciplina.description}</p>}
              {disciplina.default_capacity != null && (
                <p className="text-xs text-gray-500">Cupo predeterminado: {disciplina.default_capacity}</p>
              )}

              <div className="flex items-start gap-2 rounded-lg bg-white/[0.03] px-3 py-2.5 text-xs text-gray-300">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-greenfit-primary" />
                {(() => {
                  const bloques = bloquesPorDisciplina.get(disciplina.id) ?? []
                  if (bloques.length > 0) {
                    return (
                      <div className="flex flex-col gap-1">
                        {bloques.map((bloque, indice) => (
                          <span key={indice}>{formatearFranjaHoraria(bloque)}</span>
                        ))}
                      </div>
                    )
                  }
                  // Sin franjas cargadas: para "por vencimiento" (Aparatos) es
                  // el estado esperado por diseño (acceso libre real) más a
                  // menudo que un olvido -- mismo texto que ya muestra la
                  // landing en ese caso. Para créditos, sigue siendo "che,
                  // faltan cargar los horarios".
                  return disciplina.kind === 'membership' ? (
                    <span className="text-gray-400">Pase libre / Horario de gimnasio</span>
                  ) : (
                    <span className="text-gray-500">Sin horarios cargados</span>
                  )
                })()}
              </div>

              <div className="mt-auto flex items-center gap-2 border-t border-white/5 pt-3">
                <button
                  type="button"
                  onClick={() => handleEditar(disciplina)}
                  className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 text-xs font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Editar
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleActiva(disciplina)}
                  title={disciplina.is_active ? 'Desactivar' : 'Activar'}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <Power className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleEliminar(disciplina)}
                  title="Eliminar"
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-gray-300 transition-colors hover:bg-red-500/10 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modalAbierto && (
        <DisciplinaModal
          key={disciplinaEnEdicion?.id ?? 'nueva'}
          disciplina={disciplinaEnEdicion}
          onClose={() => {
            setModalAbierto(false)
            setDisciplinaEnEdicion(null)
          }}
          onSaved={(mensaje) => {
            fetchDisciplinas()
            mostrarToast(mensaje ?? (disciplinaEnEdicion ? 'Disciplina actualizada' : 'Disciplina creada'))
          }}
        />
      )}

      {toastMessage && <Toast message={toastMessage} />}
    </div>
  )
}

export default Disciplinas
