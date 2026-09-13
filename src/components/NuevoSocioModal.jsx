import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { diferenciaEnDias, hoyISO, proximoVencimiento, toISODate } from '../utils/fecha'
import { PLANES_DISPONIBLES, normalizarPlanes, planesDeCreditos, tienePlanDeVencimiento } from '../utils/planes'
import { resolverDisciplinaId } from '../utils/creditosPwa'
import { resolverUserIdPorDni } from '../utils/fichaSocioPwa'
import { normalizarTexto } from '../utils/coincidenciaSocios'
import FichaSocioHistorial from './FichaSocioHistorial'
import CreditosEditablesSocio from './CreditosEditablesSocio'

// Mismo patrón que isValidDni() en greenfit-app/src/lib/dni.ts (PWA) --
// también es el que usa el trigger handle_socio_dni_upsert() en SQL
// (supabase_migration_socios_auto_auth.sql) para decidir si aprovisiona
// la cuenta de la PWA. Antes, el Admin no validaba el formato en absoluto:
// un DNI mal tipeado se guardaba sin error visible, y como no matcheaba
// ese mismo patrón en el trigger, el socio quedaba con su ficha completa
// acá pero SIN cuenta de PWA -- nadie se enteraba hasta que el socio decía
// "no puedo entrar a la app".
const DNI_REGEX = /^\d{6,10}$/

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
// vuelta síncrona a este cliente) -- si se intenta acreditar créditos o
// vencimiento apenas el INSERT de `socios` devuelve éxito, lo más probable
// es que la cuenta todavía no exista. Esperamos a que `profiles` la tenga
// lista (hasta ~5s) antes de sincronizar.
//
// FIX (Fase 2, ver admin_acreditar_creditos_manual): esta condición de
// carrera SIGUE vigente después de reemplazar sincronizarCreditosPwa/
// sincronizarVencimientoPwa por ese RPC -- también necesita un user_id ya
// resuelto (lo recibe como parámetro, no resuelve nada por DNI del lado
// del servidor), así que el problema que esta función resuelve no cambió
// en nada. Se devuelve el user_id resuelto directo (antes solo un
// booleano) -- ahorra una segunda consulta idéntica en el caller.
async function esperarCuentaPwa(dni, intentos = 6, esperaMs = 800) {
  for (let i = 0; i < intentos; i += 1) {
    const userId = await resolverUserIdPorDni(dni)
    if (userId) return userId
    if (i < intentos - 1) await new Promise((resolve) => setTimeout(resolve, esperaMs))
  }
  return null
}

// FIX (checkboxes "reflejan la realidad", caso real Valentina Ramon) --
// Aparatos vigente sin depender de socio.plan -- mismo criterio que
// aparatosActivoReal() en SociosTabla.jsx (PlanCell), duplicado acá a
// propósito: son dos componentes sin relación de import entre sí, y la
// función es una sola comparación, no vale la pena crear un módulo
// compartido por esto. Pase Libre es un alias de la misma columna/
// disciplina -- se trata idéntico a Aparatos.
//
// BUG REAL (caso Arianna Isgro, DNI 51705419): ANTES esto comparaba
// `socio.fechaVencimiento` (mirror de socios.fecha_vencimiento) contra hoy,
// sin confirmar que existiera una fila real detrás en user_credits -- un
// residuo (import de CrossFy, el campo "Fecha de vencimiento" ya eliminado
// de este mismo modal) podía dejar esa columna con una fecha futura SIN
// ninguna membresía real, y el checkbox quedaba tildado para siempre (ni
// siquiera admin_quitar_disciplina_socio podía destildarlo -- sin ninguna
// fila que actualizar, no tenía nada que corregir). Ahora lee
// `socio.aparatosVigenteReal` -- un booleano YA resuelto contra
// user_credits de verdad (fetchAparatosVigentePorDni, Socios.jsx).
function aparatosActivoReal(socio) {
  return socio?.aparatosVigenteReal === true
}

