import { NavLink } from 'react-router-dom'
import { Home, Users, Dumbbell, BarChart3, Settings, ExternalLink, Leaf } from 'lucide-react'

const navItems = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/socios', label: 'Socios', icon: Users },
  { to: '/clases', label: 'Clases', icon: Dumbbell },
  { to: '/reportes', label: 'Reportes', icon: BarChart3 },
  { to: '/configuracion', label: 'Configuración', icon: Settings },
]

function Sidebar() {
  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col justify-between border-r border-white/5 bg-greenfit-card px-4 py-6">
      <div>
        <div className="mb-8 flex items-center gap-2 px-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-greenfit-primary">
            <Leaf className="h-5 w-5 text-greenfit-dark" />
          </div>
          <span className="text-lg font-semibold text-white">Greenfit</span>
        </div>

        <nav className="flex flex-col gap-1">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-greenfit-primary text-greenfit-dark'
                    : 'text-gray-300 hover:bg-white/5 hover:text-white'
                }`
              }
            >
              <Icon className="h-5 w-5" />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>

      <a
        href="https://greenfit.fit"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
      >
        <ExternalLink className="h-5 w-5" />
        greenfit.fit
      </a>
    </aside>
  )
}

export default Sidebar
