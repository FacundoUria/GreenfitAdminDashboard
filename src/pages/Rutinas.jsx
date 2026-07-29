import { useState } from 'react'
import { ClipboardList, Library, UserCog } from 'lucide-react'
import BibliotecaRutinas from '../components/rutinas/BibliotecaRutinas'
import AsignacionSocios from '../components/rutinas/AsignacionSocios'

const TABS = [
  { value: 'biblioteca', label: 'Biblioteca de Ejercicios y Plantillas', icon: Library },
  { value: 'asignacion', label: 'Asignación a Socios', icon: UserCog },
]

function Rutinas() {
  const [tab, setTab] = useState('biblioteca')

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-greenfit-primary/15">
          <ClipboardList className="h-5 w-5 text-greenfit-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">Rutinas</h2>
          <p className="text-sm text-gray-400">Plantillas de entrenamiento y asignación a socios.</p>
        </div>
      </div>

      <div className="flex gap-2 border-b border-white/5">
        {TABS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`flex min-h-[44px] items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors ${
              tab === value
                ? 'border-greenfit-primary text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'biblioteca' ? <BibliotecaRutinas /> : <AsignacionSocios />}
    </div>
  )
}

export default Rutinas
