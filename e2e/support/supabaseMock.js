// Backend 100% mockeado a nivel de red -- ningún test E2E de esta suite
// toca la Supabase real de producción. VITE_SUPABASE_URL del modo "e2e"
// (.env.e2e) apunta a este dominio FALSO a propósito: cualquier request
// que se escape sin interceptar falla por DNS en vez de pegarle en
// silencio a producción -- mismo criterio de seguridad que "fail closed,
// no fail open" (mismo patrón que greenfit-app/e2e/support/supabaseMock.ts,
// dos repos separados sin paquete compartido entre sí).
export const SUPABASE_URL = 'https://e2e-mock.supabase.co'
const SUPABASE_HOST = new URL(SUPABASE_URL).hostname

function fakeSession(user) {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    access_token: `e2e-access-token-${user.id}`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: nowSec + 3600,
    refresh_token: `e2e-refresh-token-${user.id}`,
    user: {
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      app_metadata: { provider: 'email' },
      user_metadata: {},
      created_at: user.createdAt ?? '2025-01-15T00:00:00.000Z',
    },
  }
}

function mockProfileRow(user) {
  return {
    id: user.id,
    full_name: user.fullName,
    dni: user.dni ?? null,
    role: 'admin',
    active: true,
    avatar_url: null,
    created_at: user.createdAt ?? '2025-01-15T00:00:00.000Z',
  }
}

// Filtrado real y básico estilo PostgREST (?columna=operador.valor) -- ver
// el comentario largo en la versión de greenfit-app, mismo criterio acá.
function aplicarFiltros(filas, searchParams) {
  let resultado = filas
  for (const [columna, valorCrudo] of searchParams.entries()) {
    if (['select', 'order', 'limit', 'offset', 'columns'].includes(columna)) continue
    const separador = valorCrudo.indexOf('.')
    if (separador === -1) continue
    const operador = valorCrudo.slice(0, separador)
    const valor = valorCrudo.slice(separador + 1)

    if (operador === 'eq') {
      resultado = resultado.filter((fila) => String(fila[columna]) === valor)
    } else if (operador === 'is' && valor === 'null') {
      resultado = resultado.filter((fila) => fila[columna] === null || fila[columna] === undefined)
    } else if (operador === 'in') {
      const valores = valor
        .replace(/^\(|\)$/g, '')
        .split(',')
        .map((v) => v.replace(/^"|"$/g, ''))
      resultado = resultado.filter((fila) => valores.includes(String(fila[columna])))
    } else if (operador === 'gte') {
      resultado = resultado.filter((fila) => fila[columna] >= valor)
    } else if (operador === 'lte') {
      resultado = resultado.filter((fila) => fila[columna] <= valor)
    } else if (operador === 'ilike') {
      // Sin este operador, un .ilike(...).maybeSingle() con >1 fila en la
      // fixture (ej: resolverDisciplinaId contra 2 disciplinas) le llega
      // al cliente SIN filtrar -- supabase-js rechaza maybeSingle() con
      // más de una fila y la resuelve como null/error en vez de tirar el
      // objeto esperado. `%`/`_` son los wildcards de PostgREST.
      const patron = valor
        .replace(/([.+^${}()|[\]\\])/g, '\\$1')
        .replace(/%/g, '.*')
        .replace(/_/g, '.')
      const regex = new RegExp(`^${patron}$`, 'i')
      resultado = resultado.filter((fila) => regex.test(String(fila[columna] ?? '')))
    }
  }
  return resultado
}

async function responderJson(route, status, body, headers = {}) {
  await route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) })
}

// PNG transparente de 1x1 -- placeholder mínimo válido para cualquier GET a
// Storage (avatares), así el <img> del lado del cliente carga de verdad.
const PNG_1X1_TRANSPARENTE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

