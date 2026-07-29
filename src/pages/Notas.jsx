import { useMemo, useState } from 'react'
import { CheckCircle2, Circle, Plus, Trash2 } from 'lucide-react'
import { useNotas } from '../context/useNotas'

const FILTROS = [
  { value: 'todas', label: 'Todas' },
  { value: 'pendiente', label: 'Pendientes' },
  { value: 'completada', label: 'Completadas' },
]

const formInicial = { titulo: '', detalle: '', fechaAlerta: '' }

function formatearFechaAlerta(valor) {
  if (!valor) return null
  const fecha = new Date(valor)
  if (Number.isNaN(fecha.getTime())) return null
  return fecha.toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function Notas() {
  const { notas, agregarNota, actualizarNota, eliminarNota } = useNotas()
  const [filtro, setFiltro] = useState('todas')
  const [form, setForm] = useState(formInicial)

  const notasFiltradas = useMemo(() => {
    const ordenadas = [...notas].sort((a, b) => new Date(b.creadaEn) - new Date(a.creadaEn))
    return filtro === 'todas' ? ordenadas : ordenadas.filter((n) => n.estado === filtro)
  }, [notas, filtro])

  const handleChange = (campo) => (event) => {
    setForm((prev) => ({ ...prev, [campo]: event.target.value }))
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    if (!form.titulo.trim()) return

    agregarNota({
      titulo: form.titulo.trim(),
      detalle: form.detalle.trim(),
      fechaAlerta: form.fechaAlerta || null,
    })
    setForm(formInicial)
  }

  const handleToggleEstado = (nota) => {
    actualizarNota(nota.id, { estado: nota.estado === 'completada' ? 'pendiente' : 'completada' })
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Notas / Recordatorios</h2>
        <p className="text-sm text-gray-400">Anotaciones rápidas y alertas para no olvidarte nada.</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-xl bg-greenfit-card p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="titulo" className="text-xs font-medium text-gray-400">
              Título
            </label>
            <input
              id="titulo"
              type="text"
              required
              value={form.titulo}
              onChange={handleChange('titulo')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="fechaAlerta" className="text-xs font-medium text-gray-400">
              Fecha/Hora de alerta (opcional)
            </label>
            <input
              id="fechaAlerta"
              type="datetime-local"
              value={form.fechaAlerta}
              onChange={handleChange('fechaAlerta')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="detalle" className="text-xs font-medium text-gray-400">
            Detalle
          </label>
          <textarea
            id="detalle"
            rows={3}
            value={form.detalle}
            onChange={handleChange('detalle')}
            className="w-full resize-none rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
          />
        </div>

        <div>
          <button
            type="submit"
            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90 sm:w-auto"
          >
            <Plus className="h-4 w-4" />
            Agregar Nota
          </button>
        </div>
      </form>

      <div className="flex flex-wrap gap-2">
        {FILTROS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFiltro(f.value)}
            className={`min-h-[44px] rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
              filtro === f.value
                ? 'bg-greenfit-primary text-greenfit-dark'
                : 'bg-greenfit-card text-gray-300 hover:text-white'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {notasFiltradas.length === 0 ? (
        <div className="rounded-xl bg-greenfit-card p-10 text-center text-sm text-gray-400">
          No hay notas para mostrar.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {notasFiltradas.map((nota) => {
            const completada = nota.estado === 'completada'
            const fechaAlertaTexto = formatearFechaAlerta(nota.fechaAlerta)

            return (
              <div
                key={nota.id}
                className={`flex items-start gap-3 rounded-xl bg-greenfit-card p-4 ${
                  completada ? 'opacity-60' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleToggleEstado(nota)}
                  title={completada ? 'Marcar como pendiente' : 'Marcar como completada'}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-greenfit-primary"
                >
                  {completada ? (
                    <CheckCircle2 className="h-5 w-5 text-greenfit-primary" />
                  ) : (
                    <Circle className="h-5 w-5" />
                  )}
                </button>

                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm font-medium ${
                      completada ? 'text-gray-400 line-through' : 'text-white'
                    }`}
                  >
                    {nota.titulo}
                  </p>
                  {nota.detalle && <p className="mt-1 text-sm text-gray-400">{nota.detalle}</p>}
                  {fechaAlertaTexto && (
                    <p className="mt-1.5 text-xs text-amber-400">⏰ Alerta: {fechaAlertaTexto}</p>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => eliminarNota(nota.id)}
                  title="Eliminar"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-white/5 hover:text-red-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default Notas
