import { useState } from 'react'
import { CreditCard, RefreshCw, X } from 'lucide-react'
import { esPlanDeCreditos, formatearPlanes, tienePlanDeVencimiento } from '../utils/planes'
import { formatFecha } from '../utils/fecha'

const PACKS_RENOVACION = [4, 8, 12, 20]

function iniciales(nombre, apellido) {
  return `${(nombre ?? '?').charAt(0)}${(apellido ?? '').charAt(0)}`.toUpperCase()
}

function RegistrarPagoModal({ socio, onClose, onConfirmar }) {
  const tieneCredito = esPlanDeCreditos(socio.plan)
  const tieneVencimiento = tienePlanDeVencimiento(socio.plan)
  const [cantidad, setCantidad] = useState(12)
  const [guardando, setGuardando] = useState(false)

  const handleConfirmar = async () => {
    setGuardando(true)
    await onConfirmar(socio, {
      ...(tieneCredito ? { creditos: { cantidad: Number(cantidad) || 0 } } : {}),
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
            <p className="text-xs text-gray-400">{formatearPlanes(socio.plan)}</p>
          </div>
        </div>

        <div className="flex flex-col gap-5">
          {tieneCredito && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-gray-400">
                Renovación mensual: sumá los créditos correspondientes a sus actividades. Créditos
                actuales: <span className="font-semibold text-white">{socio.creditos ?? 0}</span>
              </p>

              <div className="flex flex-wrap gap-2">
                {PACKS_RENOVACION.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setCantidad(n)}
                    className={`min-h-[44px] rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                      Number(cantidad) === n
                        ? 'bg-greenfit-primary text-greenfit-dark'
                        : 'border border-white/10 text-gray-300 hover:bg-white/5 hover:text-white'
                    }`}
                  >
                    +{n}
                  </button>
                ))}
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="cantidadCreditos" className="text-xs font-medium text-gray-400">
                  O ajustá la cantidad manualmente
                </label>
                <input
                  id="cantidadCreditos"
                  type="number"
                  min="1"
                  value={cantidad}
                  onChange={(event) => setCantidad(event.target.value)}
                  className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
                />
              </div>

              <p className="text-xs text-gray-500">
                Créditos resultantes: {(socio.creditos ?? 0) + (Number(cantidad) || 0)}
              </p>
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
