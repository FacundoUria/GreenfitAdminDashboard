// Lógica PURA del buscador de "Ver inscriptos" (InscriptosModal.jsx): sin red,
// sin React -- se prueba aparte (buscarSocios.test.js).

// Minúsculas, sin tildes ni diacríticos y con espacios colapsados -- "Ríos",
// "RIOS" y "rios" son lo mismo para el buscador.
export function normalizarTexto(texto) {
  return (texto ?? '')
    .toString()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function soloDigitos(texto) {
  return (texto ?? '').toString().replace(/\D/g, '')
}

// "Parece un DNI": solo dígitos, puntos y espacios ("44.537.978", "44537978",
// "44 537 978"). Es lo que decide si Enter / "Anotar" usa el camino de siempre
// (buscar por DNI exacto contra la base).
export function pareceDni(texto) {
  const limpio = (texto ?? '').toString().trim()
  return /^[\d.\s]+$/.test(limpio) && soloDigitos(limpio).length > 0
}

// Filtra socios ({ id, full_name, dni }) por DNI, nombre o apellido, en
// memoria. Cada palabra de la consulta tiene que aparecer: si es numérica
// (con o sin puntos) se compara contra el DNI; si no, contra el nombre
// completo. Así "rios mar", "MARTINA", "30.111" y "3011" funcionan igual.
// Orden: primero los que EMPIEZAN con la primera palabra, después alfabético.
export function filtrarSocios(socios, consulta) {
  const q = normalizarTexto(consulta)
  if (!q) return []
  const palabras = q.split(' ')

  const coinciden = (socios ?? []).filter((socio) => {
    const nombre = normalizarTexto(socio.full_name)
    const dni = soloDigitos(socio.dni)
    return palabras.every((palabra) => {
      if (/^[\d.]+$/.test(palabra)) return dni.includes(soloDigitos(palabra))
      return nombre.includes(palabra)
    })
  })

  const primera = palabras[0]
  const puntaje = (socio) => {
    if (/^[\d.]+$/.test(primera)) return soloDigitos(socio.dni).startsWith(soloDigitos(primera)) ? 0 : 1
    const nombre = normalizarTexto(socio.full_name)
    return nombre.startsWith(primera) || nombre.split(' ').some((parte) => parte.startsWith(primera)) ? 0 : 1
  }

  return coinciden
    .map((socio) => ({ socio, puntaje: puntaje(socio), clave: normalizarTexto(socio.full_name) }))
    .sort((a, b) => a.puntaje - b.puntaje || a.clave.localeCompare(b.clave))
    .map(({ socio }) => socio)
}

// Traduce el error del RPC admin_book_class a un mensaje claro. SOLO el caso
// "ya está anotado" (restricción única de bookings, sin mensaje propio en el
// RPC) se reescribe; TODO lo demás (sin créditos, sin cupo, clase cancelada,
// día que no se dicta, plan vencido, sin permisos) conserva el texto real del
// backend, igual que antes.
export function mensajeErrorAnotar(rpcError, nombre) {
  const texto = rpcError?.message ?? ''
  const esDuplicado =
    rpcError?.code === '23505' ||
    /duplicate key/i.test(texto) ||
    /bookings_user_id_class_id_booking_date/i.test(texto)
  if (esDuplicado) return `Ya anotado: ${nombre || 'el socio'} ya está en esta clase.`
  return `No se pudo anotar al socio: ${texto}`
}
