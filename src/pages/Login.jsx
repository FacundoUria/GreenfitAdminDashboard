import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Leaf } from 'lucide-react'
import { useAuth } from '../context/useAuth'

function Login() {
  const { usuario, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [form, setForm] = useState({ usuario: '', clave: '' })
  const [error, setError] = useState(null)

  if (usuario) {
    return <Navigate to={location.state?.from ?? '/'} replace />
  }

  const handleChange = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }))
  }

  const handleSubmit = (event) => {
    event.preventDefault()

    const exito = login(form.usuario, form.clave)
    if (!exito) {
      setError('Usuario o contraseña incorrectos.')
      return
    }

    navigate(location.state?.from ?? '/', { replace: true })
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-greenfit-dark px-4">
      <div className="w-full max-w-sm rounded-xl border border-white/5 bg-greenfit-card p-8">
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-greenfit-primary">
            <Leaf className="h-7 w-7 text-greenfit-dark" />
          </div>
          <h1 className="text-lg font-semibold text-white">Greenfit</h1>
          <p className="text-sm text-gray-400">Panel de administración</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="usuario" className="text-xs font-medium text-gray-400">
              Usuario
            </label>
            <input
              id="usuario"
              type="text"
              required
              autoFocus
              value={form.usuario}
              onChange={handleChange('usuario')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="clave" className="text-xs font-medium text-gray-400">
              Contraseña
            </label>
            <input
              id="clave"
              type="password"
              required
              value={form.clave}
              onChange={handleChange('clave')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            className="mt-2 rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
          >
            Ingresar
          </button>
        </form>
      </div>
    </div>
  )
}

export default Login
