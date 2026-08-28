import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Leaf } from 'lucide-react'
import { useAuth } from '../context/useAuth'

function Login() {
  const { usuario, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [form, setForm] = useState({ email: '', clave: '' })
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)

  if (usuario) {
    return <Navigate to={location.state?.from ?? '/'} replace />
  }

  const handleChange = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError(null)
    setEnviando(true)

    const exito = await login(form.email, form.clave)
    setEnviando(false)

    if (!exito) {
      setError('Email o contraseña incorrectos.')
      return
    }

    navigate(location.state?.from ?? '/', { replace: true })
  }

  return (
    // min-h-dvh (no min-h-screen) -- mismo motivo que Layout.jsx: en
    // tablet/mobile, 100vh no descuenta el teclado virtual al abrirse, dvh sí.
    <div className="flex min-h-dvh items-center justify-center bg-greenfit-dark px-4">
      <div className="w-full max-w-sm rounded-xl border border-white/5 bg-greenfit-card p-6 sm:p-8">
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-greenfit-primary">
            <Leaf className="h-7 w-7 text-greenfit-dark" />
          </div>
          <h1 className="text-lg font-semibold text-white">Greenfit</h1>
          <p className="text-sm text-gray-400">Panel de administración</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-xs font-medium text-gray-400">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoFocus
              value={form.email}
              onChange={handleChange('email')}
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
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
              className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2.5 text-sm text-white outline-none focus:border-greenfit-primary"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={enviando}
            className="mt-2 flex min-h-[44px] items-center justify-center rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {enviando ? 'Ingresando...' : 'Ingresar'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default Login
