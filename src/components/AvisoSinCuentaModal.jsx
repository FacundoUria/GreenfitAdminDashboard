import { AlertTriangle } from 'lucide-react'

// T5 -- aviso al cobrar (o dar de alta) a un socio sin cuenta en la app.
// Reemplaza al toast "Pago registrado correctamente" (2,5 s) para ese caso:
// queda en pantalla hasta que Seba lo cierra con "Entendido" (D-T5b), porque
// le pide hacer algo después (cargarle los créditos cuando tenga cuenta).
// `aviso` sale de avisoSinCuenta() (utils/avisoSinCuenta.js).
function AvisoSinCuentaModal({ aviso, onCerrar }) {
  if (!aviso) return null
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="aviso-sin-cuenta-titulo"
        aria-describedby="aviso-sin-cuenta-mensaje"
        className="w-full max-w-md rounded-xl bg-greenfit-card p-5 shadow-xl ring-1 ring-amber-400/30"
      >
        <div className="mb-3 flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
          <h2 id="aviso-sin-cuenta-titulo" className="text-base font-semibold text-white">
            {aviso.titulo}
          </h2>
        </div>
        <p id="aviso-sin-cuenta-mensaje" className="text-sm text-gray-200">
          {aviso.mensaje}
        </p>
        {aviso.detalle && <p className="mt-3 rounded-lg bg-white/5 px-3 py-2 text-sm text-white">{aviso.detalle}</p>}
        {aviso.extra && <p className="mt-3 text-sm text-amber-300">{aviso.extra}</p>}
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            autoFocus
            onClick={onCerrar}
            className="min-h-[44px] rounded-lg bg-greenfit-primary px-5 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  )
}

export default AvisoSinCuentaModal
