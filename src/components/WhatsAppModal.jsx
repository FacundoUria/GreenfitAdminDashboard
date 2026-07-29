import { useState } from 'react'
import { CheckCircle2, MessageCircle, Send, X } from 'lucide-react'
import { PLANTILLAS_WHATSAPP, construirLinkWhatsapp, reemplazarVariables } from '../utils/whatsapp'

const PRESETS = [
  { value: 'vencida', label: 'Cuota Vencida' },
  { value: 'reactivacion', label: 'Reactivación / Inactivo' },
  { value: 'personalizado', label: 'Personalizado' },
]

function iniciales(nombre, apellido) {
  return `${(nombre ?? '?').charAt(0)}${(apellido ?? '').charAt(0)}`.toUpperCase()
}

function WhatsAppModal({ socios, presetInicial, onClose }) {
  const [preset, setPreset] = useState(presetInicial ?? 'vencida')
  const [mensajePersonalizado, setMensajePersonalizado] = useState(
    '¡Hola {nombre}! Te escribimos desde GreenFit para...',
  )
  const [enviados, setEnviados] = useState(new Set())

  const plantilla = preset === 'personalizado' ? mensajePersonalizado : PLANTILLAS_WHATSAPP[preset]

  const handleEnviar = (socio) => {
    const mensaje = reemplazarVariables(plantilla, socio)
    const link = construirLinkWhatsapp(socio.telefono, mensaje)

    if (!link) {
      window.alert(`${socio.nombre} ${socio.apellido} no tiene un teléfono cargado.`)
      return
    }

    window.open(link, '_blank', 'noopener,noreferrer')
    setEnviados((prev) => new Set(prev).add(socio.id))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl bg-greenfit-card p-5 shadow-xl sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <MessageCircle className="h-5 w-5 text-[#25D366]" />
            Enviar WhatsApp {socios.length > 1 ? `(${socios.length} socios)` : ''}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setPreset(p.value)}
              className={`min-h-[44px] rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                preset === p.value
                  ? 'bg-greenfit-primary text-greenfit-dark'
                  : 'border border-white/10 text-gray-300 hover:bg-white/5 hover:text-white'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === 'personalizado' ? (
          <textarea
            rows={7}
            value={mensajePersonalizado}
            onChange={(event) => setMensajePersonalizado(event.target.value)}
            placeholder="Escribí tu mensaje. Podés usar {nombre} para personalizarlo."
            className="mb-4 w-full min-h-[160px] resize-y rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm leading-relaxed text-white outline-none placeholder:text-gray-600 focus:border-greenfit-primary"
          />
        ) : (
          <div className="mb-4 rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-gray-300">
            {reemplazarVariables(plantilla, socios[0] ?? { nombre: '...' })}
          </div>
        )}

        <p className="mb-2 text-xs font-medium text-gray-400">
          {socios.length === 1 ? 'Destinatario' : `Destinatarios (${socios.length})`}
        </p>

        <div className="flex-1 overflow-y-auto rounded-lg border border-white/5">
          <ul className="divide-y divide-white/5">
            {socios.map((socio) => {
              const yaEnviado = enviados.has(socio.id)
              const sinTelefono = !socio.telefono
              return (
                <li key={socio.id} className="flex items-center justify-between gap-2 px-3 py-2 sm:gap-3 sm:px-4 sm:py-2.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-greenfit-primary/15 text-xs font-semibold text-greenfit-primary">
                      {iniciales(socio.nombre, socio.apellido)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm text-white">
                        {socio.nombre} {socio.apellido}
                      </p>
                      {sinTelefono && <p className="text-xs text-red-400">Sin teléfono cargado</p>}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleEnviar(socio)}
                    disabled={sinTelefono}
                    className={`flex h-10 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      yaEnviado
                        ? 'bg-white/5 text-gray-400'
                        : 'bg-[#25D366]/15 text-[#25D366] hover:bg-[#25D366]/25'
                    }`}
                  >
                    {yaEnviado ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Enviado
                      </>
                    ) : (
                      <>
                        <Send className="h-3.5 w-3.5" />
                        Enviar
                      </>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-[44px] w-full items-center justify-center rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white sm:w-auto"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}

export default WhatsAppModal
