import { useMemo, useState } from 'react'
import { CreditCard, RefreshCw, X } from 'lucide-react'
import { esPlanDeCreditos, formatearPlanes, normalizarPlanes, PLANES_DISPONIBLES } from '../utils/planes'
import { formatFecha, hoyISO, proximoVencimiento, sumarDias, toISODate } from '../utils/fecha'

const PACKS_RENOVACION = [4, 8, 12, 20]

const METODOS_PAGO = [
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'transferencia', label: 'Transferencia' },
  { value: 'tarjeta', label: 'Tarjeta' },
  { value: 'otro', label: 'Otro' },
]

function iniciales(nombre, apellido) {
  return `${(nombre ?? '?').charAt(0)}${(apellido ?? '').charAt(0)}`.toUpperCase()
}

// `disciplinasActivas` viene de `disciplines` (is_active = true, ver
// Socios.jsx) -- catálogo REAL en vez de la lista fija PLANES_DISPONIBLES
// de utils/planes.js. Cualquier disciplina nueva que Seba cargue desde
// Disciplinas.jsx aparece acá sola, sin deploy. Se arranca igual de la
// lista legacy (backward-compatible con "Pase Libre", que no tiene fila
// propia en `disciplines`) y se le suman las que falten.
function armarPlanesParaElegir(disciplinasActivas) {
  const nombres = new Set(PLANES_DISPONIBLES)
  for (const d of disciplinasActivas) {
    if (d.name) nombres.add(d.name)
  }
  return Array.from(nombres)
}

// Sugerencia inteligente de fechas -- EXCLUSIVA de este modal (nunca de
// "Editar Socio", que siempre tiene que seguir mostrando la fecha_vencimiento
// real de la base, vencida o no). Comparación de strings ISO (YYYY-MM-DD),
// válida porque son todas del mismo largo/formato.
//   - Socio VENCIDO (fecha_vencimiento < hoy): seguir anclando al ciclo
//     viejo no tiene sentido -- Seba está cobrando HOY una cuota nueva, así
//     que la fecha de inicio sugerida es HOY, no una fecha ya pasada.
//   - Socio ACTIVO (fecha_vencimiento >= hoy, o sin fecha todavía): se
//     mantiene el criterio de siempre (continuar desde el vencimiento
//     vigente, o desde hoy si nunca pagó).
function fechaInicioSugerida(socio) {
  const hoy = hoyISO()
  if (!socio.fechaVencimiento) return hoy
  return socio.fechaVencimiento < hoy ? hoy : socio.fechaVencimiento
}

