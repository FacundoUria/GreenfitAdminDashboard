import { useEffect, useState } from 'react'
import { Loader2, Minus, Plus } from 'lucide-react'
import { planesDeCreditos } from '../utils/planes'
import { formatFecha } from '../utils/fecha'
import { resolverUserIdPorDni, fetchCreditosPorDisciplina } from '../utils/fichaSocioPwa'
import { resolverDisciplinaId, fijarCreditosDisciplina, ajustarCreditoDisciplina } from '../utils/creditosPwa'

// Reemplaza a los steppers -/+1/+4/+8/+12 que vivían sueltos en cada fila
// de SociosTabla.jsx -- con datos sucios de la migración de CrossFy,
// corregir a alguien con muchos créditos de más obligaba a tocar "-1"
// decenas de veces. Acá, dentro de "Editar Socio": una fila por disciplina
// de créditos del plan, con el TOTAL editable a mano (número exacto) +
// +1/-1 para el ajuste rápido de siempre. La fecha de vencimiento
// (la más próxima entre los lotes activos) es solo informativa en esta
// versión -- no editable acá.
//
// A diferencia del resto de creditosPwa.js (que resuelve todo por DNI/
// nombre de disciplina, con fallbacks para datos sucios), acá se resuelve
// UNA vez al cargar y se reusa -- no hay ningún flujo batch de por medio,
// es una sola ficha a la vez.
function CreditosEditablesSocio({ socio, onCreditosActualizados }) {
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
  // `fila.disciplineId`: una disciplina que todavía no matchea ninguna
  // fila del catálogo (ver resolverDisciplinaId) tiene disciplineId=null
  // -- si se usara ESE como clave, coincidiría con el valor inicial de
  // `procesando` (también null) y esa fila nacería con los botones
  // deshabilitados sin que nada esté realmente en vuelo, bloqueando incluso
  // el aviso de "no se encontró en el catálogo".
  const [procesando, setProcesando] = useState(null)

  const disciplinas = planesDeCreditos(socio.plan)

  // Contador que se bumpea después de guardar/ajustar para volver a pedir
  // los datos -- mismo criterio que FichaSocioHistorial.jsx: `cargar()`
  // vive DENTRO del efecto (no como una función de component-scope que el
  // efecto llama) para que el efecto "sincronice con el sistema externo"
  // en vez de ejecutar un setState directo en su cuerpo. `cancelado` evita
  // pisar el estado si el socio cambia (o el modal se cierra) a mitad de
  // una carga en vuelo.
  const [refrescarTick, setRefrescarTick] = useState(0)

  useEffect(() => {
    let cancelado = false

    async function cargar() {
      // Nada que cargar (socio sin ninguna disciplina de créditos en el
      // plan, ej. solo Aparatos) -- el componente ni siquiera se renderiza
      // en ese caso (ver el `if (disciplinas.length === 0) return null`
      // más abajo), así que cortar acá evita 2 llamadas de red al pedo.
      if (disciplinas.length === 0) {
        setCargando(false)
        return
      }
      setCargando(true)
      setError(null)
      try {
        const [idResuelto, mapaCreditos, disciplineIds] = await Promise.all([
          resolverUserIdPorDni(socio.dni),
          fetchCreditosPorDisciplina([socio.dni]),
          Promise.all(disciplinas.map((d) => resolverDisciplinaId(d))),
        ])
        if (cancelado) return
        setUserId(idResuelto)

        const porNombre = new Map(
          (mapaCreditos.get(socio.dni) ?? []).map((c) => [(c.disciplineName ?? '').trim().toLowerCase(), c]),
        )
        const nuevasFilas = disciplinas.map((nombre, i) => {
          const entrada = porNombre.get(nombre.trim().toLowerCase())
          return {
            disciplina: nombre,
            // Si la disciplina nunca tuvo ninguna fila real en user_credits
            // (ej. recién tildada en el plan, sin ningún pago todavía),
            // `entrada` no existe -- se resuelve igual el id desde el
            // catálogo, para que +1/fijar funcionen desde el primer momento.
            disciplineId: entrada?.disciplineId ?? disciplineIds[i] ?? null,
            remainingCredits: entrada?.remainingCredits ?? 0,
            proximoVencimiento: entrada?.lotes?.[0]?.expiresAt ?? null,
          }
        })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  if (disciplinas.length === 0) return null

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
        </div>
      )}
    </div>
  )
}

export default CreditosEditablesSocio
