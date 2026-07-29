import { useState } from 'react'
import { CreditCard, RefreshCw, X } from 'lucide-react'
import {
  esPlanDeCreditos,
  formatearPlanes,
  normalizarPlanes,
  planesDeCreditos,
  PLANES_DISPONIBLES,
  tienePlanDeVencimiento,
} from '../utils/planes'
import { formatFecha } from '../utils/fecha'

const PACKS_RENOVACION = [4, 8, 12, 20]

function iniciales(nombre, apellido) {
  return `${(nombre ?? '?').charAt(0)}${(apellido ?? '').charAt(0)}`.toUpperCase()
}

function RegistrarPagoModal({ socio, onClose, onConfirmar }) {
  const [planes, setPlanes] = useState(() => normalizarPlanes(socio.plan))
  const [error, setError] = useState(null)
  const tieneCredito = esPlanDeCreditos(planes)
  const tieneVencimiento = tienePlanDeVencimiento(planes)
  const planesCredito = planesDeCreditos(planes)
  // Una cantidad de créditos por cada actividad de créditos que tenga el
  // socio (ej: CrossFit y Boxeo por separado) -- así una renovación
  // multi-disciplina se carga en un solo envío en vez de repetir la acción
  // una vez por actividad.
  const [cantidades, setCantidades] = useState(() =>
    Object.fromEntries(planesDeCreditos(normalizarPlanes(socio.plan)).map((p) => [p, ''])),
  )
  const [guardando, setGuardando] = useState(false)

  const handleTogglePlan = (plan) => {
    setError(null)
    setPlanes((prev) => {
      const siguiente = prev.includes(plan) ? prev.filter((p) => p !== plan) : [...prev, plan]
      return siguiente
    })
  }

  const handleChangeCantidad = (disciplina) => (event) => {
    const { value } = event.target
    setCantidades((prev) => ({ ...prev, [disciplina]: value }))
  }

  const handleQuickSelect = (disciplina, valor) => {
    setCantidades((prev) => ({ ...prev, [disciplina]: valor }))
  }

  const handleConfirmar = async () => {
    if (planes.length === 0) {
      setError('Elegí al menos una actividad/plan.')
      return
    }
    const creditosPorDisciplina = planesDeCreditos(planes)
      .map((disciplina) => ({ disciplina, cantidad: Number(cantidades[disciplina]) || 0 }))
      .filter((item) => item.cantidad > 0)

    if (tieneCredito && creditosPorDisciplina.length === 0) {
      setError('Cargá al menos una cantidad de créditos para alguna actividad.')
      return
    }
    setError(null)
    setGuardando(true)
    await onConfirmar(socio, {
      plan: planes,
      ...(creditosPorDisciplina.length > 0 ? { creditosPorDisciplina } : {}),
      ...(tieneVencimiento ? { vencimiento: true } : {}),
    })
    setGuardando(false)
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div className="mx-auto my-6 w-full max-w-md rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Registrar Pago / Renovar Cuota</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-lg bg-greenfit-dark px-4 py-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-greenfit-primary/15 text-sm font-semibold text-greenfit-primary">
            {iniciales(socio.nombre, socio.apellido)}
          </div>
          <div>
            <p className="text-sm font-medium text-white">
              {socio.nombre} {socio.apellido}
            </p>
            <p className="text-xs text-gray-400">Actualmente: {formatearPlanes(socio.plan)}</p>
          </div>
        </div>

        <div className="mb-5 flex flex-col gap-2">
          <span className="text-xs font-medium text-gray-400">Actividad / Plan de este pago</span>
          <div className="flex flex-wrap gap-2">
            {PLANES_DISPONIBLES.map((plan) => (
              <label
                key={plan}
                className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                  planes.includes(plan)
                    ? 'border-greenfit-primary bg-greenfit-primary/10 text-white'
                    : 'border-white/10 text-gray-300 hover:bg-white/5'
                }`}
              >
                <input
                  type="checkbox"
                  checked={planes.includes(plan)}
                  onChange={() => handleTogglePlan(plan)}
                  className="accent-greenfit-primary"
                />
                {plan}
              </label>
            ))}
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <div className="flex flex-col gap-5">
          {tieneCredito && (
            <div className="flex flex-col gap-5">
              <p className="text-sm text-gray-400">
                Renovación mensual: cargá los créditos de cada actividad por separado. Créditos
                actuales (total del panel): <span className="font-semibold text-white">{socio.creditos ?? 0}</span>
              </p>

              {planesCredito.map((disciplina) => (
                <div key={disciplina} className="flex flex-col gap-2 rounded-lg border border-white/5 p-3">
                  <span className="text-xs font-semibold text-white">{disciplina}</span>
                  <div className="flex flex-wrap gap-2">
                    {PACKS_RENOVACION.map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => handleQuickSelect(disciplina, n)}
                        className={`min-h-[40px] rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                          Number(cantidades[disciplina]) === n
                            ? 'bg-greenfit-primary text-greenfit-dark'
                            : 'border border-white/10 text-gray-300 hover:bg-white/5 hover:text-white'
                        }`}
                      >
                        +{n}
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={cantidades[disciplina] ?? ''}
                    onChange={handleChangeCantidad(disciplina)}
                    className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
                  />
                </div>
              ))}
            </div>
          )}

          {tieneVencimiento && (
            <div className="flex items-start gap-2 rounded-lg border border-white/10 px-4 py-3 text-sm text-gray-300">
              <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-greenfit-primary" />
              <p>
                Se va a renovar la cuota por <span className="font-medium text-white">1 mes</span> desde
                el vencimiento actual ({formatFecha(socio.fechaVencimiento)}), respetando el día de corte
                fijo (día {socio.diaCorte ?? '—'}).
              </p>
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-[44px] items-center justify-center rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirmar}
            disabled={guardando}
            className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <CreditCard className="h-4 w-4" />
            {guardando ? 'Guardando...' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default RegistrarPagoModal
