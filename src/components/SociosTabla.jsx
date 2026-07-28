import { Eye, CreditCard, Pencil } from 'lucide-react'

const estadoStyles = {
  activo: 'bg-greenfit-primary/15 text-greenfit-primary',
  vencido: 'bg-red-500/15 text-red-400',
  pendiente: 'bg-amber-500/15 text-amber-400',
}

const estadoLabels = {
  activo: 'Activo',
  vencido: 'Cuota Vencida',
  pendiente: 'Pendiente',
}

function EstadoBadge({ estado }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${estadoStyles[estado]}`}
    >
      {estadoLabels[estado]}
    </span>
  )
}

function iniciales(nombre, apellido) {
  return `${nombre.charAt(0)}${apellido.charAt(0)}`.toUpperCase()
}

function SociosTabla({ socios, onVerFicha, onRegistrarPago, onEditar }) {
  return (
    <div className="overflow-x-auto rounded-xl bg-greenfit-card">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead>
          <tr className="border-b border-white/5 text-xs uppercase tracking-wide text-gray-400">
            <th className="px-5 py-3 font-medium">Socio</th>
            <th className="px-5 py-3 font-medium">DNI</th>
            <th className="px-5 py-3 font-medium">Estado</th>
            <th className="px-5 py-3 font-medium">Plan / Membresía</th>
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
                <EstadoBadge estado={socio.estado} />
              </td>
              <td className="px-5 py-3 text-gray-300">{socio.plan}</td>
              <td className="px-5 py-3 text-gray-300">{socio.ultimoPago}</td>
              <td className="px-5 py-3">
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    title="Ver Ficha"
                    onClick={() => onVerFicha(socio)}
                    className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title="Registrar Pago"
                    onClick={() => onRegistrarPago(socio)}
                    className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-white/10 hover:text-greenfit-primary"
                  >
                    <CreditCard className="h-4 w-4" />
                  </button>
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
              <td colSpan={6} className="px-5 py-10 text-center text-gray-400">
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
