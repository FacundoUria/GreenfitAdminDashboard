import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { hoyISO, proximoVencimiento, toISODate } from '../utils/fecha'
import {
  PLANES_DISPONIBLES,
  normalizarPlanes,
  planesDeCreditos,
  planesDeVencimiento,
  tienePlanDeVencimiento,
} from '../utils/planes'
import { sincronizarCreditosPwa, sincronizarVencimientoPwa, sincronizarVencimientoCreditoPwa } from '../utils/creditosPwa'
import { normalizarTexto } from '../utils/coincidenciaSocios'
import FichaSocioHistorial from './FichaSocioHistorial'

// BUG CRÍTICO (2026-08-07): esta función arrancaba `planes` con
// `[PLANES_DISPONIBLES[0]]` ('Pase Libre') YA TILDADO -- si el staff cargaba
// un socio de Kickstrike/CrossFit sin darse cuenta de tocar/destildar ese
// checkbox pre-marcado, el socio quedaba guardado con `plan: ['Pase Libre',
// 'Kickstrike']`. Como 'Pase Libre' no tiene fila propia en `disciplines`
// (es una etiqueta legado, ver planesDeVencimiento() en utils/planes.js),
// cualquier sincronización de vencimiento para ese plan cae al fallback de
// "la única disciplina kind=membership que exista" -- hoy, Aparatos -- y el
// socio termina con un balance de Aparatos en la PWA que nunca pidió. Fix:
// arrancar SIEMPRE sin nada tildado, así el staff elige a mano cada
// actividad real y no queda ningún plan "de regalo" sin querer.
function formInicial(socio) {
  if (socio) {
    return {
      nombre: socio.nombre ?? '',
      apellido: socio.apellido ?? '',
      dni: socio.dni ?? '',
      email: socio.email ?? '',
      telefono: socio.telefono ?? '',
      planes: normalizarPlanes(socio.plan),
      fechaInicio: hoyISO(),
      // Edición directa del vencimiento -- no depende de pasar por
      // "Registrar Pago". Vacío si el socio no tiene fecha cargada todavía.
      fechaVencimiento: socio.fechaVencimiento ?? '',
      creditosPorDisciplina: {},
    }
  }

  return {
    nombre: '',
    apellido: '',
    dni: '',
    email: '',
    telefono: '',
    planes: [],
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

function NuevoSocioModal({
  socio,
  onClose,
  onSaved,
  onBuscarSocioPorDni,
  onEditarSocioExistente,
  onBuscarSocioPorNombre,
}) {
  const esEdicion = Boolean(socio)
  const [form, setForm] = useState(() => formInicial(socio))
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  const [socioDuplicado, setSocioDuplicado] = useState(null)
  // Coincidencia por nombre (posible duplicado sin DNI, registro viejo, etc.)
  // -- distinta del DNI duplicado: acá no hay certeza, es una sospecha que el
  // admin tiene que confirmar o descartar.
  const [coincidenciaNombre, setCoincidenciaNombre] = useState(null)
  const [nombreDescartado, setNombreDescartado] = useState(null)
  const [socioAUnificar, setSocioAUnificar] = useState(null)

  const handleChange = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }))
  }

  // Chequeo en vivo mientras se escribe nombre/apellido -- solo tiene sentido
  // en un alta nueva (no al editar una ficha ya existente ni mientras se está
  // en medio de una unificación ya elegida).
  useEffect(() => {
    if (esEdicion || socioAUnificar || !onBuscarSocioPorNombre) return
    // El propio setTimeout es lo que hace la actualización "asíncrona" a
    // ojos del linter -- evita que las llamadas a setState queden colgando
    // directamente del cuerpo del efecto.
    const timeoutId = setTimeout(() => {
      const clave = normalizarTexto(`${form.nombre} ${form.apellido}`)
      if (clave.length < 5 || clave === nombreDescartado) {
        setCoincidenciaNombre(null)
        return
      }
      setCoincidenciaNombre(onBuscarSocioPorNombre(form.nombre, form.apellido) ?? null)
    }, 500)
    return () => clearTimeout(timeoutId)
  }, [form.nombre, form.apellido, esEdicion, socioAUnificar, nombreDescartado, onBuscarSocioPorNombre])

  const handleUnificar = () => {
    if (!coincidenciaNombre) return
    // Completa los huecos del formulario con lo que ya tenía la ficha vieja,
    // pero sin pisar lo que el admin ya tipeó (DNI, plan, etc. son los datos
    // nuevos que justamente se están integrando).
    setForm((prev) => ({
      ...prev,
      telefono: prev.telefono || coincidenciaNombre.telefono || '',
      email: prev.email || coincidenciaNombre.email || '',
    }))
    setSocioAUnificar(coincidenciaNombre)
    setCoincidenciaNombre(null)
  }

  const handleIgnorarCoincidencia = () => {
    setNombreDescartado(normalizarTexto(`${form.nombre} ${form.apellido}`))
    setCoincidenciaNombre(null)
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

    // Red de seguridad si el aviso en vivo todavía no llegó a dispararse
    // (ej: pegar el nombre y guardar enseguida) -- no dejamos pasar el alta
    // sin que el admin vea la coincidencia y elija qué hacer.
    if (!esEdicion && !socioAUnificar && onBuscarSocioPorNombre) {
      const clave = normalizarTexto(`${form.nombre} ${form.apellido}`)
      if (clave !== nombreDescartado) {
        const posibleMatch = onBuscarSocioPorNombre(form.nombre, form.apellido)
        if (posibleMatch) {
          setCoincidenciaNombre(posibleMatch)
          return
        }
      }
    }

    setGuardando(true)
    setError(null)
    setSocioDuplicado(null)

    let resultado
    let fechaVencimientoNueva = null
    // Edición directa del vencimiento -- el admin puede tocar la fecha sin
    // pasar por "Registrar Pago". `dia_corte` se recalcula del día-del-mes
    // de la fecha nueva para que un futuro pago en modo "sugerido" (+1 mes)
    // siga anclado a lo último que se cargó a mano acá.
    // Bug reportado: antes solo se detectaba una edición de vencimiento si
    // había algún plan de Aparatos/Pase Libre tildado -- un socio de
    // CrossFit/Boxeo puro nunca podía cargar/renovar su vencimiento acá.
    const vencimientoEditado =
      esEdicion && form.planes.length > 0 && !!form.fechaVencimiento && form.fechaVencimiento !== (socio?.fechaVencimiento ?? '')

    if (esEdicion) {
      const cambios = {
        nombre: form.nombre,
        apellido: form.apellido,
        dni: form.dni,
        email: form.email,
        telefono: form.telefono,
        plan: form.planes,
      }
      if (vencimientoEditado) {
        cambios.fecha_vencimiento = form.fechaVencimiento
        cambios.dia_corte = new Date(`${form.fechaVencimiento}T00:00:00`).getDate()
      }
      resultado = await supabase.from('socios').update(cambios).eq('id', socio.id).select()
    } else {
      const fechaInicio = form.fechaInicio || hoyISO()
      // El día de alta fija el "día de corte" del ciclo de cobro del socio para siempre.
      const diaCorte = new Date(`${fechaInicio}T00:00:00`).getDate()
      fechaVencimientoNueva = toISODate(proximoVencimiento(fechaInicio, diaCorte))

      if (socioAUnificar) {
        // Unificación: la ficha vieja (a veces sin DNI, de un alta manual
        // incompleta) absorbe los datos nuevos en vez de crear un registro
        // aparte -- mismo id, pero con DNI/plan/estado actualizados.
        resultado = await supabase
          .from('socios')
          .update({
            nombre: form.nombre,
            apellido: form.apellido,
            dni: form.dni,
            email: form.email,
            telefono: form.telefono,
            plan: form.planes,
            estado: 'Activo',
            activo: true,
            ultimo_pago: fechaInicio,
            dia_corte: diaCorte,
            fecha_vencimiento: fechaVencimientoNueva,
          })
          .eq('id', socioAUnificar.id)
          .select()
      } else {
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
    }

    // Un UPDATE bloqueado por RLS puede volver sin `error` pero sin filas afectadas.
    if (resultado.error || !resultado.data || resultado.data.length === 0) {
      console.error(
        `Error al ${esEdicion || socioAUnificar ? 'actualizar' : 'crear'} el socio en Supabase:`,
        resultado.error?.message ?? 'no se guardó ninguna fila (revisá las políticas RLS)',
      )
      // `dni` es UNIQUE en la tabla -- en vez de un error genérico, buscamos
      // al socio que ya tiene ese DNI para que se pueda ir directo a su
      // ficha en lugar de tener que buscarlo a mano en la tabla.
      const detalle = resultado.error?.message ?? ''
      const existente = detalle.includes('socios_dni_key') ? onBuscarSocioPorDni?.(form.dni) : null
      if (existente) {
        setSocioDuplicado(existente)
      } else if (resultado.error?.code === '23505') {
        setError(`Ya existe un socio registrado con el DNI ${form.dni}.`)
      } else {
        setError(`No se pudo ${esEdicion ? 'actualizar' : 'guardar'} el socio. Intentá nuevamente.`)
      }
      setGuardando(false)
      return
    }

    // Alta nueva: además de la tabla legacy `socios`, cargamos los créditos
    // por disciplina y/o el vencimiento de Aparatos en la tabla
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
            const resultadoSync = await sincronizarCreditosPwa({ dni: form.dni, email: form.email, disciplina, delta: cantidad })
            if (!resultadoSync.synced) avisos.push(`No se pudieron cargar los créditos de ${disciplina} en la app.`)
          }

          if (necesitaVencimiento) {
            for (const disciplina of planesDeVencimiento(form.planes)) {
              const resultadoSync = await sincronizarVencimientoPwa({
                dni: form.dni,
                email: form.email,
                disciplina,
                fechaVencimiento: fechaVencimientoNueva,
              })
              if (!resultadoSync.synced) {
                avisos.push(`No se pudo cargar el vencimiento de ${disciplina} en la app.`)
              }
            }
          }
        }
      }

      if (avisos.length > 0) window.alert(avisos.join('\n'))
    }

    // Edición de un socio ya existente: si se tocó la fecha de vencimiento,
    // se sincroniza con la PWA -- sin esto, el cambio quedaría reflejado
    // solo acá en el panel y la app seguiría mostrando la fecha vieja hasta
    // el próximo "Registrar Pago" (exactamente el desfase que se pidió cerrar).
    if (esEdicion && vencimientoEditado) {
      const avisos = []
      for (const disciplina of planesDeVencimiento(form.planes)) {
        const resultadoSync = await sincronizarVencimientoPwa({
          dni: form.dni,
          email: form.email,
          disciplina,
          fechaVencimiento: form.fechaVencimiento,
        })
        if (!resultadoSync.synced && resultadoSync.reason !== 'sin_cuenta_pwa') {
          avisos.push(`No se pudo sincronizar el vencimiento de ${disciplina} con la app.`)
        }
      }
      // Bug reportado: el calendario de vencimiento ya no está atado
      // exclusivamente a Aparatos -- si el socio también tiene (o solo
      // tiene) disciplinas de CRÉDITOS, la fecha también se sincroniza ahí,
      // preservando el balance real de créditos (sincronizarVencimientoCreditoPwa
      // no pisa remaining_credits con null como sí hace la de arriba, que es
      // correcta para membresías pero no para créditos).
      for (const disciplina of planesDeCreditos(form.planes)) {
        const resultadoSync = await sincronizarVencimientoCreditoPwa({
          dni: form.dni,
          email: form.email,
          disciplina,
          fechaVencimiento: form.fechaVencimiento,
        })
        if (!resultadoSync.synced && resultadoSync.reason !== 'sin_cuenta_pwa') {
          avisos.push(`No se pudo sincronizar el vencimiento de ${disciplina} con la app.`)
        }
      }
      if (avisos.length > 0) window.alert(avisos.join('\n'))
    }

    setGuardando(false)
    onSaved(socioAUnificar ? '¡Usuario unificado con éxito!' : vencimientoEditado ? 'Vencimiento actualizado' : undefined)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div
        className={`mx-auto my-6 w-full rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6 ${
          esEdicion ? 'max-w-3xl' : 'max-w-lg'
        }`}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">
            {esEdicion ? 'Editar Socio' : socioAUnificar ? 'Unificar Socio' : 'Nuevo Socio'}
          </h2>
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

          {esEdicion && form.planes.length > 0 && (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <label htmlFor="fechaVencimientoEdicion" className="text-xs font-medium text-gray-400">
                Fecha de vencimiento
              </label>
              <input
                id="fechaVencimientoEdicion"
                type="date"
                value={form.fechaVencimiento}
                onChange={handleChange('fechaVencimiento')}
                className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
              />
              <p className="text-[11px] text-gray-500">
                Edición directa, independiente de "Registrar Pago" -- guardar acá actualiza la fecha ya y la
                sincroniza con la app del socio.
              </p>
            </div>
          )}

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

          {socioDuplicado && (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300 sm:col-span-2">
              <p>
                El DNI {form.dni} ya pertenece a{' '}
                <strong>
                  {socioDuplicado.nombre} {socioDuplicado.apellido}
                </strong>
                .
              </p>
              <button
                type="button"
                onClick={() => onEditarSocioExistente?.(socioDuplicado)}
                className="self-start rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-500/15"
              >
                Editar este socio
              </button>
            </div>
          )}

          {coincidenciaNombre && (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300 sm:col-span-2">
              <p>
                ⚠️ Encontramos un socio existente registrado como{' '}
                <strong>
                  "{coincidenciaNombre.nombre} {coincidenciaNombre.apellido}"
                </strong>{' '}
                (Email: {coincidenciaNombre.email || 'sin email'} | DNI: {coincidenciaNombre.dni || 'Sin DNI'}).
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleUnificar}
                  className="rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-500/15"
                >
                  Unificar e integrar a esta ficha
                </button>
                <button
                  type="button"
                  onClick={handleIgnorarCoincidencia}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:bg-white/5"
                >
                  Crear como socio nuevo
                </button>
              </div>
            </div>
          )}

          {socioAUnificar && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-greenfit-primary/30 bg-greenfit-primary/10 p-3 text-sm text-greenfit-primary sm:col-span-2">
              <span>
                Vas a unificar estos datos con la ficha existente de{' '}
                <strong>
                  {socioAUnificar.nombre} {socioAUnificar.apellido}
                </strong>
                .
              </span>
              <button
                type="button"
                onClick={() => setSocioAUnificar(null)}
                className="text-xs font-medium text-gray-300 underline transition-colors hover:text-white"
              >
                Cancelar
              </button>
            </div>
          )}

          {esEdicion && <FichaSocioHistorial socio={socio} />}

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
              {guardando ? 'Guardando...' : socioAUnificar ? 'Unificar' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default NuevoSocioModal
