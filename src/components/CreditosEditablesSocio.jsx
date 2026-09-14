import { useEffect, useState } from 'react'
import { Loader2, Minus, Pencil, Plus } from 'lucide-react'
import { formatFecha } from '../utils/fecha'
import { resolverUserIdPorDni, fetchCreditosPorDisciplina } from '../utils/fichaSocioPwa'
import {
  fijarCreditosDisciplina,
  ajustarCreditoDisciplina,
  agregarAparatosSocio,
  editarFechaVencimientoSocio,
} from '../utils/creditosPwa'

// CAMBIO 5 (re-agregar Aparatos) -- mismo criterio PLAN-INDEPENDIENTE que ya
// usan aparatosActivoReal() en SociosTabla.jsx y NuevoSocioModal.jsx
// (duplicado a propósito, mismo patrón que esos dos).
//
// BUG REAL (caso Arianna Isgro, DNI 51705419, fix aplicado a las 3 copias
// de esta función): ANTES esto comparaba `socio.fechaVencimiento` (mirror
// de socios.fecha_vencimiento) contra hoy -- un residuo (import de CrossFy,
// campo viejo ya eliminado) podía dejar esa fecha en el futuro SIN ninguna
// fila real de Aparatos detrás, y esta función decía "ya está vigente"
// justo cuando el botón de abajo ("+ Agregar Aparatos") era LO ÚNICO que
// podía corregirlo -- quedaba oculto, sin ninguna forma de arreglarlo desde
// acá. Ahora lee `socio.aparatosVigenteReal`, resuelto contra user_credits
// de verdad (fetchAparatosVigentePorDni, Socios.jsx).
// `aparatosVigenteReal` es TRI-ESTADO (ver fetchAparatosVigentePorDni en
// fichaSocioPwa.js) -- true | false | undefined: `false` es "tiene cuenta
// PWA confirmada, sin nada real" (gana sobre cualquier fecha_vencimiento
// fantasma, caso Agustina Aguero); `undefined` es "sin cuenta PWA, no hay
// ninguna fila posible" -- ahí sí se cae a fecha_vencimiento directa (caso
// real: Lucía Paz, cobrada 100% por mostrador, nunca se registró en la app).
function aparatosActivoReal(socio) {
  const vigente = socio?.aparatosVigenteReal
  if (vigente === true) return true
  if (vigente === false) return false
  if (!socio?.fechaVencimiento) return false
  return new Date(`${socio.fechaVencimiento}T00:00:00`).getTime() > Date.now()
}

// CAMBIO 3 ("editar la fecha del plan") -- bajo "plan único", Aparatos +
// todas las disciplinas de créditos vigentes de un socio comparten la MISMA
// fecha (`fila.proximoVencimiento`, ya resuelto por fetchCreditosPorDisciplina
// -- mismo dato que ya se ve en cada fila de crédito). Se toma la más
// lejana entre las fuentes reales vigentes -- deberían coincidir todas; si
// por algo raro no coincidieran, la más lejana es la que sigue vigente
// después. `null` = sin ningún plan activo (mismo criterio que el guard del
// RPC admin_editar_fecha_vencimiento_socio) -- ahí esta sección no se
// ofrece en absoluto, mismo criterio que "+ Agregar disciplina"/"+ Agregar
// Aparatos" ya usan para casos sin nada real.
function fechaPlanActual(socio, filas) {
  const candidatos = []
  if (aparatosActivoReal(socio) && socio.fechaVencimiento) candidatos.push(socio.fechaVencimiento)
  for (const fila of filas) {
    if (fila.proximoVencimiento) candidatos.push(fila.proximoVencimiento)
  }
  if (candidatos.length === 0) return null
  return candidatos.reduce((masLejana, actual) => (new Date(actual) > new Date(masLejana) ? actual : masLejana))
}

