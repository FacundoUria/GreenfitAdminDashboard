import { useState } from 'react'
import { X } from 'lucide-react'

const disciplinas = ['Crossfit', 'Musculación', 'Yoga', 'Funcional']
const dias = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']

function formInicial(clase, diaPorDefecto) {
  if (clase) {
    return {
      disciplina: clase.disciplina,
      profesor: clase.profesor,
      dia: clase.dia,
      horaInicio: clase.horaInicio,
      horaFin: clase.horaFin,
      cupoMaximo: clase.cupoMaximo,
    }
  }

  return {
    disciplina: disciplinas[0],
    profesor: '',
    dia: diaPorDefecto,
    horaInicio: '09:00',
    horaFin: '10:00',
    cupoMaximo: 20,
  }
}

function NuevaClaseModal({ clase, diaPorDefecto, onClose, onSave }) {
  const [form, setForm] = useState(() => formInicial(clase, diaPorDefecto))

  const handleChange = (field) => (event) => {
    const value = field === 'cupoMaximo' ? Number(event.target.value) : event.target.value
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    onSave(form)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl bg-greenfit-card p-6 shadow-xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">
            {clase ? 'Editar Clase' : 'Nueva Clase'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="disciplina" className="text-xs font-medium text-gray-400">
              Disciplina
            </label>
            <select
              id="disciplina"
              value={form.disciplina}
              onChange={handleChange('disciplina')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
            >
              {disciplinas.map((disciplina) => (
                <option key={disciplina} value={disciplina}>
                  {disciplina}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="profesor" className="text-xs font-medium text-gray-400">
              Profesor
            </label>
            <input
              id="profesor"
              type="text"
              required
              value={form.profesor}
              onChange={handleChange('profesor')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="dia" className="text-xs font-medium text-gray-400">
              Día
            </label>
            <select
              id="dia"
              value={form.dia}
              onChange={handleChange('dia')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
            >
              {dias.map((dia) => (
                <option key={dia} value={dia}>
                  {dia}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="cupoMaximo" className="text-xs font-medium text-gray-400">
              Cupo máximo
            </label>
            <input
              id="cupoMaximo"
              type="number"
              min="1"
              required
              value={form.cupoMaximo}
              onChange={handleChange('cupoMaximo')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="horaInicio" className="text-xs font-medium text-gray-400">
              Hora inicio
            </label>
            <input
              id="horaInicio"
              type="time"
              required
              value={form.horaInicio}
              onChange={handleChange('horaInicio')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="horaFin" className="text-xs font-medium text-gray-400">
              Hora fin
            </label>
            <input
              id="horaFin"
              type="time"
              required
              value={form.horaFin}
              onChange={handleChange('horaFin')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="mt-2 flex justify-end gap-3 sm:col-span-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
            >
              Guardar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default NuevaClaseModal