function RegistrarPagoModal({ socio, disciplinasActivas = [], onClose, onConfirmar }) {
  const [planes, setPlanes] = useState(() => normalizarPlanes(socio.plan))
  const [error, setError] = useState(null)

  const disciplinaPorNombre = useMemo(
    () => new Map(disciplinasActivas.map((d) => [(d.name ?? '').trim().toLowerCase(), d])),
    [disciplinasActivas],
  )
  const planesParaElegir = useMemo(() => armarPlanesParaElegir(disciplinasActivas), [disciplinasActivas])
  // `disciplines.kind` (catálogo real) manda sobre la heurística legacy de
  // utils/planes.js cuando la disciplina existe ahí -- más preciso para
  // cualquier disciplina nueva que esa lista hardcodeada todavía no conoce.
  // "Pase Libre" (sin fila propia en `disciplines`) sigue cayendo al
  // fallback de siempre.
  const esCredito = (plan) => {
    const disciplina = disciplinaPorNombre.get(plan.trim().toLowerCase())
    return disciplina ? disciplina.kind === 'credits' : esPlanDeCreditos([plan])
  }

  const tieneCredito = planes.some(esCredito)
  // Bug reportado: antes solo era `true` si había alguna disciplina de
  // vencimiento (Aparatos/Pase Libre) seleccionada -- un socio que hace
  // EXCLUSIVAMENTE CrossFit o Boxeo nunca veía el calendario, sin forma de
  // asignarle/renovarle una fecha de vencimiento a esos packs. Ahora
  // aparece con cualquier plan tildado, sea de crédito o no -- las fechas
  // ya vienen pre-cargadas con una sugerencia por defecto (ver
  // fechaInicioSugerida más abajo), así que esto no agrega ningún campo
  // vacío nuevo que llenar a la fuerza.
  const tieneVencimiento = planes.length > 0
  const planesCredito = planes.filter(esCredito)
  // Una cantidad de créditos por cada actividad de créditos que tenga el
  // socio (ej: CrossFit y Boxeo por separado) -- así una renovación
  // multi-disciplina se carga en un solo envío en vez de repetir la acción
  // una vez por actividad.
  const [cantidades, setCantidades] = useState(() =>
    Object.fromEntries(normalizarPlanes(socio.plan).filter(esCredito).map((p) => [p, ''])),
  )
  // Monto/Método de pago: quedan en el historial de pagos (pagos_socio) --
  // ninguno es obligatorio, Seba puede seguir registrando un pago sin
  // cargarlos si no los tiene a mano en el momento.
  const [monto, setMonto] = useState('')
  const [metodoPago, setMetodoPago] = useState('efectivo')
  const [guardando, setGuardando] = useState(false)
  // Fecha de inicio/vencimiento de esta cuota -- 100% editables por Seba
  // (rangos de 10 días, 15 días, 2 meses, lo que necesite). El valor
  // sugerido por defecto sale de fechaInicioSugerida() de arriba (HOY si
  // el socio está vencido, el vencimiento vigente si sigue activo).
  const [fechaInicio, setFechaInicio] = useState(() => fechaInicioSugerida(socio))
  const [fechaVencimiento, setFechaVencimiento] = useState(() => {
    const inicio = fechaInicioSugerida(socio)
    // Socio vencido: el ciclo arranca de cero desde HOY -- el "día de
    // corte" para esta sugerencia es el día-del-mes de HOY, no el
    // `dia_corte` viejo (ese seguía anclado al ciclo ya vencido). Con eso,
    // proximoVencimiento() da exactamente "HOY + 1 mes". Socio activo: se
    // mantiene el `dia_corte` real del socio, igual que siempre.
    const vencido = socio.fechaVencimiento && socio.fechaVencimiento < hoyISO()
    const diaCorte = vencido
      ? new Date(`${inicio}T00:00:00`).getDate()
      : (socio.diaCorte ?? new Date(`${inicio}T00:00:00`).getDate())
    return toISODate(proximoVencimiento(inicio, diaCorte))
  })

  const handleTogglePlan = (plan) => {
    setError(null)
    const activando = !planes.includes(plan)
    setPlanes(activando ? [...planes, plan] : planes.filter((p) => p !== plan))

    // Al tildar una disciplina "por vencimiento" que tiene días de vigencia
    // configurados (default_capacity reutilizado como "días" para kind=
    // membership, ver DisciplinaModal.jsx), sugiere la fecha de vencimiento
    // sola -- el admin la puede seguir editando a mano después, esto solo
    // cambia el valor SUGERIDO por defecto, nunca se la pisa si ya la había
    // tocado a propósito y después destilda/vuelve a tildar otra cosa.
    if (activando) {
      const disciplina = disciplinaPorNombre.get(plan.trim().toLowerCase())
      const dias = Number(disciplina?.default_capacity)
      if (disciplina?.kind === 'membership' && Number.isFinite(dias) && dias > 0) {
        setFechaVencimiento(toISODate(sumarDias(fechaInicio, dias)))
      }
    }
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
    const creditosPorDisciplina = planes
      .filter(esCredito)
      .map((disciplina) => ({ disciplina, cantidad: Number(cantidades[disciplina]) || 0 }))
      .filter((item) => item.cantidad > 0)

    if (tieneCredito && creditosPorDisciplina.length === 0) {
      setError('Cargá al menos una cantidad de créditos para alguna actividad.')
      return
    }
    if (tieneVencimiento && (!fechaInicio || !fechaVencimiento)) {
      setError('Elegí la fecha de inicio y de vencimiento de la cuota.')
      return
    }
    if (tieneVencimiento && fechaVencimiento < fechaInicio) {
      setError('La fecha de vencimiento no puede ser anterior a la de inicio.')
      return
    }
    // `Number(monto)` da NaN si se tipeó algo no numérico (ej. coma decimal
    // en vez de punto, en algunos navegadores/locales el input numérico
    // igual la deja pasar) -- un NaN viajando en el payload terminaba
    // serializado como `null` en el body JSON de todos modos (silencioso,
    // sin avisar), así que se lo normaliza acá explícitamente a `null` en
    // vez de dejar que ocurra "por accidente".
    const montoNumero = Number(monto)
    const montoSanitizado = monto !== '' && Number.isFinite(montoNumero) ? montoNumero : null

    setError(null)
    setGuardando(true)
    // try/finally -- ante cualquier excepción inesperada que `onConfirmar`
    // deje escapar (Socios.jsx ya la atrapa y avisa, pero esto es una
    // segunda red de seguridad acá), `setGuardando(false)` tiene que correr
    // sí o sí. Sin esto, un error no capturado dejaba el botón trabado en
    // "Guardando..." para siempre -- Seba no podía ni reintentar ni cerrar
    // el modal con el mouse (seguía activo, solo parecía colgado).
    try {
      await onConfirmar(socio, {
        plan: planes,
        ...(creditosPorDisciplina.length > 0 ? { creditosPorDisciplina } : {}),
        ...(tieneVencimiento ? { vencimiento: { fechaInicio, fechaVencimiento } } : {}),
        monto: montoSanitizado,
        metodoPago,
      })
    } finally {
      setGuardando(false)
    }
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
            {planesParaElegir.map((plan) => (
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
            <div className="flex flex-col gap-3 rounded-lg border border-white/10 px-4 py-3">
              <div className="flex items-start gap-2 text-sm text-gray-300">
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-greenfit-primary" />
                <p>
                  {socio.fechaVencimiento && socio.fechaVencimiento < hoyISO()
                    ? `El socio está vencido (venció el ${formatFecha(socio.fechaVencimiento)}) -- por defecto se sugiere arrancar la cuota HOY, con 1 mes de vigencia.`
                    : `Por defecto se sugiere 1 mes desde ${
                        socio.fechaVencimiento ? `el vencimiento actual (${formatFecha(socio.fechaVencimiento)})` : 'hoy'
                      }.`}{' '}
                  Podés cambiar las fechas libremente (ej. 10 días, 15 días, 2 meses). El estado del socio
                  (Activo / Vencido / En Tolerancia) se recalcula solo según lo que elijas acá.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="fechaInicioCuota" className="text-xs font-medium text-gray-400">
                    Fecha de inicio
                  </label>
                  <input
                    id="fechaInicioCuota"
                    type="date"
                    value={fechaInicio}
                    onChange={(e) => setFechaInicio(e.target.value)}
                    className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="fechaVencimientoCuota" className="text-xs font-medium text-gray-400">
                    Fecha de vencimiento
                  </label>
                  <input
                    id="fechaVencimientoCuota"
                    type="date"
                    min={fechaInicio}
                    value={fechaVencimiento}
                    onChange={(e) => setFechaVencimiento(e.target.value)}
                    className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 border-t border-white/5 pt-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="monto" className="text-xs font-medium text-gray-400">
              Monto cobrado (opcional)
            </label>
            <input
              id="monto"
              type="number"
              min="0"
              step="0.01"
              placeholder="$"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="metodoPago" className="text-xs font-medium text-gray-400">
              Método de pago
            </label>
            <select
              id="metodoPago"
              value={metodoPago}
              onChange={(e) => setMetodoPago(e.target.value)}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            >
              {METODOS_PAGO.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
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
