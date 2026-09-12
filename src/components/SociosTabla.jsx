import { CreditCard, MessageCircle, Pencil, UserX, UserCheck } from 'lucide-react'
import { esPlanDeCreditos, planesDeVencimiento, tienePlanDeVencimiento } from '../utils/planes'
import { formatFecha } from '../utils/fecha'

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

// Créditos por LOTES (ver supabase_migration_lotes_creditos_fase1/2.sql):
// `socio.creditosPwaPorDisciplina` (batch vía fetchCreditosPorDisciplina en
// Socios.jsx, mismo dato que ya usan CreditosCell/VencimientoCell acá abajo
// -- no se duplica ninguna consulta) trae `remainingCredits` YA sumado sobre
// los lotes activos de cada disciplina, así que alcanza con que UNA sola
// tenga saldo > 0.
function tieneCreditosActivos(creditosPwaPorDisciplina) {
  return (creditosPwaPorDisciplina ?? []).some((c) => (c.remainingCredits ?? 0) > 0)
}

// Aparatos no pasa por fetchCreditosPorDisciplina (esa función filtra
// kind='credits' a propósito, Aparatos es kind='membership') -- se reusa
// `socio.fechaVencimiento`, el mismo dato que ya muestra VencimientoCell
// para esa disciplina, sin ninguna consulta nueva.
//
// BUG REAL (caso Agustina Barbero, DNI 43151174, plan=solo CrossFit):
// esto no chequeaba si el socio REALMENTE tiene Aparatos/Pase Libre
// tildado en su plan -- socios.fecha_vencimiento es una sola columna que
// se puede haber cargado alguna vez (alta vieja, migración de CrossFy, o
// el campo "Fecha de vencimiento" de NuevoSocioModal, que aplica a
// CUALQUIER plan) sin que le corresponda a una membresía real hoy. Un
// socio 100% créditos con un remanente vencido pero una
// `fecha_vencimiento` residual todavía futura podía figurar "Con
// Créditos" en el badge por esa fecha sola, sin tener ni un crédito real
// ni Aparatos. Ahora exige `tienePlanDeVencimiento` primero.
function tieneAparatosVigente(socio) {
  if (!tienePlanDeVencimiento(socio.plan)) return false
  if (!socio.fechaVencimiento) return false
  const vencimiento = new Date(`${socio.fechaVencimiento}T00:00:00`)
  return vencimiento.getTime() > Date.now()
}

// FIX (checkboxes/columna "reflejan la realidad", caso real Valentina
// Ramon) -- Aparatos vigente = fecha_vencimiento en el futuro, PUNTO --
// sin el gate `tienePlanDeVencimiento(socio.plan)` que sí tiene
// tieneAparatosVigente() (usada por VencimientoCell/EstadoBadge, fuera de
// alcance de este ticket). Pase Libre es un alias de la misma columna/
// disciplina -- no se distingue, se trata idéntico a Aparatos.
function aparatosActivoReal(socio) {
  if (!socio.fechaVencimiento) return false
  return new Date(`${socio.fechaVencimiento}T00:00:00`).getTime() > Date.now()
}

