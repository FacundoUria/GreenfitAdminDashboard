import { NavLink } from 'react-router-dom'
import { Home, Users, Dumbbell, BarChart3, Settings, ExternalLink } from 'lucide-react'
import logo from '../assets/logo.jpg'

const navItems = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/socios', label: 'Socios', icon: Users },
  { to: '/clases', label: 'Clases', icon: Dumbbell },
  { to: '/reportes', label: 'Reportes', icon: BarChart3 },
  { to: '/configuracion', label: 'Configuración', icon: Settings },
]

function Sidebar() {
  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col justify-between border-r border-white/5 bg-greenfit-card px-4 py-7">
      <div>
        <div className="mb-8 flex items-center justify-center px-2">
          <img src={logo} alt="Greenfit" className="h-24 w-auto object-contain mix-blend-screen" />
        </div>

        <p className="mb-3 px-4 text-xs font-semibold uppercase tracking-wider text-gray-500">Menú</p>

        <nav className="flex flex-col gap-2">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
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
                  {label}
                </>
              )}
            </NavLink>
          ))}
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
  )
}

export default Sidebar
