const STORAGE_KEY = 'greenfit_notas'

export function leerNotas() {
  try {
    const guardado = localStorage.getItem(STORAGE_KEY)
    return guardado ? JSON.parse(guardado) : []
  } catch {
    return []
  }
}

export function guardarNotas(notas) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notas))
  } catch (error) {
    console.error('No se pudieron guardar las notas en localStorage:', error.message)
  }
}

export function crearNota({ titulo, detalle, fechaAlerta }) {
  return {
    id: crypto.randomUUID(),
    titulo,
    detalle: detalle ?? '',
    fechaAlerta: fechaAlerta || null,
    estado: 'pendiente',
    alertada: false,
    creadaEn: new Date().toISOString(),
  }
}
