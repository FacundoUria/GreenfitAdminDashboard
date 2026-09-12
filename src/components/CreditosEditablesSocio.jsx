import { useEffect, useState } from 'react'
import { Loader2, Minus, Plus } from 'lucide-react'
import { formatFecha } from '../utils/fecha'
import { resolverUserIdPorDni, fetchCreditosPorDisciplina } from '../utils/fichaSocioPwa'
import { fijarCreditosDisciplina, ajustarCreditoDisciplina } from '../utils/creditosPwa'

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

  // Antes esto era un chequeo síncrono sobre socios.plan (se sabía sin
  // esperar ninguna respuesta de red) -- ahora "¿hay algo que mostrar?"
  // depende de la carga real, así que solo se puede decidir DESPUÉS de
  // que termine (mientras carga, se muestra igual el spinner de abajo).
  // Sin nada que mostrar, sin error Y sin ninguna disciplina para agregar,
  // la sección entera desaparece -- si hay algo para agregar, se muestra
  // igual (aunque `filas` esté vacío) para que "+ Agregar disciplina"
  // siga disponible en un socio sin nada activo todavía.
  if (!cargando && !error && filas.length === 0 && disciplinasDisponibles.length === 0) return null

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
        </div>
      )}
    </div>
  )
}

export default CreditosEditablesSocio
