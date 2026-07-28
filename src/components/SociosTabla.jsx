import { CreditCard, Minus, Pencil, Plus } from 'lucide-react'

const PLANES_DE_CREDITOS = ['crossfit', 'boxeo', 'kickstrike']
const PACKS_RAPIDOS = [4, 8, 12]

function esPlanDeCreditos(plan) {
  return PLANES_DE_CREDITOS.includes((plan ?? '').toLowerCase())
}

const estadoStyles = {
  activo: 'bg-greenfit-primary/15 text-greenfit-primary',
  vencido: 'bg-red-500/15 text-red-400',
  tolerancia: 'bg-amber-500/15 text-amber-400',
  pendiente: 'bg-amber-500/15 text-amber-400',
}

const estadoLabels = {
  activo: 'Activo',
  vencido: 'Cuota Vencida',
  tolerancia: 'En Tolerancia',
  pendiente: 'Pendiente',
}

function EstadoBadge({ socio }) {
  if (esPlanDeCreditos(socio.plan)) {
    const sinCreditos = (socio.creditos ?? 0) <= 0
    return (
      <span
        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
          sinCreditos ? 'bg-red-500/15 text-red-400' : 'bg-greenfit-primary/15 text-greenfit-primary'
        }`}
      >
        {sinCreditos ? 'Sin Créditos' : 'Con Créditos'}
      </span>
    )
  }

  const clave = (socio.estado ?? '').toLowerCase()
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
        estadoStyles[clave] ?? 'bg-white/10 text-gray-300'
      }`}
    >
      {estadoLabels[clave] ?? socio.estado ?? 'Sin estado'}
    </span>
  )
}

function CreditosCell({ socio, onAjustarCredito }) {
  if (!esPlanDeCreditos(socio.plan)) {
    return <span className="text-gray-600">—</span>
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          title="Restar 1 crédito"
          onClick={() => onAjustarCredito(socio, -1)}
          className="rounded-md border border-white/10 p-1 text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
        >
          <Minus className="h-3 w-3" />
        </button>
        <span className="w-6 text-center text-sm font-semibold text-white">{socio.creditos ?? 0}</span>
        <button
          type="button"
          title="Sumar 1 crédito"
          onClick={() => onAjustarCredito(socio, 1)}
          className="rounded-md border border-white/10 p-1 text-gray-300 transition-colors hover:bg-white/10 hover:text-greenfit-primary"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
      <div className="flex items-center gap-1">
        {PACKS_RAPIDOS.map((cantidad) => (
          <button
            key={cantidad}
            type="button"
            title={`Asignar pack de ${cantidad} créditos`}
            onClick={() => onAjustarCredito(socio, cantidad)}
            className="rounded-md border border-white/10 px-1.5 py-0.5 text-[11px] font-medium text-gray-400 transition-colors hover:bg-white/10 hover:text-greenfit-primary"
          >
            +{cantidad}
          </button>
        ))}
      </div>
    </div>
  )
}

function iniciales(nombre, apellido) {
  return `${(nombre ?? '?').charAt(0)}${(apellido ?? '').charAt(0)}`.toUpperCase()
}

function SociosTabla({ socios, onRegistrarPago, onEditar, onAjustarCredito }) {
  return (
    <div className="overflow-x-auto rounded-xl bg-greenfit-card">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead>
          <tr className="border-b border-white/5 text-xs uppercase tracking-wide text-gray-400">
            <th className="px-5 py-3 font-medium">Socio</th>
            <th className="px-5 py-3 font-medium">DNI</th>
            <th className="px-5 py-3 font-medium">Estado</th>
            <th className="px-5 py-3 font-medium">Plan / Membresía</th>
            <th className="px-5 py-3 font-medium">Créditos</th>
            <th className="px-5 py-3 font-medium">Último Pago</th>
            <th className="px-5 py-3 text-right font-medium">Acciones</th>
          </tr>
        </thead>
        <tbody>
          {socios.map((socio) => (
            <tr key={socio.id} className="border-b border-white/5 last:border-0 hover:bg-white/5">
              <td className="px-5 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-greenfit-primary/15 text-xs font-semibold text-greenfit-primary">
                    {iniciales(socio.nombre, socio.apellido)}
                  </div>
                  <div>
                    <p className="font-medium text-white">
                      {socio.nombre} {socio.apellido}
                    </p>
                    <p className="text-xs text-gray-400">{socio.email}</p>
                  </div>
                </div>
              </td>
              <td className="px-5 py-3 text-gray-300">{socio.dni}</td>
              <td className="px-5 py-3">
                <EstadoBadge socio={socio} />
              </td>
              <td className="px-5 py-3 text-gray-300">{socio.plan}</td>
              <td className="px-5 py-3">
                <CreditosCell socio={socio} onAjustarCredito={onAjustarCredito} />
              </td>
              <td className="px-5 py-3 text-gray-300">{socio.ultimoPago}</td>
              <td className="px-5 py-3">
                <div className="flex items-center justify-end gap-1">
                  {!esPlanDeCreditos(socio.plan) && (
                    <button
                      type="button"
                      title="Registrar Pago"
                      onClick={() => onRegistrarPago(socio)}
                      className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-white/10 hover:text-greenfit-primary"
                    >
                      <CreditCard className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    title="Editar"
                    onClick={() => onEditar(socio)}
                    className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                </div>
              </td>
            </tr>
          ))}

          {socios.length === 0 && (
            <tr>
              <td colSpan={7} className="px-5 py-10 text-center text-gray-400">
                No se encontraron socios con los filtros aplicados.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export default SociosTabla