// "YYYY-MM-DD" para precargar el <input type="date"> -- mismo criterio de
// "un valor 'solo fecha' se interpreta en el huso horario local" que ya usa
// formatFecha() (evita el corrimiento de un día que da tratar un
// "YYYY-MM-DD" como medianoche UTC).
function aFechaInput(valor) {
  if (!valor) return ''
  const esSoloFecha = typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)
  const fecha = new Date(esSoloFecha ? `${valor}T00:00:00` : valor)
  if (Number.isNaN(fecha.getTime())) return ''
  const y = fecha.getFullYear()
  const m = String(fecha.getMonth() + 1).padStart(2, '0')
  const d = String(fecha.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Reemplaza a los steppers -/+1/+4/+8/+12 que vivían sueltos en cada fila
// de SociosTabla.jsx -- con datos sucios de la migración de CrossFy,
// corregir a alguien con muchos créditos de más obligaba a tocar "-1"
// decenas de veces. Acá, dentro de "Editar Socio": una fila por disciplina
// de créditos, con el TOTAL editable a mano (número exacto) + +1/-1 para
// el ajuste rápido de siempre. La fecha de vencimiento (la más próxima
// entre los lotes activos) es solo informativa en esta versión -- no
// editable acá.
//
// FIX (modelo de "plan único", caso real Facundo Uria DNI 44537978) --
// ANTES las filas venían de planesDeCreditos(socio.plan) (el checkbox de
// "Editar Socio"), resolviendo cada nombre contra el catálogo aparte. Eso
// tenía dos problemas bajo el modelo nuevo: (1) una disciplina con
// créditos reales y vigentes pero SIN tildar en el plan (comprada por
// pack, nunca tildada a mano -- caso Kickstrike) no aparecía; (2) una
// disciplina tildada pero sin nada vigente (residuo viejo -- caso Boxeo)
// sí aparecía, con 0. Ahora las filas salen DIRECTO de
// fetchCreditosPorDisciplina() (ya filtra a "tiene al menos un lote
// activo", ver fichaSocioPwa.js) -- el `disciplineId` de cada fila ya
// viene resuelto real desde ahí (el join contra user_credits), así que ya
// no hace falta resolverDisciplinaId() por nombre acá tampoco.
//
// "+ Agregar disciplina" -- ANTES esta sección solo podía AJUSTAR lo que
// ya existía: para darle a un socio créditos de una disciplina sin ningún
// lote activo todavía (su primera vez ahí) había que pasar sí o sí por
// "Registrar Pago". Ahora `disciplinasActivas` (catálogo real, kind=
// 'credits') menos las que ya están en `filas` da el combo de disciplinas
// "agregables" -- elegir una y poner una cantidad llama al MISMO
// fijarCreditosDisciplina() de siempre (admin_fijar_creditos_disciplina),
// sin ningún cambio de RPC: esa función ya resuelve sola la fecha
// correcta (la del plan vigente del socio si tiene algo activo, o
// now()+30 días si no tiene nada), así que la disciplina nueva queda
// automáticamente con la MISMA fecha que el resto sin que este componente
// tenga que calcular ni pasar nada de fechas.
function CreditosEditablesSocio({ socio, disciplinasActivas = [], onCreditosActualizados }) {
  const [userId, setUserId] = useState(null)
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  // Texto que el admin está escribiendo en el input, por disciplineId --
  // separado del valor real (`fila.remainingCredits`) para no pisar lo que
  // está tipeando mientras cargar() todavía no confirmó el guardado.
  const [valores, setValores] = useState({})
  // Disciplina en vuelo -- deshabilita SOLO esa fila, no el resto. Clave
  // por `fila.disciplina` (nombre, siempre truthy) y NO por
  // `fila.disciplineId`: aunque hoy todo `disciplineId` viene resuelto
  // real (ver más abajo), usar el nombre es más robusto igual -- no
  // depende de que ese invariante se mantenga para siempre.
  const [procesando, setProcesando] = useState(null)

  // Contador que se bumpea después de guardar/ajustar para volver a pedir
  // los datos -- mismo criterio que FichaSocioHistorial.jsx: `cargar()`
  // vive DENTRO del efecto (no como una función de component-scope que el
  // efecto llama) para que el efecto "sincronice con el sistema externo"
  // en vez de ejecutar un setState directo en su cuerpo. `cancelado` evita
  // pisar el estado si el socio cambia (o el modal se cierra) a mitad de
  // una carga en vuelo.
  const [refrescarTick, setRefrescarTick] = useState(0)

  // "+ Agregar disciplina" -- estado del mini-form inline, separado del de
  // las filas existentes (valores/procesando) para no pisarse entre sí.
  const [agregando, setAgregando] = useState(false)
  const [disciplinaNuevaId, setDisciplinaNuevaId] = useState('')
  const [cantidadNueva, setCantidadNueva] = useState('')
  const [guardandoNueva, setGuardandoNueva] = useState(false)

  // "+ Agregar Aparatos" (CAMBIO 5) -- `aparatosAgregado` es un flag LOCAL
  // que evita mostrar el botón de nuevo en la misma sesión del modal ANTES
  // de que termine el refetch real: `onCreditosActualizados` (Socios.jsx,
  // refrescarCreditosPwa) sí vuelve a pedir aparatosVigenteReal (ver
  // fetchAparatosVigentePorDni), pero eso es async y el `socio` que este
  // componente recibe por prop no se actualiza hasta que el padre
  // re-renderice con el resultado -- este flag cubre ese instante.
  const [aparatosAgregado, setAparatosAgregado] = useState(false)
  const [guardandoAparatos, setGuardandoAparatos] = useState(false)
  const aparatosVigente = aparatosActivoReal(socio) || aparatosAgregado
  // Sin cuenta PWA resuelta (userId null -- ej. socio sin DNI cargado, ver
  // creditos-sin-dni.spec.js), "+ Agregar Aparatos" está destinado a fallar
  // siempre (mismo alert que el resto de esta sección) -- mismo criterio de
  // "ausencia de UI en vez de alert en runtime" que ya rige acá: se puede
  // agregar Aparatos solo si hay un userId real sobre el que hacerlo.
  const puedeAgregarAparatos = !aparatosVigente && !!userId

  // "Vencimiento del plan" (CAMBIO 3) -- estado del editor inline, mismo
  // patrón que "+ Agregar disciplina" (abrir/cancelar/guardar separado del
  // resto).
  const [editandoFecha, setEditandoFecha] = useState(false)
  const [nuevaFechaPlan, setNuevaFechaPlan] = useState('')
  const [guardandoFecha, setGuardandoFecha] = useState(false)

  useEffect(() => {
    let cancelado = false

    async function cargar() {
      setCargando(true)
      setError(null)
      try {
        const [idResuelto, mapaCreditos] = await Promise.all([
          resolverUserIdPorDni(socio.dni),
          fetchCreditosPorDisciplina([socio.dni]),
        ])
        if (cancelado) return
        setUserId(idResuelto)

        // Las filas salen DIRECTO de lo que fetchCreditosPorDisciplina ya
        // trae -- esa función filtra a "tiene al menos un lote activo" (ver
        // fichaSocioPwa.js), y el disciplineId de cada entrada ya es el
        // real (viene del join contra user_credits, no de resolver un
        // nombre de plan contra el catálogo).
        const entradas = mapaCreditos.get(socio.dni) ?? []
        const nuevasFilas = entradas.map((entrada) => ({
          disciplina: entrada.disciplineName,
          disciplineId: entrada.disciplineId,
          remainingCredits: entrada.remainingCredits,
          proximoVencimiento: entrada.lotes?.[0]?.expiresAt ?? null,
        }))
        setFilas(nuevasFilas)
        setValores(Object.fromEntries(nuevasFilas.map((f) => [f.disciplineId, String(f.remainingCredits)])))
      } catch (err) {
        if (cancelado) return
        setError(err instanceof Error ? err.message : 'No se pudieron cargar los créditos.')
      } finally {
        if (!cancelado) setCargando(false)
      }
    }

    cargar()
    return () => {
      cancelado = true
    }
  }, [socio.dni, refrescarTick])

  const handleChangeValor = (disciplineId) => (event) => {
    setValores((prev) => ({ ...prev, [disciplineId]: event.target.value }))
  }

  const handleGuardar = async (fila) => {
    if (!fila.disciplineId) {
      window.alert(`No se encontró "${fila.disciplina}" en el catálogo de Disciplinas -- revisalo en Configuración.`)
      return
    }
    if (!userId) {
      window.alert('Este socio todavía no tiene cuenta en la app -- no se pueden editar créditos acá todavía.')
      return
    }

    const texto = (valores[fila.disciplineId] ?? '').trim()
    const nuevoValor = Number(texto)
    if (texto === '' || !Number.isInteger(nuevoValor) || nuevoValor < 0) {
      window.alert('Ingresá un número entero mayor o igual a 0.')
      return
    }
    if (nuevoValor === fila.remainingCredits) return // nada que confirmar

    const confirmado = window.confirm(`¿Confirmás modificar los créditos de ${fila.disciplina} a ${nuevoValor}?`)
    if (!confirmado) return

    setProcesando(fila.disciplina)
    try {
      await fijarCreditosDisciplina(userId, fila.disciplineId, nuevoValor)
      setRefrescarTick((t) => t + 1)
      onCreditosActualizados?.()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'No se pudieron actualizar los créditos.')
    } finally {
      setProcesando(null)
    }
  }

  const handleAjustar = async (fila, delta) => {
    if (!fila.disciplineId) {
      window.alert(`No se encontró "${fila.disciplina}" en el catálogo de Disciplinas -- revisalo en Configuración.`)
      return
    }
    if (!userId) {
      window.alert('Este socio todavía no tiene cuenta en la app -- no se pueden editar créditos acá todavía.')
      return
    }

    setProcesando(fila.disciplina)
    try {
      await ajustarCreditoDisciplina(userId, fila.disciplineId, delta)
      setRefrescarTick((t) => t + 1)
      onCreditosActualizados?.()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'No se pudo ajustar el crédito.')
    } finally {
      setProcesando(null)
    }
  }

  // Disciplinas de créditos del catálogo real que el socio NO tiene activas
  // hoy -- las candidatas para "+ Agregar disciplina". Las que ya están en
  // `filas` quedan afuera a propósito: para esas ya existe "Fijar en" (no
  // tiene sentido duplicar el mismo flujo dos veces en la misma sección).
  const disciplinasDisponibles = disciplinasActivas.filter(
    (d) => d.kind === 'credits' && !filas.some((f) => f.disciplineId === d.id),
  )

  const handleAgregarDisciplina = async () => {
    if (!disciplinaNuevaId) return
    if (!userId) {
      window.alert('Este socio todavía no tiene cuenta en la app -- no se pueden editar créditos acá todavía.')
      return
    }

    const texto = cantidadNueva.trim()
    const cantidad = Number(texto)
    if (texto === '' || !Number.isInteger(cantidad) || cantidad <= 0) {
      window.alert('Ingresá un número entero mayor a 0.')
      return
    }

    setGuardandoNueva(true)
    try {
      // Mismo RPC de siempre (admin_fijar_creditos_disciplina) -- ya
      // resuelve sola la fecha del plan vigente del socio (o now()+30 días
      // si no tiene nada activo todavía), sin que haga falta pasarle ni
      // calcular ninguna fecha acá.
      await fijarCreditosDisciplina(userId, disciplinaNuevaId, cantidad)
      setRefrescarTick((t) => t + 1)
      onCreditosActualizados?.()
      setAgregando(false)
      setDisciplinaNuevaId('')
      setCantidadNueva('')
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'No se pudo agregar la disciplina.')
    } finally {
      setGuardandoNueva(false)
    }
  }

  const handleAgregarAparatos = async () => {
    if (!userId) {
      window.alert('Este socio todavía no tiene cuenta en la app -- no se pueden editar créditos acá todavía.')
      return
    }
    const confirmado = window.confirm(`¿Confirmás agregarle Aparatos a ${socio.nombre} ${socio.apellido}?`)
    if (!confirmado) return

    setGuardandoAparatos(true)
    try {
      // Mismo RPC-chico-y-separado de siempre (admin_agregar_aparatos_socio)
      // -- resuelve sola la fecha (la del plan vigente del socio, o
      // now()+30 días si no tiene nada activo todavía), sin que este
      // componente tenga que calcular ni pasar ninguna fecha.
      await agregarAparatosSocio(userId)
      setAparatosAgregado(true)
      onCreditosActualizados?.()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'No se pudo agregar Aparatos.')
    } finally {
      setGuardandoAparatos(false)
    }
  }

  const handleAbrirEditorFecha = (fechaActual) => {
    setNuevaFechaPlan(aFechaInput(fechaActual))
    setEditandoFecha(true)
  }

  const handleGuardarFecha = async () => {
    if (!userId) {
      window.alert('Este socio todavía no tiene cuenta en la app -- no se puede editar la fecha acá todavía.')
      return
    }
    if (!nuevaFechaPlan) {
      window.alert('Elegí una fecha.')
      return
    }

    const confirmado = window.confirm(
      `¿Confirmás cambiar el vencimiento de TODO el plan de ${socio.nombre} ${socio.apellido} a ${formatFecha(nuevaFechaPlan)}? Esto afecta a todas sus disciplinas activas por igual.`,
    )
    if (!confirmado) return

    setGuardandoFecha(true)
    try {
      // admin_editar_fecha_vencimiento_socio -- RPC chico y separado, NO
      // toca remaining_credits de ninguna disciplina, solo mueve expires_at
      // de las filas ya activas. No reemplaza a "Cobrar": si el socio no
      // tiene nada activo, esta sección ni siquiera se ofrece (ver
      // fechaPlanActual/tienePlanActivo más abajo).
      await editarFechaVencimientoSocio(userId, nuevaFechaPlan)
      setEditandoFecha(false)
      setRefrescarTick((t) => t + 1)
      onCreditosActualizados?.()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'No se pudo editar la fecha del plan.')
    } finally {
      setGuardandoFecha(false)
    }
  }

  // CAMBIO 3 -- fecha única del plan (null = sin nada activo). Se calcula
  // acá, no dentro del guard de abajo, porque también decide si mostrar
  // "Vencimiento del plan" en absoluto.
  const fechaPlan = fechaPlanActual(socio, filas)
  const tienePlanActivo = fechaPlan !== null

  // Antes esto era un chequeo síncrono sobre socios.plan (se sabía sin
  // esperar ninguna respuesta de red) -- ahora "¿hay algo que mostrar?"
  // depende de la carga real, así que solo se puede decidir DESPUÉS de
  // que termine (mientras carga, se muestra igual el spinner de abajo).
  // Sin nada que mostrar, sin error, sin ninguna disciplina para agregar,
  // sin poder agregar Aparatos (ya vigente, o sin userId real) Y sin ningún
  // plan activo que editar la fecha, la sección entera desaparece -- si hay
  // algo para agregar/editar, se muestra igual (aunque `filas` esté vacío)
  // para que esos botones sigan disponibles en un socio sin nada activo
  // todavía.
  if (
    !cargando &&
    !error &&
    filas.length === 0 &&
    disciplinasDisponibles.length === 0 &&
    !puedeAgregarAparatos &&
    !tienePlanActivo
  )
    return null

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-greenfit-dark/40 p-4 sm:col-span-2">
      <h3 className="text-sm font-semibold text-white">Créditos</h3>

      {cargando ? (
        <div className="flex items-center gap-2 py-2 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando créditos...
        </div>
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* CAMBIO 3 -- "Vencimiento del plan": SOLO si el socio tiene algo
              activo (mismo criterio que "+ Agregar disciplina"/"+ Agregar
              Aparatos" ya usan para ausencia de UI). Editar acá mueve la
              fecha de TODAS las disciplinas activas a la vez -- no
              reemplaza a "Cobrar" (que además ajusta cantidades). */}
          {tienePlanActivo &&
            (editandoFecha ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-white/15 bg-greenfit-card px-3 py-2.5">
                <span className="text-sm text-gray-300">Nuevo vencimiento:</span>
                <input
                  type="date"
                  value={nuevaFechaPlan}
                  onChange={(e) => setNuevaFechaPlan(e.target.value)}
                  disabled={guardandoFecha}
                  aria-label="Nueva fecha de vencimiento del plan"
                  className="rounded-md border border-white/10 bg-greenfit-dark px-2 py-1.5 text-sm text-white outline-none focus:border-greenfit-primary disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={handleGuardarFecha}
                  disabled={guardandoFecha || !nuevaFechaPlan}
                  className="flex h-9 shrink-0 items-center justify-center rounded-md bg-greenfit-primary/15 px-3 text-xs font-semibold text-greenfit-primary transition-colors hover:bg-greenfit-primary/25 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {/* "Guardar fecha", no "Guardar" a secas -- con filas de
                      crédito visibles a la vez, cada una ya tiene su propio
                      botón "Guardar" (fijar cantidad); un texto distinto
                      evita la ambigüedad tanto para el admin como para
                      cualquier query por texto/rol. */}
                  {guardandoFecha ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Guardar fecha'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditandoFecha(false)}
                  disabled={guardandoFecha}
                  className="text-xs font-medium text-gray-400 underline transition-colors hover:text-white disabled:opacity-50"
                >
                  Cancelar
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/5 bg-greenfit-card px-3 py-2.5">
                <p className="text-sm text-gray-300">
                  {/* Dos <span> separados (no texto+span inline) -- para que
                      getByText en los tests pueda matchear cada uno por
                      separado sin que el textContent combinado del <p>
                      (que SÍ incluye el de sus hijos) ambigüe la búsqueda. */}
                  <span>Vencimiento del plan:</span> <span className="font-semibold text-white">{formatFecha(fechaPlan)}</span>
                </p>
                <button
                  type="button"
                  title="Editar vencimiento del plan"
                  aria-label="Editar vencimiento del plan"
                  onClick={() => handleAbrirEditorFecha(fechaPlan)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

          {filas.map((fila) => {
            const enVuelo = procesando === fila.disciplina
            return (
              <div
                key={fila.disciplina}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-greenfit-card px-3 py-2.5"
              >
                <div className="min-w-[110px] flex-1">
                  <p className="text-sm font-medium text-white">{fila.disciplina}</p>
                  <p className="text-[11px] text-gray-500">
                    {fila.proximoVencimiento ? `Vence el ${formatFecha(fila.proximoVencimiento)}` : 'Sin lotes activos'}
                  </p>
                </div>

                <button
                  type="button"
                  title={`Restar 1 crédito de ${fila.disciplina}`}
                  onClick={() => handleAjustar(fila, -1)}
                  disabled={enVuelo}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/10 text-gray-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>

                <input
                  type="number"
                  min="0"
                  step="1"
                  value={valores[fila.disciplineId] ?? ''}
                  onChange={handleChangeValor(fila.disciplineId)}
                  disabled={enVuelo}
                  aria-label={`Créditos de ${fila.disciplina}`}
                  className="w-16 rounded-md border border-white/10 bg-greenfit-dark px-2 py-1.5 text-center text-sm text-white outline-none focus:border-greenfit-primary disabled:opacity-50"
                />

                <button
                  type="button"
                  title={`Sumar 1 crédito a ${fila.disciplina}`}
                  onClick={() => handleAjustar(fila, 1)}
                  disabled={enVuelo}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/10 text-gray-300 transition-colors hover:bg-white/10 hover:text-greenfit-primary disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>

                <button
                  type="button"
                  onClick={() => handleGuardar(fila)}
                  disabled={enVuelo || Number(valores[fila.disciplineId]) === fila.remainingCredits}
                  className="flex h-9 shrink-0 items-center justify-center rounded-md bg-greenfit-primary/15 px-3 text-xs font-semibold text-greenfit-primary transition-colors hover:bg-greenfit-primary/25 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {enVuelo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Guardar'}
                </button>
              </div>
            )
          })}

          {disciplinasDisponibles.length > 0 &&
            (agregando ? (
              // <div>, no <form> -- este componente vive DENTRO del <form>
              // de todo el modal de "Editar Socio" (NuevoSocioModal.jsx) --
              // un <form> anidado ahí adentro es HTML inválido (el submit
              // del botón termina sin comportamiento predecible). El botón
              // de abajo llama a handleAgregarDisciplina() directo por
              // onClick, no por onSubmit.
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-white/15 bg-greenfit-card px-3 py-2.5">
                <select
                  value={disciplinaNuevaId}
                  onChange={(e) => setDisciplinaNuevaId(e.target.value)}
                  disabled={guardandoNueva}
                  aria-label="Disciplina a agregar"
                  className="min-w-[140px] flex-1 rounded-md border border-white/10 bg-greenfit-dark px-2 py-1.5 text-sm text-white outline-none focus:border-greenfit-primary disabled:opacity-50"
                >
                  <option value="">Elegí una disciplina...</option>
                  {disciplinasDisponibles.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>

                <input
                  type="number"
                  min="1"
                  step="1"
                  placeholder="Créditos"
                  value={cantidadNueva}
                  onChange={(e) => setCantidadNueva(e.target.value)}
                  disabled={guardandoNueva}
                  aria-label="Créditos a agregar"
                  className="w-20 rounded-md border border-white/10 bg-greenfit-dark px-2 py-1.5 text-center text-sm text-white outline-none focus:border-greenfit-primary disabled:opacity-50"
                />

                <button
                  type="button"
                  onClick={handleAgregarDisciplina}
                  disabled={guardandoNueva || !disciplinaNuevaId}
                  className="flex h-9 shrink-0 items-center justify-center rounded-md bg-greenfit-primary/15 px-3 text-xs font-semibold text-greenfit-primary transition-colors hover:bg-greenfit-primary/25 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {guardandoNueva ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Agregar'}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setAgregando(false)
                    setDisciplinaNuevaId('')
                    setCantidadNueva('')
                  }}
                  disabled={guardandoNueva}
                  className="text-xs font-medium text-gray-400 underline transition-colors hover:text-white disabled:opacity-50"
                >
                  Cancelar
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAgregando(true)}
                className="flex h-9 items-center justify-center gap-1.5 self-start rounded-md border border-dashed border-white/20 px-3 text-xs font-semibold text-gray-300 transition-colors hover:border-greenfit-primary hover:text-greenfit-primary"
              >
                <Plus className="h-3.5 w-3.5" />
                Agregar disciplina
              </button>
            ))}

          {/* CAMBIO 5 -- sin cantidad, solo confirmar (Aparatos no tiene
              créditos que contar). Visible SOLO si Aparatos no está vigente
              hoy (si ya lo está, no hay nada que "agregar" -- para cambiarle
              la fecha existe "Registrar Pago"/"Cobrar", no este atajo) Y hay
              un userId real resuelto (sin cuenta PWA, el botón siempre
              fallaría -- mismo criterio de "ausencia de UI" que el resto). */}
          {puedeAgregarAparatos && (
            <button
              type="button"
              onClick={handleAgregarAparatos}
              disabled={guardandoAparatos}
              className="flex h-9 items-center justify-center gap-1.5 self-start rounded-md border border-dashed border-white/20 px-3 text-xs font-semibold text-gray-300 transition-colors hover:border-greenfit-primary hover:text-greenfit-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {guardandoAparatos ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Agregar Aparatos
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default CreditosEditablesSocio
