import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irAComunidad } from './support/nav.js'

// Cubre el checklist de la nueva sección "Comunidad" del Admin: pestaña en
// el Sidebar (debajo de Anunciar/Configuración), Feed y Ranking de SOLO
// LECTURA, y la ausencia deliberada de Mensajes privados (privacidad).
//
// Nota de selectors: FeedAdmin/RankingAdmin ponen nombre + badges (nivel,
// disciplina) o nombre + XP como HERMANOS dentro del mismo contenedor flex
// (ver ficha360.spec.js/socios-tabla.spec.js -- mismo patrón "N{nivel}" que
// ahí también se resuelve con exact:true). Sin `exact: true` un
// `getByText` no-exacto puede matchear TANTO el elemento puntual como el
// contenedor padre (su texto concatenado lo contiene como substring) y
// Playwright tira "strict mode violation" por resolver a más de un nodo.

const AUTOR_POST = { id: 'e2e-autor-post', full_name: 'Diego Fernández', avatar_url: null }
const AUTOR_COMENTARIO = { id: 'e2e-autor-comentario', full_name: 'Valentina Cruz', avatar_url: null }

const POST_1 = {
  id: 'post-1',
  author_id: AUTOR_POST.id,
  body: 'Rompí mi PR de sentadilla ¡92kg! 🏋️',
  media_url: null,
  author_nivel: 4,
  author_discipline: 'CrossFit',
  created_at: '2026-08-01T12:00:00.000Z',
}

const REACCIONES_POST_1 = [
  { id: 'reac-1', post_id: 'post-1', user_id: 'u-x' },
  { id: 'reac-2', post_id: 'post-1', user_id: 'u-y' },
]

const COMENTARIO_1 = {
  id: 'com-1',
  post_id: 'post-1',
  author_id: AUTOR_COMENTARIO.id,
  body: '¡Grande crack!',
  created_at: '2026-08-01T12:05:00.000Z',
}

function mockAuthorNames(request) {
  const { p_ids: ids } = request.postDataJSON()
  return [AUTOR_POST, AUTOR_COMENTARIO].filter((a) => ids.includes(a.id))
}

const DISC_CROSSFIT = { id: 'disc-crossfit', name: 'CrossFit', kind: 'credits', is_active: true }
const DISC_BOXEO = { id: 'disc-boxeo', name: 'Boxeo', kind: 'credits', is_active: true }

const RANKING_GLOBAL = [
  { user_id: 'u1', full_name: 'Diego Fernández', avatar_url: null, total_xp: 2300 },
  { user_id: 'u2', full_name: 'Valentina Cruz', avatar_url: null, total_xp: 1800 },
  { user_id: 'u3', full_name: 'Bruno Álvarez', avatar_url: null, total_xp: 900 },
  { user_id: 'u4', full_name: 'Carla Suárez', avatar_url: null, total_xp: 400 },
]

const RANKING_BOXEO = [{ user_id: 'u5', full_name: 'Nico Paz', avatar_url: null, total_xp: 700 }]

function mockRankingXp(request) {
  const { p_discipline_id: disciplineId } = request.postDataJSON()
  if (disciplineId === DISC_BOXEO.id) return RANKING_BOXEO
  return RANKING_GLOBAL
}

test('la pestaña Comunidad existe en el Sidebar y arranca en Feed vacío -- sin Mensajes en ningún lado', async ({ page }) => {
  await loginComoAdmin(page, { tables: { ...tablasBase() } })

  await irAComunidad(page)
  await expect(page.getByRole('heading', { name: 'Comunidad', exact: true })).toBeVisible()
  await expect(page.getByText('Todavía no hay publicaciones en la Comunidad.')).toBeVisible()

  await page.getByRole('button', { name: 'Ranking', exact: true }).click()
  await expect(page.getByText('Todavía no hay XP registrado.')).toBeVisible()

  // Privacidad: la sección omite a propósito los Mensajes privados --
  // ningún texto relacionado debería aparecer en esta pantalla.
  await expect(page.getByText(/mensajes/i)).toHaveCount(0)
})

test('el Feed muestra publicaciones reales con nombre por RPC, reacciones y comentarios', async ({ page }) => {
  await loginComoAdmin(page, {
    tables: {
      ...tablasBase(),
      community_posts: [POST_1],
      community_reactions: REACCIONES_POST_1,
      community_comments: [COMENTARIO_1],
    },
    rpc: { community_author_names: mockAuthorNames },
  })

  await irAComunidad(page)
  await expect(page.getByText('Diego Fernández', { exact: true })).toBeVisible()
  await expect(page.getByText('N4', { exact: true })).toBeVisible()
  await expect(page.getByText('CrossFit', { exact: true })).toBeVisible()
  await expect(page.getByText('Rompí mi PR de sentadilla ¡92kg! 🏋️', { exact: true })).toBeVisible()
  await expect(page.getByText('2 reacciones', { exact: true })).toBeVisible()
  await expect(page.getByText('1 comentario', { exact: true })).toBeVisible()
  // El comentario es "<b>Valentina Cruz: </b>¡Grande crack!" -- el autor
  // vive en su propio <span> (exact lo aísla), el cuerpo es un nodo de
  // texto suelto en el mismo <div> que ese <span> (ahí sí, con un solo
  // comentario, el contenedor y el <div> del comentario quedan con el
  // mismo texto exacto -- .first() en vez de exact para no pelear con esa
  // ambigüedad inevitable).
  await expect(page.getByText('Valentina Cruz:', { exact: true })).toBeVisible()
  await expect(page.getByText('¡Grande crack!').first()).toBeVisible()
})

