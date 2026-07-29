import { CreditCard, MessageCircle, Minus, Pencil, Plus } from 'lucide-react'
import { esPlanDeCreditos, formatearPlanes } from '../utils/planes'

const PACKS_RAPIDOS = [4, 8, 12]

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
        className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium ${
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
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium ${
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
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          title="Restar 1 crédito"
          onClick={() => onAjustarCredito(socio, -1)}
          className="flex h-10 w-10 items-center justify-center rounded-md border border-white/10 text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="w-6 text-center text-sm font-semibold text-white">{socio.creditos ?? 0}</span>
        <button
          type="button"
          title="Sumar 1 crédito"
          onClick={() => onAjustarCredito(socio, 1)}
          className="flex h-10 w-10 items-center justify-center rounded-md border border-white/10 text-gray-300 transition-colors hover:bg-white/10 hover:text-greenfit-primary"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {PACKS_RAPIDOS.map((cantidad) => (
          <button
            key={cantidad}
            type="button"
            title={`Asignar pack de ${cantidad} créditos`}
            onClick={() => onAjustarCredito(socio, cantidad)}
            className="rounded-md border border-white/10 px-2 py-2 text-[11px] font-medium text-gray-400 transition-colors hover:bg-white/10 hover:text-greenfit-primary"
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

function SocioAcciones({ socio, onRegistrarPago, onEditar, onAbrirWhatsapp }) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        title="Registrar Pago / Renovar Cuota"
        onClick={() => onRegistrarPago(socio)}
        className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-greenfit-primary/10 px-2.5 text-xs font-semibold text-greenfit-primary transition-colors hover:bg-greenfit-primary/20"
      >
        <CreditCard className="h-4 w-4" />
        Cobrar
      </button>
      <button
        type="button"
        title="Enviar WhatsApp"
        aria-label="Enviar WhatsApp"
        onClick={() => onAbrirWhatsapp(socio)}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-[#25D366]/15 hover:text-[#25D366]"
      >
        <MessageCircle className="h-4 w-4" />
      </button>
      <button
        type="button"
        title="Editar"
        aria-label="Editar"
        onClick={() => onEditar(socio)}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
      >
        <Pencil className="h-4 w-4" />
      </button>
    </div>
  )
}

function SocioCard({
  socio,
  onRegistrarPago,
  onEditar,
  onAjustarCredito,
  onAbrirWhatsapp,
  seleccionado,
  onToggleSeleccionado,
}) {
  return (
    <div className="rounded-xl bg-greenfit-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <input
            type="checkbox"
            checked={seleccionado}
            onChange={onToggleSeleccionado}
            className="h-5 w-5 shrink-0 accent-greenfit-primary"
            aria-label={`Seleccionar ${socio.nombre}`}
          />
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-greenfit-primary/15 text-xs font-semibold text-greenfit-primary">
            {iniciales(socio.nombre, socio.apellido)}
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium text-white">
              {socio.nombre} {socio.apellido}
            </p>
            <p className="truncate text-xs text-gray-400">{socio.email}</p>
          </div>
        </div>
        <EstadoBadge socio={socio} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-gray-500">DNI</p>
          <p className="text-gray-300">{socio.dni || '—'}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Plan / Membresía</p>
          <p className="text-gray-300">{formatearPlanes(socio.plan)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Último Pago</p>
          <p className="text-gray-300">{socio.ultimoPago}</p>
        </div>
        <div>
          <p className="mb-1 text-xs text-gray-500">Créditos</p>
          <CreditosCell socio={socio} onAjustarCredito={onAjustarCredito} />
        </div>
      </div>

      <div className="mt-4 border-t border-white/5 pt-3">
        <SocioAcciones
          socio={socio}
          onRegistrarPago={onRegistrarPago}
          onEditar={onEditar}
          onAbrirWhatsapp={onAbrirWhatsapp}
        />
      </div>
    </div>
  )
}

function SociosTabla({
  socios,
  onRegistrarPago,
  onEditar,
  onAjustarCredito,
  onAbrirWhatsapp,
  seleccionados,
  onToggleSeleccionado,
  onToggleSeleccionarTodos,
}) {
  const todosSeleccionados = socios.length > 0 && socios.every((s) => seleccionados.has(s.id))

  if (socios.length === 0) {
    return (
      <div className="rounded-xl bg-greenfit-card px-5 py-10 text-center text-sm text-gray-400">
        No se encontraron socios con los filtros aplicados.
      </div>
    )
  }

  return (
    <>
      {/* Vista de tarjetas: pantallas chicas (< md) */}
      <div className="flex flex-col gap-3 md:hidden">
        <label className="flex items-center gap-2 px-1 text-xs font-medium text-gray-400">
          <input
            type="checkbox"
            checked={todosSeleccionados}
            onChange={onToggleSeleccionarTodos}
            className="h-5 w-5 accent-greenfit-primary"
            aria-label="Seleccionar todos"
          />
          Seleccionar todos
        </label>

        {socios.map((socio) => (
          <SocioCard
            key={socio.id}
            socio={socio}
            onRegistrarPago={onRegistrarPago}
            onEditar={onEditar}
            onAjustarCredito={onAjustarCredito}
            onAbrirWhatsapp={onAbrirWhatsapp}
            seleccionado={seleccionados.has(socio.id)}
            onToggleSeleccionado={() => onToggleSeleccionado(socio.id)}
          />
        ))}
      </div>

      {/* Vista de tabla: pantallas medianas y grandes (>= md) */}
      <div className="hidden overflow-x-auto rounded-xl bg-greenfit-card md:block">
        <table className="w-full min-w-[920px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/5 text-xs uppercase tracking-wide text-gray-400">
              <th className="w-10 px-5 py-3">
                <input
                  type="checkbox"
                  checked={todosSeleccionados}
                  onChange={onToggleSeleccionarTodos}
                  className="accent-greenfit-primary"
                  aria-label="Seleccionar todos"
                />
              </th>
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
                  <input
                    type="checkbox"
                    checked={seleccionados.has(socio.id)}
                    onChange={() => onToggleSeleccionado(socio.id)}
                    className="accent-greenfit-primary"
                    aria-label={`Seleccionar ${socio.nombre}`}
                  />
                </td>
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
                <td className="px-5 py-3 text-gray-300">{formatearPlanes(socio.plan)}</td>
                <td className="px-5 py-3">
                  <CreditosCell socio={socio} onAjustarCredito={onAjustarCredito} />
                </td>
                <td className="px-5 py-3 text-gray-300">{socio.ultimoPago}</td>
                <td className="px-5 py-3">
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      title="Registrar Pago / Renovar Cuota"
                      onClick={() => onRegistrarPago(socio)}
                      className="flex items-center gap-1.5 rounded-lg bg-greenfit-primary/10 px-2.5 py-1.5 text-xs font-semibold text-greenfit-primary transition-colors hover:bg-greenfit-primary/20"
                    >
                      <CreditCard className="h-3.5 w-3.5" />
                      Cobrar
                    </button>
                    <button
                      type="button"
                      title="Enviar WhatsApp"
                      onClick={() => onAbrirWhatsapp(socio)}
                      className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-[#25D366]/15 hover:text-[#25D366]"
                    >
                      <MessageCircle className="h-4 w-4" />
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
          </tbody>
        </table>
      </div>
    </>
  )
}

export default SociosTabla
