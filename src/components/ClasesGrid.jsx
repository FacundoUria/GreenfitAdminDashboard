import { Ban, Clock, Eye, Pencil, Users } from 'lucide-react'
import { colorOcupacion } from '../utils/ocupacion'

const COLORES_DISCIPLINA = {
  crossfit: { header: 'from-orange-600 to-orange-500', dot: 'bg-orange-400' },
  boxeo: { header: 'from-red-600 to-red-500', dot: 'bg-red-400' },
  kickboxing: { header: 'from-rose-600 to-rose-500', dot: 'bg-rose-400' },
  musculación: { header: 'from-sky-600 to-sky-500', dot: 'bg-sky-400' },
  aparatos: { header: 'from-sky-600 to-sky-500', dot: 'bg-sky-400' },
  yoga: { header: 'from-purple-600 to-purple-500', dot: 'bg-purple-400' },
  funcional: { header: 'from-teal-600 to-teal-500', dot: 'bg-teal-400' },
  default: { header: 'from-greenfit-primary to-lime-500', dot: 'bg-greenfit-primary' },
}

function colorDisciplina(disciplina) {
  const nombre = (disciplina ?? '').toLowerCase()
  const clave = Object.keys(COLORES_DISCIPLINA).find((c) => c !== 'default' && nombre.includes(c))
  return COLORES_DISCIPLINA[clave ?? 'default']
}

function ClaseCard({ clase, estado, hayDestacada, onVerInscriptos, onEditar, onCancelar }) {
  const inscriptos = clase.inscriptos.length
  const porcentaje = Math.min(100, Math.round((inscriptos / clase.cupoMaximo) * 100))
  const { barra, texto } = colorOcupacion(porcentaje)
  const { header, dot } = colorDisciplina(clase.disciplina)
  const destacada = estado != null

  return (
    <div
      className={`overflow-hidden rounded-2xl border bg-greenfit-card shadow-lg shadow-black/40 transition-all hover:-translate-y-1 hover:shadow-xl hover:shadow-black/50 ${
        destacada
          ? 'z-10 scale-[1.02] border-greenfit-primary shadow-greenfit-primary/30 ring-2 ring-greenfit-primary/60'
          : hayDestacada
            ? 'z-0 scale-[0.98] border-white/5 opacity-75'
            : 'z-0 border-white/5'
      }`}
    >
      <div className={`bg-gradient-to-r ${header} px-5 py-3.5`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot} ring-2 ring-white/40`} />
            <p className="text-sm font-bold uppercase leading-snug tracking-wide text-white">
              {clase.disciplina}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-black/25 px-2.5 py-1 text-xs font-semibold text-white">
            <Clock className="h-3 w-3" />
            {clase.horaInicio} - {clase.horaFin}
          </span>
        </div>
      </div>

      {estado && (
        <div
          className={`flex items-center gap-1.5 px-5 py-1.5 text-[11px] font-bold uppercase tracking-wide ${
            estado === 'en_curso' ? 'bg-greenfit-primary text-greenfit-dark' : 'bg-greenfit-primary/15 text-greenfit-primary'
          }`}
        >
          {estado === 'en_curso' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-greenfit-dark" />}
          {estado === 'en_curso' ? 'En curso' : 'Próxima'}
        </div>
      )}

      <div className="flex flex-col gap-4 p-5">
        <p className="text-sm text-gray-400">
          Prof. <span className="text-gray-300">{clase.profesor}</span>
        </p>

        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="flex items-center gap-1 text-gray-400">
              <Users className="h-3.5 w-3.5" />
              {inscriptos} / {clase.cupoMaximo} inscriptos
            </span>
            <span className={`rounded-full bg-white/5 px-2 py-0.5 font-bold ${texto}`}>{porcentaje}%</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full rounded-full ${barra} transition-all duration-500`}
              style={{ width: `${porcentaje}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-white/5 pt-3">
          <button
            type="button"
            onClick={() => onVerInscriptos(clase)}
            className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2 text-xs font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
          >
            <Eye className="h-3.5 w-3.5" />
            Ver Inscriptos
          </button>
          <button
            type="button"
            onClick={() => onEditar(clase)}
            aria-label="Editar"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/10 text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onCancelar(clase)}
            aria-label="Cancelar clase"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/10 text-red-400 transition-colors hover:bg-red-500/10"
          >
            <Ban className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

function ClasesGrid({ clases, enCursoIds = new Set(), proximaClaseId = null, onVerInscriptos, onEditar, onCancelar }) {
  if (clases.length === 0) {
    return (
      <div className="rounded-xl border border-white/5 bg-greenfit-card p-10 text-center text-sm text-gray-400">
        No hay clases programadas para este día.
      </div>
    )
  }

  const hayDestacada = enCursoIds.size > 0 || proximaClaseId != null

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {clases.map((clase) => {
        const estado = enCursoIds.has(clase.id) ? 'en_curso' : clase.id === proximaClaseId ? 'proxima' : null
        return (
          <ClaseCard
            key={clase.id}
            clase={clase}
            estado={estado}
            hayDestacada={hayDestacada}
            onVerInscriptos={onVerInscriptos}
            onEditar={onEditar}
            onCancelar={onCancelar}
          />
        )
      })}
    </div>
  )
}

export default ClasesGrid
