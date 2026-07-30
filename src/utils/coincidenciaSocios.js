// Normaliza nombres para comparar tolerando mayusculas, acentos y espacios
// repetidos -- sin esto "Jose Perez" y "jose  perez" nunca matchean.
function normalizarTexto(texto) {
  return (texto ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

function distanciaLevenshtein(a, b) {
  const filas = a.length + 1
  const columnas = b.length + 1
  const dp = Array.from({ length: filas }, () => new Array(columnas).fill(0))
  for (let i = 0; i < filas; i += 1) dp[i][0] = i
  for (let j = 0; j < columnas; j += 1) dp[0][j] = j
  for (let i = 1; i < filas; i += 1) {
    for (let j = 1; j < columnas; j += 1) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[filas - 1][columnas - 1]
}

// Busca en `socios` a alguien con nombre+apellido idéntico o a un par de
// letras de diferencia (typo/tilde) -- el umbral tolerado crece con el largo
// del nombre para no marcar como "similar" nombres cortos que en realidad
// son personas distintas (ej: "Ana Paz" vs "Ana Ríos").
export function buscarCoincidenciaPorNombre(socios, nombre, apellido, { excluirId } = {}) {
  const objetivo = normalizarTexto(`${nombre} ${apellido}`)
  if (objetivo.length < 5) return null

  let mejor = null
  let mejorDistancia = Infinity

  for (const candidato of socios) {
    if (excluirId != null && candidato.id === excluirId) continue
    const nombreCandidato = normalizarTexto(`${candidato.nombre} ${candidato.apellido}`)
    if (!nombreCandidato) continue

    const distancia = nombreCandidato === objetivo ? 0 : distanciaLevenshtein(objetivo, nombreCandidato)
    const umbral = nombreCandidato.length >= 10 ? 2 : 1
    if (distancia <= umbral && distancia < mejorDistancia) {
      mejor = candidato
      mejorDistancia = distancia
    }
  }

  return mejor
}

export { normalizarTexto }