function NuevoSocioModal({
  socio,
  disciplinasActivas = [],
  onClose,
  onSaved,
  onBuscarSocioPorDni,
  onEditarSocioExistente,
  onBuscarSocioPorNombre,
  onCreditosActualizados,
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
  // FIX (checkboxes "reflejan la realidad") -- en edición, los checkboxes
  // de Planes/Actividades ya no son un `form.planes` libremente tildable:
  // se calculan en vivo desde lo que el socio tiene REALMENTE activo hoy
  // (ver checkboxesEdicion abajo), y la ÚNICA interacción posible es
  // destildar una disciplina activa -- este set guarda cuáles quedaron
  // destildadas en esta sesión de edición, sin tocar nada todavía (eso
  // pasa recién al confirmar y guardar, ver handleSubmit).
  const [disciplinasDestildadas, setDisciplinasDestildadas] = useState(() => new Set())

  // Filas para los checkboxes en modo edición -- una por disciplina de
  // créditos del catálogo activo (más cualquiera con crédito activo real
  // que por algún motivo ya no esté en ese catálogo, para que nunca quede
  // una disciplina real oculta) + una fila fija de Aparatos. `activo` es
  // el único criterio real: créditos con al menos un lote vigente, o
  // Aparatos con fecha_vencimiento en el futuro -- socio.plan no se lee
  // para nada acá.
  const checkboxesEdicion = useMemo(() => {
    if (!esEdicion) return []

    const creditosPorNombre = new Map((socio.creditosPwaPorDisciplina ?? []).map((e) => [e.disciplineName, e]))
    const catalogoCreditos = new Map(
      disciplinasActivas.filter((d) => d.kind === 'credits').map((d) => [d.name, d.id]),
    )
    for (const [nombre, entrada] of creditosPorNombre) {
      if (!catalogoCreditos.has(nombre)) catalogoCreditos.set(nombre, entrada.disciplineId)
    }

    const filas = Array.from(catalogoCreditos.entries()).map(([nombre, disciplineId]) => {
      const entrada = creditosPorNombre.get(nombre)
      return {
        disciplina: nombre,
        disciplineId,
        kind: 'credits',
        activo: !!entrada,
        remainingCredits: entrada?.remainingCredits ?? 0,
      }
    })

    const aparatosDisciplina = disciplinasActivas.find((d) => d.kind === 'membership')
    filas.push({
      disciplina: 'Aparatos',
      disciplineId: aparatosDisciplina?.id ?? null,
      kind: 'membership',
      activo: aparatosActivoReal(socio),
      remainingCredits: null,
    })

    return filas
  }, [esEdicion, socio, disciplinasActivas])

  // El plan "efectivo" en edición -- lo que está REALMENTE activo, menos lo
  // que se destildó en esta sesión (todavía sin guardar). Se usa para el
  // guard de "algo para guardar" y para lo que termina escribiéndose en
  // socios.plan -- OJO: la sección de fecha de vencimiento de más abajo
  // (ticket aparte, Agustina Barbero) sigue leyendo form.planes a
  // propósito, no esto -- ver el comentario ahí. form.planes sigue siendo
  // la fuente real en el alta, que no cambia con este ticket.
  const planesActuales = esEdicion
    ? checkboxesEdicion.filter((f) => f.activo && !disciplinasDestildadas.has(f.disciplina)).map((f) => f.disciplina)
    : form.planes

  const handleToggleEdicion = (disciplina) => {
    setDisciplinasDestildadas((prev) => {
      const siguiente = new Set(prev)
      if (siguiente.has(disciplina)) siguiente.delete(disciplina)
      else siguiente.add(disciplina)
      return siguiente
    })
  }

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

    if (!DNI_REGEX.test(form.dni.trim())) {
      setError('El DNI tiene que tener entre 6 y 10 dígitos, sin puntos ni espacios.')
      return
    }

    // Solo en alta -- en edición, quedarse sin ninguna disciplina activa es
    // un resultado válido de sacarle la última que tenía (ver CAMBIO 2:
    // "Destildar Aparatos" cuando es lo único activo tiene que poder
    // guardarse, no bloquearse acá).
    if (!esEdicion && planesActuales.length === 0) {
      setError('Seleccioná al menos un plan/actividad.')
      return
    }

    // FIX (CAMBIO 2, checkboxes "reflejan la realidad") -- destildar una
    // disciplina activa en edición no es un cambio de texto: le saca al
    // socio créditos reales o el acceso a Aparatos. Se confirma ANTES de
    // aplicar nada -- si cancela, se deshacen los destildes pendientes (el
    // checkbox vuelve a mostrarse tildado) y no se guarda nada de nada,
    // ni siquiera el resto de los cambios del formulario (nombre/teléfono/
    // etc.) -- más simple y más seguro que un guardado parcial.
    const disciplinasARemover = esEdicion
      ? checkboxesEdicion.filter((f) => f.activo && disciplinasDestildadas.has(f.disciplina))
      : []
    if (disciplinasARemover.length > 0) {
      const lineas = disciplinasARemover.map((f) =>
        f.kind === 'membership'
          ? 'Perderá el acceso a Aparatos.'
          : `Perderá sus ${f.remainingCredits} créditos activos de ${f.disciplina}.`,
      )
      const nombres = disciplinasARemover.map((f) => f.disciplina).join(', ')
      const confirmado = window.confirm(
        `¿Confirmás sacarle ${nombres} a ${socio.nombre} ${socio.apellido}?\n${lineas.join('\n')}`,
      )
      if (!confirmado) {
        setDisciplinasDestildadas(new Set())
        return
      }
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

    // Se aplica ANTES del UPDATE de `socios` a propósito -- si el RPC
    // falla acá, se corta sin dejar socios.plan reflejando una
    // disciplina que en realidad no se pudo sacar de user_credits.
    if (disciplinasARemover.length > 0) {
      const userId = await resolverUserIdPorDni(form.dni)
      if (!userId) {
        setError('Este socio todavía no tiene cuenta en la app -- no se le puede sacar ninguna disciplina desde acá.')
        setGuardando(false)
        return
      }
      for (const fila of disciplinasARemover) {
        if (!fila.disciplineId) {
          setError(`No se encontró "${fila.disciplina}" en el catálogo de Disciplinas -- revisalo en Configuración.`)
          setGuardando(false)
          return
        }
        const { error: errorQuitar } = await supabase.rpc('admin_quitar_disciplina_socio', {
          p_user_id: userId,
          p_discipline_id: fila.disciplineId,
        })
        if (errorQuitar) {
          console.error('Error al sacar disciplina (admin_quitar_disciplina_socio):', errorQuitar)
          setError(`No se pudo sacarle ${fila.disciplina} a ${socio.nombre}. Intentá nuevamente.`)
          setGuardando(false)
          return
        }
      }
    }

    let resultado
    let fechaVencimientoNueva = null
    // Hoisteada igual que fechaVencimientoNueva -- se asigna dentro del
    // `else` de abajo (alta nueva) pero hace falta más adelante, fuera de
    // ese bloque, para admin_acreditar_creditos_manual() (p_fecha_inicio).
    let fechaInicioAlta = null

    if (esEdicion) {
      const cambios = {
        nombre: form.nombre,
        apellido: form.apellido,
        dni: form.dni,
        email: form.email,
        telefono: form.telefono,
        // FIX (checkboxes "reflejan la realidad") -- ya no es form.planes
        // (el estado libremente tildable de siempre) sino planesActuales:
        // lo que está REALMENTE activo hoy, menos lo que se acaba de sacar
        // arriba -- socios.plan queda reflejando la realidad post-cambios,
        // no lo que Seba haya tildado a mano en algún momento anterior.
        plan: planesActuales,
      }
      resultado = await supabase.from('socios').update(cambios).eq('id', socio.id).select()
    } else {
      const fechaInicio = form.fechaInicio || hoyISO()
      fechaInicioAlta = fechaInicio
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

    // Sentido inverso de la sincronización PWA -> Admin (ver
    // sincronizar_telefono_a_socio, disparada desde "Mis datos" en la
    // PWA): si el admin edita o unifica el teléfono de un socio ya
    // existente, se refleja en profiles.phone -- sin esto, el socio
    // seguía viendo su teléfono viejo en su propio perfil de la PWA
    // aunque Seba ya lo hubiera corregido acá. Solo aplica a `socios` que
    // YA existían (edición/unificación) -- un alta nueva no necesita esto:
    // el teléfono de un socio recién creado ya le llega a profiles.phone
    // solo, vía el trigger on_socio_dni_upsert (crea la cuenta de Auth con
    // `phone` en el metadata) + handle_new_user (la copia a profiles).
    // Best-effort a propósito -- no bloquea el guardado si la migración
    // todavía no corrió o el socio no tiene cuenta de PWA vinculada
    // (mismo criterio "fail open" que el resto de este puente por DNI).
    if (esEdicion || socioAUnificar) {
      const { error: syncTelefonoError } = await supabase.rpc('sincronizar_telefono_a_profile', {
        p_dni: form.dni,
        p_telefono: form.telefono,
      })
      if (syncTelefonoError) {
        console.warn('No se pudo sincronizar el teléfono con la app del socio:', syncTelefonoError.message)
      }
    }

    // Alta nueva: además de la tabla legacy `socios`, cargamos los créditos
    // por disciplina y/o el vencimiento de Aparatos en la tabla
    // real que lee la PWA (`user_credits`) -- sin esto el socio recién
    // creado no ve nada en su Home hasta una acción separada posterior.
    //
    // FIX (Fase 2, modelo de "plan único") -- ANTES esto llamaba a
    // sincronizarCreditosPwa()/sincronizarVencimientoPwa() por disciplina
    // suelta, cada una con su propio INSERT/UPDATE independiente -- en un
    // alta nueva no generaba el bug de doble vencimiento en la práctica
    // (el socio no tenía nada previo que resetear), pero dejaba a este
    // flujo en un sistema aparte del que ya usan acreditar_pack() y
    // CreditosEditablesSocio.jsx. Ahora llama a
    // admin_acreditar_creditos_manual() (Fase 1, ya en producción) -- un
    // solo RPC atómico que arma TODOS los créditos + Aparatos de esta alta
    // con una sola fecha de vencimiento, mismo criterio que "Cobrar" (ver
    // handleConfirmarPago en Socios.jsx).
    if (!esEdicion) {
      const disciplinasCredito = planesDeCreditos(form.planes)
      const necesitaVencimiento = tienePlanDeVencimiento(form.planes)
      const avisos = []

      // Filtrado ACÁ (antes de decidir si hace falta esperar la cuenta) --
      // si Seba tildó una disciplina de créditos pero dejó la cantidad en
      // blanco, no hay nada que acreditar en ella y no vale la pena
      // esperar/llamar a nada por su culpa.
      const entradasCredito = disciplinasCredito
        .map((disciplina) => ({ disciplina, cantidad: Number(form.creditosPorDisciplina[disciplina]) || 0 }))
        .filter((item) => item.cantidad > 0)

      if (entradasCredito.length > 0 || necesitaVencimiento) {
        const userId = await esperarCuentaPwa(form.dni)
        if (!userId) {
          avisos.push(
            'La cuenta de la app todavía se está generando: cargá los créditos/vencimiento en unos segundos desde "Registrar Pago".',
          )
        } else {
          const pCreditos = []
          for (const { disciplina, cantidad } of entradasCredito) {
            const disciplineId = await resolverDisciplinaId(disciplina)
            if (!disciplineId) {
              avisos.push(`No se encontró "${disciplina}" en el catálogo de Disciplinas -- no se pudieron cargar sus créditos.`)
              continue
            }
            pCreditos.push({ discipline_id: disciplineId, credits: cantidad })
          }

          if (pCreditos.length > 0 || necesitaVencimiento) {
            const diasVigencia = diferenciaEnDias(fechaInicioAlta, fechaVencimientoNueva)
            const { error: errorAcreditar } = await supabase.rpc('admin_acreditar_creditos_manual', {
              p_user_id: userId,
              p_creditos: pCreditos,
              p_incluye_aparatos: necesitaVencimiento,
              p_dias_vigencia: diasVigencia,
              p_fecha_inicio: fechaInicioAlta,
            })
            if (errorAcreditar) {
              console.error('Error al acreditar créditos/Aparatos iniciales (admin_acreditar_creditos_manual):', errorAcreditar)
              avisos.push('No se pudieron cargar los créditos/vencimiento iniciales en la app. Revisá la consola.')
            }
          }
        }
      }

      if (avisos.length > 0) window.alert(avisos.join('\n'))
    }

    setGuardando(false)
    onSaved(socioAUnificar ? '¡Usuario unificado con éxito!' : undefined)
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
            {esEdicion ? (
              <>
                {/* FIX (checkboxes "reflejan la realidad", caso real
                    Valentina Ramon) -- ya no son libremente tildables: cada
                    uno refleja lo que el socio tiene REALMENTE activo hoy
                    (créditos con al menos un lote vigente, o Aparatos con
                    fecha_vencimiento en el futuro). Una disciplina sin nada
                    activo aparece destildada y DESHABILITADA -- tildarla acá
                    no acredita nada, para eso está "Registrar Pago". La
                    única acción posible es destildar una activa, que le
                    saca esa disciplina al socio al guardar (con
                    confirmación, ver handleSubmit). */}
                <div className="flex flex-wrap gap-2">
                  {checkboxesEdicion.map((fila) => {
                    const tildado = fila.activo && !disciplinasDestildadas.has(fila.disciplina)
                    return (
                      <label
                        key={fila.disciplina}
                        title={
                          fila.activo
                            ? undefined
                            : `${fila.disciplina} no tiene ningún lote activo -- para darlo de alta, usá "Registrar Pago"`
                        }
                        className={`flex min-h-[44px] items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                          tildado ? 'border-greenfit-primary bg-greenfit-primary/10 text-white' : 'border-white/10 text-gray-300'
                        } ${fila.activo ? 'cursor-pointer hover:bg-white/5' : 'cursor-not-allowed opacity-50'}`}
                      >
                        <input
                          type="checkbox"
                          checked={tildado}
                          disabled={!fila.activo}
                          onChange={() => handleToggleEdicion(fila.disciplina)}
                          className="accent-greenfit-primary"
                        />
                        {fila.disciplina}
                      </label>
                    )
                  })}
                </div>
                <p className="text-[11px] text-gray-500">
                  Reflejan lo que el socio tiene activo ahora mismo en la app -- créditos reales o Aparatos vigente,
                  nunca lo que esté tildado a mano. Destildar una disciplina activa se la saca al socio (con
                  confirmación); una sin nada activo no se puede tildar desde acá.
                </p>
              </>
            ) : (
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
            )}
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

          {esEdicion && (
            <CreditosEditablesSocio
              socio={socio}
              disciplinasActivas={disciplinasActivas}
              onCreditosActualizados={onCreditosActualizados}
            />
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
