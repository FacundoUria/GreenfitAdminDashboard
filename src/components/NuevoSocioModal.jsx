import { useState } from 'react'
import { X } from 'lucide-react'

const planes = ['Musculación', 'Crossfit', 'Pase Libre']

const emptyForm = {
  nombre: '',
  apellido: '',
  dni: '',
  email: '',
  telefono: '',
  plan: planes[0],
  fechaInicio: '',
}

function NuevoSocioModal({ open, onClose, onSave }) {
  const [form, setForm] = useState(emptyForm)

  if (!open) return null

  const handleChange = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }))
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    onSave(form)
    setForm(emptyForm)
  }

  const handleCancel = () => {
    setForm(emptyForm)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl bg-greenfit-card p-6 shadow-xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Nuevo Socio</h2>
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
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
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
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
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
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
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
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
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
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
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="plan" className="text-xs font-medium text-gray-400">
              Plan
            </label>
            <select
              id="plan"
              value={form.plan}
              onChange={handleChange('plan')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
            >
              {planes.map((plan) => (
                <option key={plan} value={plan}>
                  {plan}
                </option>
              ))}
            </select>
          </div>

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
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="mt-2 flex justify-end gap-3 sm:col-span-2">
            <button
              type="button"
              onClick={handleCancel}
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

export default NuevoSocioModal