// Intercepta TODO lo que el cliente supabase-js puede llamar (auth, REST,
// RPC) y responde con fixtures en memoria -- no hay base de datos real
// detrás. `tables`/`rpc` quedan MUTABLES (se devuelve la referencia) para
// que un test pueda simular una acción (ej: "Registrar Pago") agregando
// una fila a mitad de camino y volviendo a consultar.
export async function mockSupabase(page, { user, tables = {}, rpc = {}, functions = {} }) {
  // El profile del admin logueado SIEMPRE tiene que estar (lo necesita
  // AuthContext.fetchAdminProfile para no rebotar el login) -- se agrega
  // ADEMÁS de cualquier fixture de `profiles` que el test ya haya puesto
  // (ej: la ficha de un socio de prueba), nunca reemplazándola.
  const yaEstaba = (tables.profiles ?? []).some((p) => p.id === user.id)
  tables.profiles = yaEstaba ? tables.profiles : [mockProfileRow(user), ...(tables.profiles ?? [])]

  await page.route(
    (url) => url.hostname === SUPABASE_HOST,
    async (route) => {
      const request = route.request()
      const reqUrl = new URL(request.url())
      const method = request.method()
      const pathname = reqUrl.pathname

      if (pathname === '/auth/v1/token') {
        await responderJson(route, 200, fakeSession(user))
        return
      }
      if (pathname === '/auth/v1/user') {
        await responderJson(route, 200, fakeSession(user).user)
        return
      }
      if (pathname === '/auth/v1/logout') {
        await route.fulfill({ status: 204, body: '' })
        return
      }

      // Edge Functions (supabase.functions.invoke) -- mismo patrón que
      // `rpc`, pero bajo /functions/v1/<nombre> en vez de /rest/v1/rpc/.
      // Usado por Anunciar.jsx (`send-push`).
      if (pathname.startsWith('/functions/v1/')) {
        const fnName = pathname.replace('/functions/v1/', '')
        if (fnName in functions) {
          const value = typeof functions[fnName] === 'function' ? await functions[fnName](request) : functions[fnName]
          if (value && typeof value === 'object' && '__e2eError' in value) {
            await responderJson(route, value.__e2eError.status ?? 400, value.__e2eError.body ?? {})
          } else {
            await responderJson(route, 200, value ?? null)
          }
        } else {
          await responderJson(route, 404, { message: `[e2e mock] sin fixture para la function "${fnName}"` })
        }
        return
      }

      if (pathname.startsWith('/rest/v1/rpc/')) {
        const fnName = pathname.replace('/rest/v1/rpc/', '')
        if (fnName in rpc) {
          const value = typeof rpc[fnName] === 'function' ? await rpc[fnName](request) : rpc[fnName]
          // Convención para simular errores server-side (ej: 23505 de un
          // índice único violado) sin tener que ensuciar el dispatch
          // genérico -- una fixture de función puede devolver esta forma
          // en vez de un valor de éxito.
          if (value && typeof value === 'object' && '__e2eError' in value) {
            await responderJson(route, value.__e2eError.status ?? 400, value.__e2eError.body ?? {})
          } else {
            await responderJson(route, 200, value ?? null)
          }
        } else {
          await responderJson(route, 404, { code: 'PGRST202', message: 'function not found in schema cache' })
        }
        return
      }

      if (pathname.startsWith('/rest/v1/')) {
        const table = pathname.replace('/rest/v1/', '')

        if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
          const filas = tables[table] ?? (tables[table] = [])
          let insertadas = []
          if (method === 'POST') {
            try {
              const payload = request.postDataJSON()
              const nuevas = Array.isArray(payload) ? payload : [payload]
              const offsetInicial = filas.length
              insertadas = nuevas.map((fila, i) => {
                const nueva = { id: `e2e-${table}-${offsetInicial + i + 1}`, ...fila }
                filas.push(nueva)
                return nueva
              })
            } catch {
              // sin body parseable -- no hay nada que agregar al fixture.
            }
          } else if (method === 'PATCH') {
            // Update simplificado: aplica el body a TODAS las filas que
            // matchean el filtro de la URL (?id=eq.xxx, etc.) -- alcanza
            // para lo que esta suite necesita (una fila puntual por id).
            try {
              const payload = request.postDataJSON()
              const afectadas = aplicarFiltros(filas, reqUrl.searchParams)
              for (const fila of afectadas) Object.assign(fila, payload)
            } catch {
              // sin body parseable -- no aplica ningún cambio.
            }
          } else if (method === 'DELETE') {
            // Elimina del array en memoria las filas que matchean el filtro
            // de la URL (?id=eq.xxx, ?id=in.(a,b), etc.) -- antes esto era
            // un no-op (el DELETE "funcionaba" pero nunca borraba nada de
            // la fixture), lo que hubiera hecho pasar en falso cualquier
            // test que borre una fila y después verifique que ya no está.
            const aBorrar = new Set(aplicarFiltros(filas, reqUrl.searchParams).map((f) => f.id))
            const restantes = filas.filter((f) => !aBorrar.has(f.id))
            filas.length = 0
            filas.push(...restantes)
          }
          // Un INSERT con `.select()` espera de vuelta la(s) fila(s) recién
          // creada(s) -- no la tabla entera (PostgREST real hace lo mismo con
          // `Prefer: return=representation`). Con `.single()` además espera
          // UN objeto, no un array (mismo criterio que ya usa el branch de
          // GET más abajo con `esperaUnaSola`). UPDATE/DELETE se quedan
          // devolviendo `filas` completo como antes -- nada más de esta
          // suite necesitaba algo más preciso ahí todavía.
          const acceptHeader = request.headers()['accept'] ?? ''
          const esperaUnaSola = acceptHeader.includes('vnd.pgrst.object')
          const cuerpo = method === 'POST' ? insertadas : filas
          await responderJson(route, 201, esperaUnaSola ? (cuerpo[0] ?? null) : cuerpo)
          return
        }

        const filas = aplicarFiltros(tables[table] ?? [], reqUrl.searchParams)
        const acceptHeader = request.headers()['accept'] ?? ''
        const esperaUnaSola = acceptHeader.includes('vnd.pgrst.object')
        const preferCount = request.headers()['prefer'] ?? ''

        const headers = {}
        if (preferCount.includes('count=exact')) {
          headers['content-range'] = `0-${Math.max(filas.length - 1, 0)}/${filas.length}`
        }

        if (method === 'HEAD') {
          await route.fulfill({ status: 200, headers })
          return
        }

        const body = esperaUnaSola ? (filas[0] ?? null) : filas
        await responderJson(route, 200, body, headers)
        return
      }

      if (pathname.startsWith('/storage/v1/object')) {
        if (method === 'GET') {
          await route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1_TRANSPARENTE })
          return
        }
        await responderJson(route, 200, { Key: pathname })
        return
      }

      await responderJson(route, 404, { message: `[e2e mock] sin fixture para ${method} ${pathname}` })
    }
  )
}