test('el Ranking muestra podio + lista y el filtro por disciplina funciona', async ({ page }) => {
  await loginComoAdmin(page, {
    tables: { ...tablasBase(), disciplines: [DISC_CROSSFIT, DISC_BOXEO] },
    rpc: { community_ranking_xp: mockRankingXp },
  })

  await irAComunidad(page)
  await page.getByRole('button', { name: 'Ranking', exact: true }).click()

  // Podio: primeros 3 (medallas), con nombre y XP.
  await expect(page.getByText('Diego Fernández', { exact: true })).toBeVisible()
  await expect(page.getByText('2300 XP', { exact: true })).toBeVisible()
  await expect(page.getByText('Valentina Cruz', { exact: true })).toBeVisible()
  await expect(page.getByText('Bruno Álvarez', { exact: true })).toBeVisible()
  // Resto de la lista (4to en adelante).
  await expect(page.getByText('Carla Suárez', { exact: true })).toBeVisible()
  await expect(page.getByText('400 XP', { exact: true })).toBeVisible()

  // Filtro por disciplina -- "Boxeo" reemplaza el ranking global.
  await page.getByRole('button', { name: 'Boxeo', exact: true }).click()
  await expect(page.getByText('Nico Paz', { exact: true })).toBeVisible()
  await expect(page.getByText('700 XP', { exact: true })).toBeVisible()
  await expect(page.getByText('Diego Fernández')).toHaveCount(0)
})

// Reseteo de Ranking: acción exclusiva del Admin, destructiva para TODOS los
// socios a la vez -- por eso el checklist pide un modal de confirmación
// ESTRICTO (texto exacto) antes de tocar nada, y que "Cancelar" no dispare
// el RPC bajo ningún punto.
test('el botón "Resetear Ranking" pide confirmación estricta -- cancelar no llama al RPC ni cambia nada', async ({
  page,
}) => {
  let llamadasReset = 0
  await loginComoAdmin(page, {
    tables: { ...tablasBase(), disciplines: [DISC_CROSSFIT, DISC_BOXEO] },
    rpc: {
      community_ranking_xp: mockRankingXp,
      admin_resetear_ranking: () => {
        llamadasReset += 1
        return RANKING_GLOBAL.length
      },
    },
  })

  await irAComunidad(page)
  await page.getByRole('button', { name: 'Ranking', exact: true }).click()
  await expect(page.getByText('Diego Fernández', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Resetear Ranking', exact: true }).click()
  await expect(
    page.getByText(
      '¿Estás seguro de que querés reiniciar el ranking? Todos los socios volverán a 0 XP. Esta acción no se puede deshacer.',
    ),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
  expect(llamadasReset).toBe(0)
  // El modal se cerró y el ranking sigue intacto -- nada se tocó.
  await expect(page.getByText('¿Estás seguro de que querés reiniciar el ranking?', { exact: false })).toHaveCount(0)
  await expect(page.getByText('Diego Fernández', { exact: true })).toBeVisible()
  await expect(page.getByText('2300 XP', { exact: true })).toBeVisible()
})

test('confirmar el reseteo llama a admin_resetear_ranking, avisa cuántos socios volvieron a 0 XP y refresca el ranking', async ({
  page,
}) => {
  let reseteado = false
  await loginComoAdmin(page, {
    tables: { ...tablasBase(), disciplines: [DISC_CROSSFIT, DISC_BOXEO] },
    rpc: {
      // Estafeta simple en memoria: antes del reseteo, el RPC de ranking
      // devuelve el global de siempre; apenas se confirma el reseteo, el
      // próximo fetch (el refresh automático post-reseteo) ya da vacío --
      // mismo comportamiento que produciría el RPC real de Supabase, que
      // insertó eventos de reversión que neutralizan la suma de cada socio.
      community_ranking_xp: () => (reseteado ? [] : RANKING_GLOBAL),
      admin_resetear_ranking: () => {
        reseteado = true
        return RANKING_GLOBAL.length
      },
    },
  })

  await irAComunidad(page)
  await page.getByRole('button', { name: 'Ranking', exact: true }).click()
  await expect(page.getByText('Diego Fernández', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Resetear Ranking', exact: true }).click()
  await page.getByRole('button', { name: 'Sí, resetear a 0 XP', exact: true }).click()

  await expect(page.getByText(`${RANKING_GLOBAL.length} socios volvieron a 0 XP`, { exact: false })).toBeVisible()
  // El modal se cierra solo y la lista queda reflejando el reseteo real.
  await expect(page.getByText('¿Estás seguro de que querés reiniciar el ranking?', { exact: false })).toHaveCount(0)
  await expect(page.getByText('Diego Fernández')).toHaveCount(0)
  await expect(page.getByText('Todavía no hay XP registrado.')).toBeVisible()
})

test('el recordatorio visual de reseteo programado aparece en Ranking cuando hay una fecha guardada en Configuración', async ({
  page,
}) => {
  await loginComoAdmin(page, {
    tables: {
      ...tablasBase(),
      configuracion: [{ ...tablasBase().configuracion[0], proximo_reseteo_ranking: '2020-01-01' }],
    },
    rpc: { community_ranking_xp: () => [] },
  })

  await irAComunidad(page)
  await page.getByRole('button', { name: 'Ranking', exact: true }).click()

  // Es solo un aviso visual (no dispara nada solo) -- una fecha ya pasada
  // avisa que hay que tocar el botón manual, sin resetear nada por sí sola.
  await expect(page.getByText('Reseteo programado para el', { exact: false })).toBeVisible()
  await expect(page.getByText('ya llegó la fecha', { exact: false })).toBeVisible()
})
