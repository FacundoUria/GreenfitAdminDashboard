import { useCallback, useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  Home,
  Users,
  Dumbbell,
  BarChart3,
  NotebookPen,
  Megaphone,
  Settings,
  ExternalLink,
  X,
  ClipboardList,
  Tags,
  MessageCircle,
  Receipt,
} from 'lucide-react'
import logo from '../assets/logo.jpg'
import { supabase } from '../lib/supabaseClient'
import { fetchCountComprobantesPendientes } from '../utils/pagosSocio'

const navItems = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/socios', label: 'Socios', icon: Users },
  { to: '/pagos', label: 'Pagos', icon: Receipt, badgeKey: 'pagosPendientes' },
  { to: '/clases', label: 'Clases', icon: Dumbbell },
  { to: '/disciplinas', label: 'Disciplinas', icon: Tags },
  { to: '/rutinas', label: 'Rutinas', icon: ClipboardList },
  { to: '/reportes', label: 'Reportes', icon: BarChart3 },
  { to: '/notas', label: 'Notas', icon: NotebookPen },
  { to: '/anunciar', label: 'Anunciar', icon: Megaphone },
  { to: '/configuracion', label: 'Configuración', icon: Settings },
  { to: '/comunidad', label: 'Comunidad', icon: MessageCircle },
]

function Sidebar({ abierto = false, onCerrar = () => {} }) {
  // Cantidad de comprobantes de transferencia pendientes de revisión
  // (Fase 3, pantalla "Pagos") -- vive acá (no en la propia página) para
  // que el número sea visible en el menú sin tener que entrar a Pagos.
  const [pagosPendientes, setPagosPendientes] = useState(0)

  const cargarPagosPendientes = useCallback(async () => {
    try {
      setPagosPendientes(await fetchCountComprobantesPendientes())
    } catch (err) {
      // Best-effort -- un badge que no carga no debe romper la navegación
      // del panel entero.
      console.error('No se pudo cargar la cantidad de pagos pendientes:', err.message)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarPagosPendientes()
  }, [cargarPagosPendientes])

  // Refresco en vivo -- mismo patrón que ActividadReciente.jsx/Pagos.jsx:
  // un comprobante nuevo del socio, o Seba aprobando/rechazando uno (acá o
  // desde otra pestaña), actualiza el numerito sin recargar la página.
  useEffect(() => {
    const channel = supabase
      .channel('sidebar-pagos-pendientes-badge')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pagos_socio' }, () => {
        cargarPagosPendientes()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [cargarPagosPendientes])

  const badgesPorKey = { pagosPendientes }
  return (
    <>
      {abierto && (
        <div
          onClick={onCerrar}
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-dvh w-72 max-w-[85vw] shrink-0 flex-col justify-between overflow-y-auto border-r border-white/5 bg-greenfit-card px-4 py-7 transition-transform duration-300 ease-in-out lg:static lg:z-auto lg:w-64 lg:max-w-none lg:translate-x-0 ${
          abierto ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div>
          <div className="mb-8 flex items-center justify-between px-2 lg:justify-center">
            <img src={logo} alt="Greenfit" className="h-20 w-auto object-contain mix-blend-screen lg:h-24" />
            <button
              type="button"
              onClick={onCerrar}
              aria-label="Cerrar menú"
              className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white lg:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <p className="mb-3 px-4 text-xs font-semibold uppercase tracking-wider text-gray-500">Menú</p>

          <nav className="flex flex-col gap-2">
            {navItems.map(({ to, label, icon: Icon, end, badgeKey }) => {
              const badge = badgeKey ? badgesPorKey[badgeKey] : 0
              return (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  onClick={onCerrar}
                  className={({ isActive }) =>
                    `group relative flex items-center gap-3.5 rounded-xl px-4 py-3.5 text-[15px] font-medium transition-all ${
                      isActive
                        ? 'bg-white/5 text-white'
                        : 'text-gray-400 hover:bg-white/5 hover:text-white'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={`absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-[#22c55e] transition-opacity ${
                          isActive ? 'opacity-100' : 'opacity-0'
                        }`}
                      />
                      <Icon
                        className={`h-5 w-5 transition-colors ${
                          isActive ? 'text-[#22c55e]' : 'text-gray-500 group-hover:text-[#22c55e]'
                        }`}
                      />
                      <span className="flex-1">{label}</span>
                      {badge > 0 && (
                        <span
                          aria-label={`${badge} pendientes`}
                          className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white"
                        >
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              )
            })}
          </nav>
        </div>

        <a
          href="https://greenfit.fit"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3.5 rounded-xl px-4 py-3.5 text-[15px] font-medium text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
        >
          <ExternalLink className="h-5 w-5 text-gray-500" />
          greenfit.fit
        </a>
      </aside>
    </>
  )
}

export default Sidebar
