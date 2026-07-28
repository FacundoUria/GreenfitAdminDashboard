import { Ban, Clock, Eye, Pencil, Users } from 'lucide-react'
import { colorOcupacion } from '../utils/ocupacion'

function ClaseCard({ clase, onVerInscriptos, onEditar, onCancelar }) {
  const inscriptos = clase.inscriptos.length
  const porcentaje = Math.min(100, Math.round((inscriptos / clase.cupoMaximo) * 100))
  const { barra, texto } = colorOcupacion(porcentaje)

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-white/5 bg-greenfit-card p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-base font-semibold text-white">{clase.disciplina}</p>
          <p className="text-sm text-gray-400">Prof. {clase.profesor}</p>
        </div>
        <span className="flex items-center gap-1.5 text-sm text-gray-300">
          <Clock className="h-4 w-4 text-gray-500" />
          {clase.horaInicio} - {clase.horaFin}
        </span>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="flex items-center gap-1 text-gray-400">
            <Users className="h-3.5 w-3.5" />
            {inscriptos} / {clase.cupoMaximo} inscriptos
          </span>
          <span className={`font-medium ${texto}`}>{porcentaje}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full rounded-full ${barra} transition-all`}
            style={{ width: `${porcentaje}%` }}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-white/5 pt-3">
        <button
          type="button"
          onClick={() => onVerInscriptos(clase)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
        >
          <Eye className="h-3.5 w-3.5" />
          Ver Inscriptos
        </button>
        <button
          type="button"
          onClick={() => onEditar(clase)}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onCancelar(clase)}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10"
        >
          <Ban className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

function ClasesGrid({ clases, onVerInscriptos, onEditar, onCancelar }) {
  if (clases.length === 0) {
    return (
      <div className="rounded-xl border border-white/5 bg-greenfit-card p-10 text-center text-sm text-gray-400">
        No hay clases programadas para este día.
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {clases.map((clase) => (
        <ClaseCard
          key={clase.id}
          clase={clase}
          onVerInscriptos={onVerInscriptos}
          onEditar={onEditar}
          onCancelar={onCancelar}
        />
      ))}
    </div>
  )
}

export default ClasesGrid
