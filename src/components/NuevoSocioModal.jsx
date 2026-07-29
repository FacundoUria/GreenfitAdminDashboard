import { useState } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { hoyISO, proximoVencimiento, toISODate } from '../utils/fecha'
import { PLANES_DISPONIBLES, normalizarPlanes, planesDeCreditos, tienePlanDeVencimiento } from '../utils/planes'
import { sincronizarCreditosPwa, sincronizarVencimientoPwa } from '../utils/creditosPwa'

function formInicial(socio) {
  if (socio) {
    const planesActuales = normalizarPlanes(socio.plan)
    return {
      nombre: socio.nombre ?? '',
      apellido: socio.apellido ?? '',
      dni: socio.dni ?? '',
      email: socio.email ?? '',
      telefono: socio.telefono ?? '',
      planes: planesActuales.length > 0 ? planesActuales : [PLANES_DISPONIBLES[0]],
      fechaInicio: hoyISO(),
      creditosPorDisciplina: {},
    }
  }

  return {
    nombre: '',
    apellido: '',
    dni: '',
    email: '',
    telefono: '',
    planes: [PLANES_DISPONIBLES[0]],
    fechaInicio: hoyISO(),
    creditosPorDisciplina: {},
  }
}

// El alta de socio dispara el trigger `on_socio_dni_upsert`, que crea la
// cuenta de Auth de la PWA de forma ASÍNCRONA (llamada HTTP vía pg_net, sin
// vuelta síncrona a este cliente) -- si se intenta sincronizar créditos o
// vencimiento apenas el INSERT de `socios` devuelve éxito, lo más probable
// es que la cuenta todavía no exista. Esperamos a que `profiles` la tenga
// lista (hasta ~5s) antes de sincronizar.
async function esperarCuentaPwa(dni, intentos = 6, esperaMs = 800) {
  for (let i = 0; i < intentos; i += 1) {
    const { data } = await supabase.from('profiles').select('id').eq('dni', dni).maybeSingle()
    if (data?.id) return true
    if (i < intentos - 1) await new Promise((resolve) => setTimeout(resolve, esperaMs))
  }
  return false
}

