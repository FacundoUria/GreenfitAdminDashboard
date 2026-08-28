import { CreditCard, MessageCircle, Minus, Pencil, Plus, UserX, UserCheck } from 'lucide-react'
import { esPlanDeCreditos, formatearPlanes, planesDeCreditos } from '../utils/planes'
import { formatFecha } from '../utils/fecha'

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
  // La baja de cuenta es más fundamental que el estado de pago -- un socio
  // dado de baja se marca así sin importar si tiene créditos o la cuota al día.
  if (socio.activo === false) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-gray-400">
        Inactivo
      </span>
    )
  }

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

// BUG CRÍTICO DE SINCRONIZACIÓN (2026-08-07) -- ANTES esta celda mostraba y
// editaba `socio.creditos`, un solo pozo GLOBAL (suma de TODAS las
// disciplinas de créditos del socio -- ver planesDeCreditos() en
// utils/planes.js), con un <select> aparte y fácil de pasar por alto para
// elegir a CUÁL disciplina viajaba el ajuste hacia la PWA
// (sincronizarCreditosPwa). Un socio con más de una disciplina de créditos
// (ej. CrossFit + Boxeo) podía ver "6" en el panel sin que ese número
// dijera nada de cuál disciplina realmente lo tenía -- y si el <select>
// quedaba en la disciplina "equivocada" al tocar +6, el crédito real
// terminaba sincronizado a la OTRA disciplina en `user_credits`, mientras
// la que el admin creía haber cargado seguía en 0 en la app. Fix: una fila
// POR disciplina, cada una con su propio stepper (nunca ambiguo sobre a
// cuál va el click) y mostrando el número REAL que ya tiene la PWA
// (`socio.creditosPwaPorDisciplina`, batch vía fetchCreditosPorDisciplina
// en Socios.jsx) en vez del pozo global -- lo que ve el admin acá es,
// siempre, lo mismo que tiene la PWA en ese instante.
function CreditosCell({ socio, onAjustarCredito }) {
  const disciplinas = planesDeCreditos(socio.plan)
  if (disciplinas.length === 0) {
    return <span className="text-gray-600">—</span>
  }

  // Clave normalizada (minúsculas + trim) -- mismo criterio que
  // planesDeCreditos/esPlanDeCreditos en utils/planes.js. `socio.plan`
  // (texto libre cargado por el staff) y `disciplines.name` (el catálogo
  // real, de donde sale disciplineName acá) pueden diferir en mayúsculas
  // sin ser "el mismo error" -- una unique constraint case-sensitive deja
  // convivir "Kickstrike" y "kickstrike" como filas DISTINTAS del
  // catálogo. Con una clave exacta, esa diferencia de tipeo alcanzaba para
  // que el balance real nunca matcheara y la grilla mostrara 0 siempre,
  // aunque la PWA sí tuviera créditos de verdad.
  const realPorDisciplina = new Map(
    (socio.creditosPwaPorDisciplina ?? []).map((c) => [(c.disciplineName ?? '').trim().toLowerCase(), c.remainingCredits]),
  )

  return (
    <div className="flex flex-col gap-3">
      {disciplinas.map((disciplina) => (
        <div key={disciplina} className="flex flex-col gap-1.5">
          {disciplinas.length > 1 && (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{disciplina}</span>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              title={`Restar 1 crédito de ${disciplina}`}
              onClick={() => onAjustarCredito(socio, -1, disciplina)}
              className="flex h-10 w-10 items-center justify-center rounded-md border border-white/10 text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span
              className="w-6 text-center text-sm font-semibold text-white"
              title={`Créditos reales de ${disciplina} en la app`}
            >
              {realPorDisciplina.get(disciplina.trim().toLowerCase()) ?? 0}
            </span>
            <button
              type="button"
              title={`Sumar 1 crédito a ${disciplina}`}
              onClick={() => onAjustarCredito(socio, 1, disciplina)}
              className="flex h-10 w-10 items-center justify-center rounded-md border border-white/10 text-gray-300 transition-colors hover:bg-white/10 hover:text-greenfit-primary"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <div className="flex flex-wrap items-center gap-1.5">
              {PACKS_RAPIDOS.map((cantidad) => (
                <button
                  key={cantidad}
                  type="button"
                  title={`Asignar pack de ${cantidad} créditos a ${disciplina}`}
                  onClick={() => onAjustarCredito(socio, cantidad, disciplina)}
                  className="rounded-md border border-white/10 px-2 py-2 text-[11px] font-medium text-gray-400 transition-colors hover:bg-white/10 hover:text-greenfit-primary"
                >
                  +{cantidad}
                </button>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// Una fecha de vencimiento pasada solo tiene sentido mostrarla mientras la
// cuota sigue "activa" (todavía no llegó el día) -- una vez vencida (aunque
// esté en tolerancia) o si el socio no está realmente activo, mostrar la
// fecha vieja es más confuso que útil.
function VencimientoCell({ socio }) {
  if (socio.estado !== 'activo' || !socio.fechaVencimiento) {
    return <span className="text-gray-600">—</span>
  }
  return <span>{formatFecha(socio.fechaVencimiento)}</span>
}

function iniciales(nombre, apellido) {
  return `${(nombre ?? '?').charAt(0)}${(apellido ?? '').charAt(0)}`.toUpperCase()
}

// Misma paleta/criterio que src/components/Avatar.tsx de la PWA: color
// dinámico por nombre (siempre el mismo color para el mismo socio) para que
// el fallback de iniciales no sea el mismo verde repetido para todo el mundo.
const PALETA_AVATAR = ['#80C026', '#3DDC97', '#5FA8FF', '#B98CFF', '#FF7BAC', '#FFB84D', '#FF6B6B', '#4DD0E1']

function colorAvatar(texto) {
  let hash = 0
  for (let i = 0; i < texto.length; i += 1) {
    hash = (hash * 31 + texto.charCodeAt(i)) >>> 0
  }
  return PALETA_AVATAR[hash % PALETA_AVATAR.length]
}

// Avatar sincronizado con la foto real de la PWA (profiles.avatar_url) --
// mismo criterio de fallback que la app: foto si existe, si no iniciales
// con fondo de color dinámico.
function AvatarSocio({ socio, size = 36 }) {
  const dimension = `${size}px`
  if (socio.avatarUrl) {
    return (
      <img
        src={socio.avatarUrl}
        alt={`Foto de ${socio.nombre ?? ''} ${socio.apellido ?? ''}`.trim()}
        style={{ width: dimension, height: dimension }}
        className="shrink-0 rounded-full object-cover"
      />
    )
  }
  const color = colorAvatar(`${socio.nombre ?? ''}${socio.apellido ?? ''}`)
  return (
    <div
      style={{ width: dimension, height: dimension, backgroundColor: `${color}26`, color, borderColor: color }}
      className="flex shrink-0 items-center justify-center rounded-full border text-xs font-semibold"
    >
      {iniciales(socio.nombre, socio.apellido)}
    </div>
  )
}

// Badge "N{x}" de nivel de gamificación -- null mientras no se resolvió
// (socio sin cuenta PWA todavía, o la XP no cargó) para no mostrar "N1" a
// alguien que en realidad no tiene ninguna actividad registrada.
function NivelBadge({ nivel }) {
  if (nivel == null) return null
  return (
    <span
      title={`Nivel ${nivel} (gamificación PWA)`}
      className="inline-flex shrink-0 items-center rounded-full bg-greenfit-primary px-1.5 py-0.5 text-[10px] font-bold text-greenfit-dark"
    >
      {`N${nivel}`}
    </span>
  )
}

function SocioAcciones({ socio, onRegistrarPago, onEditar, onAbrirWhatsapp, onCambiarBaja }) {
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
      <button
        type="button"
        title={socio.activo === false ? 'Reactivar socio' : 'Dar de baja'}
        aria-label={socio.activo === false ? 'Reactivar socio' : 'Dar de baja'}
        onClick={() => onCambiarBaja(socio)}
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors ${
          socio.activo === false ? 'hover:bg-greenfit-primary/15 hover:text-greenfit-primary' : 'hover:bg-red-500/15 hover:text-red-400'
        }`}
      >
        {socio.activo === false ? <UserCheck className="h-4 w-4" /> : <UserX className="h-4 w-4" />}
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
  onCambiarBaja,
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
          <AvatarSocio socio={socio} size={40} />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate font-medium text-white">
              {socio.nombre} {socio.apellido}
              <NivelBadge nivel={socio.nivelXp} />
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
          <p className="text-xs text-gray-500">Vencimiento</p>
          <p className="text-gray-300">
            <VencimientoCell socio={socio} />
          </p>
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
          onCambiarBaja={onCambiarBaja}
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
  onCambiarBaja,
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
            onCambiarBaja={onCambiarBaja}
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
              <th className="px-5 py-3 font-medium">Vencimiento</th>
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
                    <AvatarSocio socio={socio} size={36} />
                    <div>
                      <p className="flex items-center gap-1.5 font-medium text-white">
                        {socio.nombre} {socio.apellido}
                        <NivelBadge nivel={socio.nivelXp} />
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
                <td className="px-5 py-3 text-gray-300">
                  <VencimientoCell socio={socio} />
                </td>
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
                    <button
                      type="button"
                      title={socio.activo === false ? 'Reactivar socio' : 'Dar de baja'}
                      onClick={() => onCambiarBaja(socio)}
                      className={`rounded-lg p-2 text-gray-400 transition-colors ${
                        socio.activo === false
                          ? 'hover:bg-greenfit-primary/15 hover:text-greenfit-primary'
                          : 'hover:bg-red-500/15 hover:text-red-400'
                      }`}
                    >
                      {socio.activo === false ? <UserCheck className="h-4 w-4" /> : <UserX className="h-4 w-4" />}
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
