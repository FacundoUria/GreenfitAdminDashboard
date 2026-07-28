import { useEffect } from 'react'
import { BellRing, X } from 'lucide-react'
import { useNotas } from '../context/useNotas'

const DURACION_MS = 12000

function RecordatorioToast() {
  const { notaEnAlerta, descartarAlerta } = useNotas()

  useEffect(() => {
    if (!notaEnAlerta) return undefined

    const timeout = setTimeout(descartarAlerta, DURACION_MS)
    return () => clearTimeout(timeout)
  }, [notaEnAlerta, descartarAlerta])

  if (!notaEnAlerta) return null

  return (
    <div className="fixed bottom-6 right-6 z-[100] flex max-w-sm items-start gap-3 rounded-xl border border-amber-500/30 bg-greenfit-card px-5 py-4 shadow-2xl">
      <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
      <div>
        <p className="text-sm font-semibold text-white">⏰ Recordatorio</p>
        <p className="text-sm text-gray-300">{notaEnAlerta.titulo}</p>
      </div>
      <button
        type="button"
        onClick={descartarAlerta}
        className="ml-2 shrink-0 text-gray-500 transition-colors hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

export default RecordatorioToast
