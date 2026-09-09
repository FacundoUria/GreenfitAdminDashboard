import { CreditCard, MessageCircle, Pencil, UserX, UserCheck } from 'lucide-react'
import { esPlanDeCreditos, formatearPlanes, planesDeCreditos, planesDeVencimiento, tienePlanDeVencimiento } from '../utils/planes'
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
function CreditosCell({ socio }) {
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
    <div className="flex flex-col gap-1.5">
      {disciplinas.map((disciplina) => (
        <div key={disciplina} className="flex items-center gap-1.5">
          {disciplinas.length > 1 && (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{disciplina}:</span>
          )}
          <span
            className="text-sm font-semibold text-white"
            title={`Créditos reales de ${disciplina} en la app`}
          >
            {realPorDisciplina.get(disciplina.trim().toLowerCase()) ?? 0}
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
function claveDiaArgentina(isoString) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Mendoza',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(isoString))
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

// Una fecha de vencimiento pasada solo tiene sentido mostrarla mientras la
// cuota sigue "activa" (todavía no llegó el día) -- una vez vencida (aunque
// esté en tolerancia) o si el socio no está realmente activo, mostrar la
// fecha vieja es más confuso que útil. Esto es SOLO para Aparatos/membresía
// -- las líneas de créditos de abajo no dependen de `socio.estado` (ese
// campo es del ciclo de cuota por vencimiento, no tiene sentido para
// créditos, que se rigen por sus propios lotes).
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
// Etiquetado (2+ disciplinas con vencimiento propio, sea Aparatos/Pase
// Libre + créditos, o 2+ de créditos entre sí): antes esto solo miraba la
// cantidad de disciplinas de CRÉDITOS (`disciplinasCredito.length > 1`),
// ignorando si Aparatos también se estaba mostrando -- un socio con
// Aparatos + 1 sola disciplina de créditos veía 2 fechas SIN etiquetar,
// indistinguibles entre sí. Ahora se cuenta el total de líneas que se van
// a mostrar (Aparatos/Pase Libre + cada disciplina de créditos con lotes)
// y se etiqueta TODO si ese total es 2 o más -- con 1 sola línea, se sigue
// mostrando sin etiqueta (caso simple, sin cambios).
function VencimientoCell({ socio }) {
  const tieneMembresia = tienePlanDeVencimiento(socio.plan)
  const mostrarAparatos = tieneMembresia && socio.estado === 'activo' && !!socio.fechaVencimiento

  const disciplinasCredito = planesDeCreditos(socio.plan)
  const lineasCreditos = disciplinasCredito
    .map((disciplina) => {
      const entrada = (socio.creditosPwaPorDisciplina ?? []).find(
        (c) => (c.disciplineName ?? '').trim().toLowerCase() === disciplina.trim().toLowerCase(),
      )
      const texto = formatVencimientoLotes(entrada?.lotes)
      if (!texto) return null
      return { disciplina, texto }
    })
    .filter(Boolean)

  const totalLineas = (mostrarAparatos ? 1 : 0) + lineasCreditos.length
  const necesitaEtiqueta = totalLineas > 1
  // "Aparatos" y "Pase Libre" son las dos etiquetas posibles de la misma
  // columna (fecha_vencimiento) -- en el caso real (uno de los dos
  // tildado) esto da un solo nombre; el `join` es solo para el caso
  // teórico de tener ambos tildados a la vez, sin perder ningún dato.
  const etiquetaMembresia = planesDeVencimiento(socio.plan).join(' + ')

  if (!mostrarAparatos && lineasCreditos.length === 0) {
    return <span className="text-gray-600">—</span>
  }

  // BUG VISUAL (caso real: Agustina Ochoa -- solo Aparatos -- mostraba
  // "04/10/2026" pelada, mientras Agustina Alvarez -- Aparatos + CrossFit
  // -- mostraba "Vence el 08/10/2026" con prefijo): la línea de créditos
  // SIEMPRE pasa por formatVencimientoLotes/formatFecha con el prefijo
  // "Vence el " (o "X vencen el ") ya incluido, pero la de Aparatos se
  // armaba con formatFecha() a secas, sin ese prefijo. Unificado -- "Vence
  // el " va SIEMPRE, con o sin etiqueta de disciplina.
  const textoAparatos = `Vence el ${formatFecha(socio.fechaVencimiento)}`

  return (
    <div className="flex flex-col gap-0.5">
      {mostrarAparatos && <span>{necesitaEtiqueta ? `${etiquetaMembresia}: ${textoAparatos}` : textoAparatos}</span>}
      {lineasCreditos.map(({ disciplina, texto }) => (
        <span key={disciplina} className="text-xs text-gray-400">
          {necesitaEtiqueta ? `${disciplina}: ${texto}` : texto}
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
                <td className="px-5 py-3 text-gray-300">{formatearPlanes(socio.plan)}</td>
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