// FIX (modelo de "plan único") -- ANTES esta columna mostraba
// formatearPlanes(socio.plan) tal cual: un campo de texto que Seba edita a
// mano en "Editar Socio" y que se desincroniza de la realidad con el
// tiempo -- caso real: Valentina Ramon figuraba con CrossFit activo en
// esta columna sin tenerlo tildado en el plan (el error inverso del que ya
// resolvimos en CreditosCell/VencimientoCell: acá el plan mentía por
// EXCESO, no por defecto). Ahora se calcula en vivo, mismo criterio que
// esas dos celdas: una disciplina de créditos cuenta si tiene al menos un
// lote activo (socio.creditosPwaPorDisciplina, ya viene filtrado a eso),
// Aparatos cuenta si fecha_vencimiento sigue vigente -- socio.plan ya no
// se lee para nada acá.
function PlanCell({ socio }) {
  const nombres = (socio.creditosPwaPorDisciplina ?? []).map((entrada) => entrada.disciplineName)
  if (aparatosActivoReal(socio)) nombres.unshift('Aparatos')

  if (nombres.length === 0) return <span className="text-gray-600">—</span>
  return <>{nombres.join(', ')}</>
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
    // BUG REAL (ver auditoría de Socios): esto leía `socio.creditos`, el
    // pozo global viejo -- nunca se siembra al alta (sincronizarCreditosPwa
    // solo escribe user_credits) ni baja con el consumo real (book_class/
    // cancel_booking tampoco lo tocan), así que podía mostrar "Sin
    // Créditos" a un socio recién dado de alta con créditos reales, o "Con
    // Créditos" a uno que ya gastó todo. Ahora usa la MISMA fuente real que
    // las columnas Créditos/Vencimiento: al menos un lote activo en
    // cualquier disciplina de créditos, O Aparatos vigente (un socio con
    // plan combinado -- ej. CrossFit + Aparatos -- sigue "Con Créditos" si
    // le queda Aparatos, aunque los créditos de CrossFit se hayan agotado).
    const sinCreditos = !tieneCreditosActivos(socio.creditosPwaPorDisciplina) && !tieneAparatosVigente(socio)
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
// utils/planes.js). Fix histórico: una fila POR disciplina, mostrando el
// número REAL que ya tiene la PWA (`socio.creditosPwaPorDisciplina`, batch
// vía fetchCreditosPorDisciplina en Socios.jsx) en vez del pozo global.
//
// Los steppers -/+1/+4/+8/+12 que vivían acá se sacaron (rediseño): con
// datos sucios de la migración de CrossFy, corregir a alguien con muchos
// créditos de más obligaba a tocar "-1" decenas de veces. El ajuste ahora
// vive en "Editar Socio" (CreditosEditablesSocio.jsx), con un input para
// escribir el número exacto -- acá la celda queda de solo lectura.
//
// FIX (modelo de "plan único", caso real Facundo Uria DNI 44537978) --
// hasta acá esta celda seguía iterando planesDeCreditos(socio.plan) (el
// checkbox de "Editar Socio") para decidir QUÉ disciplinas mostrar, y
// recién ahí buscaba el real de cada una (con `?? 0` si no encontraba
// nada). Mismos dos problemas que tenía CreditosEditablesSocio.jsx (ver
// ese componente): una disciplina con créditos reales pero SIN tildar en
// el plan no aparecía acá (caso Kickstrike), y una tildada en el plan pero
// sin ningún lote activo mostraba "0" en vez de desaparecer (caso Boxeo).
// Ahora se itera DIRECTO socio.creditosPwaPorDisciplina -- ya no hace
// falta resolver nada por nombre contra el plan: fetchCreditosPorDisciplina
// ya filtra a "al menos un lote activo" (ver fichaSocioPwa.js) y ya trae el
// disciplineName real (del join contra `disciplines`), así que tampoco
// hace falta el matching case-insensitive de antes.
function CreditosCell({ socio }) {
  const entradas = socio.creditosPwaPorDisciplina ?? []
  if (entradas.length === 0) {
    return <span className="text-gray-600">—</span>
  }

  return (
    <div className="flex flex-col gap-1.5">
      {entradas.map((entrada) => (
        <div key={entrada.disciplineId ?? entrada.disciplineName} className="flex items-center gap-1.5">
          {entradas.length > 1 && (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{entrada.disciplineName}:</span>
          )}
          <span
            className="text-sm font-semibold text-white"
            title={`Créditos reales de ${entrada.disciplineName} en la app`}
          >
            {entrada.remainingCredits ?? 0}
          </span>
        </div>
      ))}
    </div>
  )
}

// Créditos por LOTES (ver supabase_migration_lotes_creditos_fase1/2.sql):
// hasta acá esta celda solo mostraba fecha_vencimiento -- que es la fecha
// de Aparatos/membresía, nunca la de una disciplina de créditos. Un socio
// con 2+ lotes activos de la misma disciplina (compras distintas,
// vencimientos distintos) no tenía NINGÚN lugar en el panel para ver
// cuándo vence cada uno -- CreditosCell solo muestra el total. Mismo
// formato "X vencen el dd/mm · Y vencen el dd/mm" que ya usa la PWA
// (formatCreditosDisponibles en creditsApi.ts) para que Seba vea
// exactamente lo mismo que el socio, tope 2 lotes + "y N más" -- mismo
// criterio de recorte que la PWA.
const MAX_LOTES_EN_DESGLOSE = 2

// "YYYY-MM-DD" del día calendario en hora Argentina -- mismo criterio que
// ya usa acreditar_pack() para decidir si dos acreditaciones fusionan en
// un solo lote (ver supabase_migration_fix_zona_horaria_fusion_lotes.sql).
// Puramente para AGRUPAR EL TEXTO acá -- no toca ninguna fila real de
// user_credits. Mismo agrupamiento que fetchCreditosPorDisciplina() aplica
// del lado de la PWA (creditsApi.ts) -- tienen que verse coherentes.
//
// `socio.fechaVencimiento` llega como "YYYY-MM-DD" puro (columna `date`,
// sin hora) -- pasado tal cual a `Date`, se interpreta como medianoche
// UTC, que en Argentina (UTC-3) cae en el día ANTERIOR (mismo bug que ya
// resolvió formatFecha() en utils/fecha.js). Los `expiresAt` de los lotes
// de créditos ya vienen con hora real embebida (mediodía UTC de siempre),
// así que este ajuste no les cambia nada -- es solo para que
// VencimientoCell pueda agrupar la fecha de Aparatos junto con las de
// créditos sin ese corrimiento de un día.
function claveDiaArgentina(isoString) {
  const esSoloFecha = /^\d{4}-\d{2}-\d{2}$/.test(isoString)
  const valor = esSoloFecha ? `${isoString}T12:00:00` : isoString
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Mendoza',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(valor))
}

// "A, B y C" -- listado en español sin coma de Oxford, para las líneas de
// vencimiento agrupadas por fecha ("Aparatos y CrossFit vencen el...").
function listarConY(nombres) {
  if (nombres.length <= 1) return nombres[0] ?? ''
  return `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`
}

// Socios con 2+ lotes que vencen el MISMO día calendario (típico en datos
// de antes del fix de zona horaria de la fusión, que quedaron en filas
// separadas aunque deberían haber fusionado) se veían como líneas
// redundantes -- "8 vencen el 23/09 · 4 vencen el 23/09" en vez de "12
// vencen el 23/09". Se agrupan acá, en la presentación, ANTES de decidir
// cuántas líneas hacen falta -- `lotes` ya viene ordenado ascendente por
// expiresAt (fetchCreditosPorDisciplina), así que agrupar preservando el
// orden de primera aparición alcanza, sin reordenar nada.
function agruparLotesPorDiaArgentina(lotes) {
  const porDia = new Map()
  const orden = []
  for (const lote of lotes) {
    const clave = claveDiaArgentina(lote.expiresAt)
    const existente = porDia.get(clave)
    if (existente) {
      existente.remainingCredits += lote.remainingCredits
    } else {
      porDia.set(clave, { remainingCredits: lote.remainingCredits, expiresAt: lote.expiresAt })
      orden.push(clave)
    }
  }
  return orden.map((clave) => porDia.get(clave))
}

function formatVencimientoLotes(lotes) {
  if (!lotes || lotes.length === 0) return null
  const agrupados = agruparLotesPorDiaArgentina(lotes)
  if (agrupados.length === 1) return `Vence el ${formatFecha(agrupados[0].expiresAt)}`

  const visibles = agrupados.slice(0, MAX_LOTES_EN_DESGLOSE)
  const partes = visibles.map((lote) => `${lote.remainingCredits} vencen el ${formatFecha(lote.expiresAt)}`)
  const restantes = agrupados.length - visibles.length
  if (restantes > 0) partes.push(`y ${restantes} más`)
  return partes.join(' · ')
}

// Tope de líneas de fecha ANTES de recortar con "y N más" -- Aparatos +
// las 3 disciplinas de créditos que existen hoy (CrossFit/Boxeo/
// Kickstrike) es el máximo real de "grupos de fecha" posibles (4, si cada
// una vence un día distinto) -- mismo espíritu que MAX_LOTES_EN_DESGLOSE,
// pero acá el techo real ya es bajo, así que 3 alcanza sin sentirse recortado.
const MAX_GRUPOS_FECHA_EN_DESGLOSE = 3

// Una fecha de vencimiento pasada nunca se muestra -- si Aparatos ya no
// está vigente, esa línea directamente no aparece (ver `mostrarAparatos`
// más abajo). Esto es SOLO para Aparatos/membresía -- las líneas de
// créditos de abajo no dependen de nada de esto (se rigen por sus propios
// lotes, ver `agrupados`/`entradasMultiFecha`).
//
// BUG REAL (caso Agustina Barbero, DNI 43151174, plan=solo CrossFit):
// esto mostraba `socios.fecha_vencimiento` SIEMPRE que hubiera un valor y
// el socio estuviera activo, sin chequear si el socio REALMENTE tiene
// Aparatos/Pase Libre tildado -- una fecha residual (dato sucio de la
// migración de CrossFy, o cargada una vez desde el campo "Fecha de
// vencimiento" de NuevoSocioModal, que aplica a cualquier plan) se veía
// como una segunda fecha sin etiqueta, indistinguible de la de créditos.
// Ahora exige `tienePlanDeVencimiento` (Aparatos O Pase Libre -- las dos
// etiquetas que usan esta misma columna, ver utils/planes.js) antes de
// mostrar nada.
//
// REDISEÑO -- agrupar por FECHA, no por disciplina (antes: una línea POR
// DISCIPLINA, cada una con su propio texto -- si 2 disciplinas vencían el
// mismo día, la fecha se repetía dos veces con etiquetas distintas en vez
// de unificarse en una sola línea). También unifica el estilo visual: la
// línea de Aparatos vivía en un <span> sin clases (más grande, blanco),
// distinto del <span className="text-xs text-gray-400"> de créditos --
// ahora TODAS las líneas de esta celda comparten el mismo estilo.
//
// Cada disciplina de créditos aporta UNA fecha al agrupamiento solo si sus
// lotes ya colapsan a un único día (agruparLotesPorDiaArgentina) -- si
// genuinamente tiene lotes activos en 2+ días distintos (raro), no hay una
// sola fecha suya para agrupar con las demás: se muestra en su propia
// línea, con su desglose de lotes de siempre (formatVencimientoLotes),
// etiquetada con su nombre apenas haya algo más en la celda.
function VencimientoCell({ socio }) {
  // FIX -- antes dependía de `socio.estado === 'activo'` como proxy de "¿la
  // fecha de Aparatos sigue vigente?". `socio.estado` se deriva de
  // estadoOperativoSocio() (Socios.jsx), que le da una ventana de
  // tolerancia de varios días (dias_tolerancia, default 5) antes de pasar
  // a 'vencido' -- bajo el modelo VIEJO, donde fecha_vencimiento era LA
  // cuota general del socio, esa ventana de gracia tenía sentido. Bajo el
  // modelo nuevo (acreditar_pack -- un solo plan activo), fecha_vencimiento
  // pasó a representar específicamente la vigencia de Aparatos del ÚLTIMO
  // pack -- comparar la fecha directo (mismo patrón que ya usa
  // tieneAparatosVigente(), reusada acá tal cual) es lo único que
  // realmente contesta "¿esto sigue vigente ahora mismo?", sin la ventana
  // de gracia de varios días de por medio (caso real: Facundo Uria, DNI
  // 44537978 -- con `estado==='activo'` seguía mostrando Aparatos "Vence
  // el ..." con una fecha ya reseteada).
  const mostrarAparatos = tieneAparatosVigente(socio)
  // "Aparatos" y "Pase Libre" son las dos etiquetas posibles de la misma
  // columna (fecha_vencimiento) -- en el caso real (uno de los dos
  // tildado) esto da un solo nombre; el `join` es solo para el caso
  // teórico de tener ambos tildados a la vez, sin perder ningún dato.
  const etiquetaMembresia = planesDeVencimiento(socio.plan).join(' + ')

  const entradasSimples = [] // { nombre, fechaISO } -- una fecha única por disciplina
  const entradasMultiFecha = [] // { nombre, texto } -- disciplinas con 2+ fechas propias

  if (mostrarAparatos) {
    entradasSimples.push({ nombre: etiquetaMembresia, fechaISO: socio.fechaVencimiento })
  }

  // FIX (modelo de "plan único", caso real Facundo Uria DNI 44537978) --
  // ANTES este loop era `for (const disciplina of planesDeCreditos(socio.plan))`
  // y recién ahí buscaba las filas reales de esa disciplina -- una
  // disciplina con lotes activos pero SIN tildar en el plan (caso
  // Kickstrike) nunca se llegaba a buscar, así que faltaba directamente de
  // esta celda. Ahora se itera DIRECTO socio.creditosPwaPorDisciplina
  // (mismo criterio que ya tiene CreditosCell arriba) -- el guard de abajo
  // (`lotes.length === 0`) ya cubría el caso contrario (disciplina tildada
  // sin nada vigente, caso Boxeo), eso no cambia.
  for (const entrada of socio.creditosPwaPorDisciplina ?? []) {
    const disciplina = entrada.disciplineName
    const lotes = entrada.lotes ?? []
    if (lotes.length === 0) continue
    const agrupados = agruparLotesPorDiaArgentina(lotes)
    if (agrupados.length === 1) {
      entradasSimples.push({ nombre: disciplina, fechaISO: agrupados[0].expiresAt })
    } else {
      entradasMultiFecha.push({ nombre: disciplina, texto: formatVencimientoLotes(lotes) })
    }
  }

  if (entradasSimples.length === 0 && entradasMultiFecha.length === 0) {
    return <span className="text-gray-600">—</span>
  }

  // Agrupar las entradas de fecha única por día calendario Argentina --
  // preserva el orden de primera aparición (Aparatos siempre primero,
  // después créditos en el orden de PLANES_DE_CREDITOS).
  const porDia = new Map()
  const ordenDias = []
  for (const { nombre, fechaISO } of entradasSimples) {
    const clave = claveDiaArgentina(fechaISO)
    const existente = porDia.get(clave)
    if (existente) {
      existente.nombres.push(nombre)
    } else {
      porDia.set(clave, { fechaISO, nombres: [nombre] })
      ordenDias.push(clave)
    }
  }
  const grupos = ordenDias.map((clave) => porDia.get(clave))

  // UNA sola línea (sea 1 fecha o varias) -- mismo criterio que
  // formatVencimientoLotes con varios lotes: se listan los grupos
  // separados por " · ", no una línea por grupo.
  let textoFechas = null
  if (grupos.length === 1 && entradasMultiFecha.length === 0) {
    // TODO cae en una sola fecha -- sin importar cuántas disciplinas sean.
    const { fechaISO } = grupos[0]
    const cantidad = entradasSimples.length
    if (cantidad === 1) {
      textoFechas = `Vence el ${formatFecha(fechaISO)}`
    } else if (cantidad === 2) {
      textoFechas = `Ambos vencen el ${formatFecha(fechaISO)}`
    } else {
      textoFechas = `Las ${cantidad} disciplinas vencen el ${formatFecha(fechaISO)}`
    }
  } else if (grupos.length > 0) {
    // 2+ fechas distintas -- "Aparatos y CrossFit vencen el dd/mm · Boxeo
    // vence el dd/mm", tope de MAX_GRUPOS_FECHA_EN_DESGLOSE grupos antes
    // de recortar con "y N más" (mismo espíritu que el desglose de lotes).
    const visibles = grupos.slice(0, MAX_GRUPOS_FECHA_EN_DESGLOSE)
    const partes = visibles.map(({ fechaISO, nombres }) => {
      const verbo = nombres.length === 1 ? 'vence' : 'vencen'
      return `${listarConY(nombres)} ${verbo} el ${formatFecha(fechaISO)}`
    })
    const restantes = grupos.length - visibles.length
    if (restantes > 0) partes.push(`y ${restantes} fecha${restantes > 1 ? 's' : ''} más`)
    textoFechas = partes.join(' · ')
  }
  // grupos.length === 0 (ninguna disciplina con fecha única, ej. cuando lo
  // único que hay es una disciplina multi-fecha) deja textoFechas en null
  // -- no hay ninguna línea de fecha-agrupada que armar.

  // Las disciplinas multi-fecha (caso raro) solo llevan su propio nombre
  // como etiqueta cuando hay algo más en la celda -- si son lo único que
  // hay, quedan igual que el caso de 1 sola disciplina de siempre.
  const necesitaEtiquetaMultiFecha = textoFechas !== null || entradasMultiFecha.length > 1

  return (
    <div className="flex flex-col gap-0.5">
      {textoFechas && <span className="text-xs text-gray-400">{textoFechas}</span>}
      {entradasMultiFecha.map(({ nombre, texto }) => (
        <span key={nombre} className="text-xs text-gray-400">
          {necesitaEtiquetaMultiFecha ? `${nombre}: ${texto}` : texto}
        </span>
      ))}
    </div>
  )
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
          <p className="text-gray-300">
            <PlanCell socio={socio} />
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Vencimiento</p>
          <p className="text-gray-300">
            <VencimientoCell socio={socio} />
          </p>
        </div>
        <div>
          <p className="mb-1 text-xs text-gray-500">Créditos</p>
          <CreditosCell socio={socio} />
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
                <td className="px-5 py-3 text-gray-300">
                  <PlanCell socio={socio} />
                </td>
                <td className="px-5 py-3">
                  <CreditosCell socio={socio} />
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
