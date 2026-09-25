import { useMemo, useState } from 'react'
import { Loader2, UserCheck, UserMinus, UserPlus, UserX, X } from 'lucide-react'
import { DIAS_SEMANA } from '../utils/clases'
import { filtrarSocios, pareceDni, soloDigitos } from '../utils/buscarSocios'

function iniciales(nombre) {
  const partes = (nombre ?? '').trim().split(/\s+/)
  const primera = partes[0]?.charAt(0) ?? '?'
  const segunda = partes.length > 1 ? partes[partes.length - 1].charAt(0) : ''
  return `${primera}${segunda}`.toUpperCase()
}

function nombresDias(diasSemana) {
  return DIAS_SEMANA.filter((d) => diasSemana.includes(d.numero))
    .map((d) => d.nombre)
    .join(', ')
}

const MAX_RESULTADOS = 30

function etiquetaCreditos(cantidad) {
  return cantidad === 1 ? '1 crédito' : `${cantidad} créditos`
}

// `socios` / `creditosPorSocio` / `onAgregarSocioPorId` son opcionales: sin
// ellos el buscador se comporta como siempre (solo DNI exacto -> onAgregarSocio).
// - socios: lista { id, full_name, dni } cargada UNA vez al abrir el modal; el
//   filtro corre acá, en memoria (buscarSocios.js).
// - creditosPorSocio: Map user_id -> créditos vigentes en la disciplina de la clase.
// - onAgregarSocioPorId(clase, socio): anota con el id que ya tenemos, sin
//   volver a buscar por DNI.
function InscriptosModal({
  open,
  clase,
  onClose,
  onMarcarAsistencia,
  onAgregarSocio,
  onAgregarSocioPorId,
  socios = null,
  cargandoSocios = false,
  errorSocios = false,
  creditosPorSocio = null,
  onQuitarInscripto,
  onAbrirFicha,
}) {
  const [busqueda, setBusqueda] = useState('')
  const [agregando, setAgregando] = useState(false)

  // Coincidencias por texto (DNI / nombre / apellido)...
  const coincidencias = useMemo(() => filtrarSocios(socios, busqueda), [socios, busqueda])
  // ...y de esas, solo las que tienen créditos vigentes en la disciplina de la
  // clase. Si los créditos no se pudieron cargar (creditosPorSocio null) no se
  // puede saber quién tiene, así que no se filtra: el RPC sigue decidiendo.
  const resultados = useMemo(
    () => (creditosPorSocio ? coincidencias.filter((s) => (creditosPorSocio.get(s.id) ?? 0) > 0) : coincidencias),
    [coincidencias, creditosPorSocio],
  )
  const ocultosSinCreditos = coincidencias.length - resultados.length

  if (!open || !clase) return null

  const yaAnotados = new Set(clase.inscriptos.map((i) => i.userId))
  const esDni = pareceDni(busqueda)
  const hayLista = Array.isArray(socios)
  const unicoResultado = !esDni && resultados.length === 1 && !yaAnotados.has(resultados[0].id) ? resultados[0] : null
  const puedeEnviar = esDni || Boolean(unicoResultado && onAgregarSocioPorId)

  const terminar = () => {
    setAgregando(false)
    setBusqueda('')
  }

  const anotarPorId = async (socio) => {
    setAgregando(true)
    await onAgregarSocioPorId(clase, socio)
    terminar()
  }

  // Enter / botón "Anotar": un DNI tipeado se anota como siempre (búsqueda por
  // DNI exacto contra la base); un nombre solo se anota si quedó UN único
  // resultado -- con varios, se elige tocando uno de la lista.
  const handleAgregar = async (event) => {
    event.preventDefault()
    if (agregando || !busqueda.trim()) return
    if (esDni) {
      setAgregando(true)
      await onAgregarSocio(clase, soloDigitos(busqueda))
      terminar()
      return
    }
    if (unicoResultado && onAgregarSocioPorId) await anotarPorId(unicoResultado)
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div className="mx-auto my-6 w-full max-w-lg rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-white">{clase.disciplina}</h2>
            <p className="text-sm text-gray-400">
              {nombresDias(clase.diasSemana)} · {clase.horaInicio} - {clase.horaFin} · Prof. {clase.profesor}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleAgregar} className="mb-4 flex gap-2">
          <input
            type="text"
            value={busqueda}
            onChange={(event) => setBusqueda(event.target.value)}
            placeholder="Buscar socio por DNI, nombre o apellido..."
            aria-label="Buscar socio para anotar"
            autoComplete="off"
            className="min-h-[44px] flex-1 rounded-lg border border-white/10 bg-greenfit-dark px-3 text-sm text-white outline-none focus:border-greenfit-primary"
          />
          <button
            type="submit"
            disabled={agregando || !puedeEnviar}
            className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg bg-greenfit-primary px-3.5 text-sm font-semibold text-greenfit-dark disabled:opacity-60"
          >
            {agregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            Anotar
          </button>
        </form>

        {busqueda.trim() && (
          <div className="mb-4" data-testid="resultados-busqueda">
            {cargandoSocios && !hayLista ? (
              <p className="flex items-center gap-2 py-2 text-sm text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" /> Cargando socios...
              </p>
            ) : (
              <>
                {errorSocios && !hayLista && (
                  <p className="py-1 text-xs text-amber-300">
                    No se pudo cargar la lista de socios: se puede anotar tipeando el DNI completo.
                  </p>
                )}
                {hayLista && resultados.length === 0 && (ocultosSinCreditos > 0 || !esDni) && (
                  <p className="py-2 text-sm text-gray-400">
                    {ocultosSinCreditos > 0
                      ? esDni
                        ? 'Ese socio no tiene créditos vigentes en esta disciplina. Con Enter se intenta anotar igual y el sistema decide.'
                        : 'Los socios que coinciden no tienen créditos vigentes en esta disciplina. Tipeando el DNI completo igual se intenta anotar.'
                      : 'Ningún socio coincide con esa búsqueda.'}
                  </p>
                )}
                {resultados.length > 0 && (
                  <ul className="max-h-56 divide-y divide-white/5 overflow-y-auto rounded-lg border border-white/10">
                    {resultados.slice(0, MAX_RESULTADOS).map((socio) => {
                      const anotado = yaAnotados.has(socio.id)
                      const creditos = creditosPorSocio ? (creditosPorSocio.get(socio.id) ?? 0) : null
                      return (
                        <li key={socio.id}>
                          <button
                            type="button"
                            disabled={agregando || anotado || !onAgregarSocioPorId}
                            onClick={() => anotarPorId(socio)}
                            data-testid={`resultado-socio-${socio.id}`}
                            className="flex min-h-[48px] w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors enabled:hover:bg-white/5 disabled:opacity-60"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium text-white">{socio.full_name}</span>
                              <span className="block text-xs text-gray-400">DNI {socio.dni || 'sin cargar'}</span>
                            </span>
                            {anotado ? (
                              <span className="shrink-0 text-xs font-semibold text-gray-400">Ya anotado</span>
                            ) : creditos !== null ? (
                              <span className="shrink-0 rounded-full bg-greenfit-primary/15 px-2 py-0.5 text-xs font-semibold text-greenfit-primary">
                                {etiquetaCreditos(creditos)}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
                {resultados.length > MAX_RESULTADOS && (
                  <p className="pt-1 text-xs text-gray-500">
                    Mostrando {MAX_RESULTADOS} de {resultados.length}: seguí escribiendo para acotar.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        <div className="max-h-[60vh] overflow-y-auto">
          {clase.inscriptos.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">
              Todavía no hay socios inscriptos en esta clase.
            </p>
          ) : (
            <ul className="divide-y divide-white/5">
              {clase.inscriptos.map((inscripto) => (
                <li key={inscripto.id} className="flex items-center justify-between gap-2 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-greenfit-primary/15 text-xs font-semibold text-greenfit-primary">
                      {iniciales(inscripto.nombre)}
                    </div>
                    <div className="min-w-0">
                      {/* Clickeable SOLO con dni real -- mismo criterio de
                          "ausencia de UI" que ya rige en el resto del
                          proyecto para socios sin DNI cargado (ver
                          creditos-sin-dni.spec.js): sin dni no hay forma de
                          encontrarlo en /socios, así que queda texto plano
                          en vez de un link que siempre fallaría. */}
                      {inscripto.dni ? (
                        <button
                          type="button"
                          onClick={() => onAbrirFicha(inscripto.dni)}
                          className="block w-full truncate text-left text-sm font-medium text-white hover:text-greenfit-primary hover:underline"
                        >
                          {inscripto.nombre}
                        </button>
                      ) : (
                        <p className="truncate text-sm font-medium text-white">{inscripto.nombre}</p>
                      )}
                      <p className="text-xs text-gray-400">
                        {inscripto.asistio === true
                          ? 'Asistió'
                          : inscripto.asistio === false
                            ? 'Ausente'
                            : 'Sin marcar'}
                      </p>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      title="Marcar Asistió"
                      aria-label="Marcar Asistió"
                      onClick={() => onMarcarAsistencia(clase.id, inscripto.id, true)}
                      className={`flex h-11 w-11 items-center justify-center rounded-lg transition-colors ${
                        inscripto.asistio === true
                          ? 'bg-greenfit-primary/15 text-greenfit-primary'
                          : 'text-gray-400 hover:bg-white/10 hover:text-greenfit-primary'
                      }`}
                    >
                      <UserCheck className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      title="Marcar Ausente"
                      aria-label="Marcar Ausente"
                      onClick={() => onMarcarAsistencia(clase.id, inscripto.id, false)}
                      className={`flex h-11 w-11 items-center justify-center rounded-lg transition-colors ${
                        inscripto.asistio === false
                          ? 'bg-red-500/15 text-red-400'
                          : 'text-gray-400 hover:bg-white/10 hover:text-red-400'
                      }`}
                    >
                      <UserX className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      title="Quitar de la clase"
                      aria-label="Quitar de la clase"
                      onClick={() => onQuitarInscripto(clase, inscripto)}
                      className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      <UserMinus className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

export default InscriptosModal
