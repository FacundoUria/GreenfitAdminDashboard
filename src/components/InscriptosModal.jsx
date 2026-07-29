import { UserCheck, UserX, X } from 'lucide-react'
import { DIAS_SEMANA } from '../utils/clases'

function iniciales(nombre, apellido) {
  return `${nombre.charAt(0)}${apellido.charAt(0)}`.toUpperCase()
}

function nombresDias(diasSemana) {
  return DIAS_SEMANA.filter((d) => diasSemana.includes(d.numero))
    .map((d) => d.nombre)
    .join(', ')
}

function InscriptosModal({ open, clase, onClose, onMarcarAsistencia }) {
  if (!open || !clase) return null

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
                      {iniciales(inscripto.nombre, inscripto.apellido)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">
                        {inscripto.nombre} {inscripto.apellido}
                      </p>
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
