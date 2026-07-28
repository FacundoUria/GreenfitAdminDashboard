import { LogOut } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/useAuth'

function Header({ title = 'Panel de administración' }) {
  const { usuario, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const iniciales = (usuario?.nombre ?? '?').charAt(0).toUpperCase()

  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/5 bg-greenfit-dark px-6">
      <h1 className="text-lg font-semibold text-white">{title}</h1>

      <div className="flex items-center gap-3">
        <div className="text-right">
          <p className="text-sm font-medium text-white">{usuario?.nombre}</p>
          <p className="text-xs text-gray-400">{usuario?.rol}</p>
        </div>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-greenfit-primary text-sm font-semibold text-greenfit-dark">
          {iniciales}
        </div>
        <button
          type="button"
          onClick={handleLogout}
          title="Cerrar sesión"
          className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  )
}

export default Header
