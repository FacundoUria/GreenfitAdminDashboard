import { useEffect, useRef, useState } from 'react'
import { NotasContext } from './notasContextBase'
import { crearNota, guardarNotas, leerNotas } from '../utils/notas'

// Cada cuánto se revisan las notas pendientes para disparar la alerta in-app.
const INTERVALO_REVISION_MS = 15000

export function NotasProvider({ children }) {
  const [notas, setNotas] = useState(leerNotas)
  const [notaEnAlerta, setNotaEnAlerta] = useState(null)

  // Para leer el valor más reciente de `notas` desde el interval sin tener
  // que recrearlo (y su timer) cada vez que cambian las notas.
  const notasRef = useRef(notas)

  useEffect(() => {
    notasRef.current = notas
    guardarNotas(notas)
  }, [notas])

  useEffect(() => {
    const intervalo = setInterval(() => {
      const ahora = Date.now()
      const pendienteVencida = notasRef.current.find(
        (nota) =>
          nota.estado === 'pendiente' &&
          nota.fechaAlerta &&
          !nota.alertada &&
          new Date(nota.fechaAlerta).getTime() <= ahora,
      )

      if (!pendienteVencida) return

      setNotas((prev) => prev.map((n) => (n.id === pendienteVencida.id ? { ...n, alertada: true } : n)))
      setNotaEnAlerta(pendienteVencida)
    }, INTERVALO_REVISION_MS)

    return () => clearInterval(intervalo)
  }, [])

  const agregarNota = (datos) => {
    setNotas((prev) => [crearNota(datos), ...prev])
  }

  const actualizarNota = (id, cambios) => {
    setNotas((prev) => prev.map((n) => (n.id === id ? { ...n, ...cambios } : n)))
  }

  const eliminarNota = (id) => {
    setNotas((prev) => prev.filter((n) => n.id !== id))
  }

  const descartarAlerta = () => setNotaEnAlerta(null)

  return (
    <NotasContext.Provider
      value={{ notas, agregarNota, actualizarNota, eliminarNota, notaEnAlerta, descartarAlerta }}
    >
      {children}
    </NotasContext.Provider>
  )
}