function NuevoSocioModal({ socio, onClose, onSaved }) {
  const esEdicion = Boolean(socio)
  const [form, setForm] = useState(() => formInicial(socio))
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  const handleChange = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }))
  }

  const handleTogglePlan = (plan) => {
    setForm((prev) => ({
      ...prev,
      planes: prev.planes.includes(plan)
        ? prev.planes.filter((p) => p !== plan)
        : [...prev.planes, plan],
    }))
  }

  const handleChangeCredito = (disciplina) => (event) => {
    const { value } = event.target
    setForm((prev) => ({
      ...prev,
      creditosPorDisciplina: { ...prev.creditosPorDisciplina, [disciplina]: value },
    }))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()

    if (form.planes.length === 0) {
      setError('Seleccioná al menos un plan/actividad.')
      return
    }

    setGuardando(true)
    setError(null)

    let resultado
    let fechaVencimientoNueva = null

    if (esEdicion) {
      resultado = await supabase
        .from('socios')
        .update({
          nombre: form.nombre,
          apellido: form.apellido,
          dni: form.dni,
          email: form.email,
          telefono: form.telefono,
          plan: form.planes,
        })
        .eq('id', socio.id)
        .select()
    } else {
      const fechaInicio = form.fechaInicio || hoyISO()
      // El día de alta fija el "día de corte" del ciclo de cobro del socio para siempre.
      const diaCorte = new Date(`${fechaInicio}T00:00:00`).getDate()
      fechaVencimientoNueva = toISODate(proximoVencimiento(fechaInicio, diaCorte))

      resultado = await supabase
        .from('socios')
        .insert({
          nombre: form.nombre,
          apellido: form.apellido,
          dni: form.dni,
          email: form.email,
          telefono: form.telefono,
          plan: form.planes,
          estado: 'Activo',
          ultimo_pago: fechaInicio,
          dia_corte: diaCorte,
          fecha_vencimiento: fechaVencimientoNueva,
        })
        .select()
    }

    // Un UPDATE bloqueado por RLS puede volver sin `error` pero sin filas afectadas.
    if (resultado.error || !resultado.data || resultado.data.length === 0) {
      console.error(
        `Error al ${esEdicion ? 'actualizar' : 'crear'} el socio en Supabase:`,
        resultado.error?.message ?? 'no se guardó ninguna fila (revisá las políticas RLS)',
      )
      setError(`No se pudo ${esEdicion ? 'actualizar' : 'guardar'} el socio. Intentá nuevamente.`)
      setGuardando(false)
      return
    }

    // Alta nueva: además de la tabla legacy `socios`, cargamos los créditos
    // por disciplina y/o el vencimiento de Aparatos/Musculación en la tabla
    // real que lee la PWA (`user_credits`) -- sin esto el socio recién
    // creado no ve nada en su Home hasta una acción separada posterior.
    if (!esEdicion) {
      const disciplinasCredito = planesDeCreditos(form.planes)
      const necesitaVencimiento = tienePlanDeVencimiento(form.planes)
      const avisos = []

      if (disciplinasCredito.length > 0 || necesitaVencimiento) {
        const cuentaLista = await esperarCuentaPwa(form.dni)
        if (!cuentaLista) {
          avisos.push(
            'La cuenta de la app todavía se está generando: cargá los créditos/vencimiento en unos segundos desde "Registrar Pago".',
          )
        } else {
          for (const disciplina of disciplinasCredito) {
            const cantidad = Number(form.creditosPorDisciplina[disciplina]) || 0
            if (cantidad <= 0) continue
            const resultadoSync = await sincronizarCreditosPwa({ dni: form.dni, disciplina, delta: cantidad })
            if (!resultadoSync.synced) avisos.push(`No se pudieron cargar los créditos de ${disciplina} en la app.`)
          }

          if (necesitaVencimiento) {
            const resultadoSync = await sincronizarVencimientoPwa({
              dni: form.dni,
              fechaVencimiento: fechaVencimientoNueva,
            })
            if (!resultadoSync.synced) {
              avisos.push('No se pudo cargar el vencimiento de Aparatos/Musculación en la app.')
            }
          }
        }
      }

      if (avisos.length > 0) window.alert(avisos.join('\n'))
    }

    setGuardando(false)
    onSaved()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div className="mx-auto my-6 w-full max-w-lg rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{esEdicion ? 'Editar Socio' : 'Nuevo Socio'}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="nombre" className="text-xs font-medium text-gray-400">
              Nombre
            </label>
            <input
              id="nombre"
              type="text"
              required
              value={form.nombre}
              onChange={handleChange('nombre')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="apellido" className="text-xs font-medium text-gray-400">
              Apellido
            </label>
            <input
              id="apellido"
              type="text"
              required
              value={form.apellido}
              onChange={handleChange('apellido')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="dni" className="text-xs font-medium text-gray-400">
              DNI
            </label>
            <input
              id="dni"
              type="text"
              required
              value={form.dni}
              onChange={handleChange('dni')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="telefono" className="text-xs font-medium text-gray-400">
              Teléfono
            </label>
            <input
              id="telefono"
              type="tel"
              value={form.telefono}
              onChange={handleChange('telefono')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <label htmlFor="email" className="text-xs font-medium text-gray-400">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={form.email}
              onChange={handleChange('email')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-gray-400">Planes / Actividades</span>
            <div className="flex flex-wrap gap-2">
              {PLANES_DISPONIBLES.map((plan) => (
                <label
                  key={plan}
                  className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                    form.planes.includes(plan)
                      ? 'border-greenfit-primary bg-greenfit-primary/10 text-white'
                      : 'border-white/10 text-gray-300 hover:bg-white/5'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={form.planes.includes(plan)}
                    onChange={() => handleTogglePlan(plan)}
                    className="accent-greenfit-primary"
                  />
                  {plan}
                </label>
              ))}
            </div>
          </div>

          {!esEdicion && planesDeCreditos(form.planes).length > 0 && (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-xs font-medium text-gray-400">
                Créditos iniciales por actividad (opcional -- se puede cargar después con "Registrar Pago")
              </span>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {planesDeCreditos(form.planes).map((disciplina) => (
                  <div key={disciplina} className="flex flex-col gap-1.5">
                    <label htmlFor={`credito-${disciplina}`} className="text-xs text-gray-500">
                      {disciplina}
                    </label>
                    <input
                      id={`credito-${disciplina}`}
                      type="number"
                      min="0"
                      placeholder="0"
                      value={form.creditosPorDisciplina[disciplina] ?? ''}
                      onChange={handleChangeCredito(disciplina)}
                      className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {!esEdicion && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="fechaInicio" className="text-xs font-medium text-gray-400">
                Fecha de Inicio
              </label>
              <input
                id="fechaInicio"
                type="date"
                required
                value={form.fechaInicio}
                onChange={handleChange('fechaInicio')}
                className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
              />
            </div>
          )}

          {error && <p className="text-sm text-red-400 sm:col-span-2">{error}</p>}

          <div className="mt-2 flex flex-col-reverse gap-3 sm:col-span-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="flex min-h-[44px] items-center justify-center rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={guardando}
              className="flex min-h-[44px] items-center justify-center rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {guardando ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default NuevoSocioModal
