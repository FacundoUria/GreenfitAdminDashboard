import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irARutinas } from './support/nav.js'

// Biblioteca de ejercicios: borrar ya no cascadea. Un ejercicio en uso (en
// alguna rutina o plantilla, o con pesos de algún socio) no se puede borrar
// -- la base lo rechaza (FK RESTRICT, supabase_migration_ejercicios_fk_restrict.sql)
// y la pantalla lo dice ANTES con los conteos de admin_uso_ejercicios. Antes
// un borrado lo sacaba de todas las rutinas de todos los socios, con sus pesos.

const EJERCICIOS = () => [
  { id: 'ex-peso', name: 'Peso muerto', muscle_group: 'Espalda', description: null, video_url: null },
  { id: 'ex-libre', name: 'Plancha lateral', muscle_group: 'Core', description: null, video_url: null },
]

const USO = {
  'ex-peso': { rutinas_asignadas: 3, plantillas: 1, socios: 2, pesos: 5 },
  'ex-libre': { rutinas_asignadas: 0, plantillas: 0, socios: 0, pesos: 0 },
}

// admin_uso_ejercicios(p_exercise_ids): una fila por ejercicio pedido que siga existiendo.
function rpcUso(tablas) {
  return (request) => {
    const ids = request.postDataJSON()?.p_exercise_ids ?? null
    return tablas.exercises
      .filter((e) => ids === null || ids.includes(e.id))
      .map((e) => ({ exercise_id: e.id, ...(USO[e.id] ?? { rutinas_asignadas: 0, plantillas: 0, socios: 0, pesos: 0 }) }))
  }
}

async function abrirBiblioteca(page, { rpc } = {}) {
  const tablas = { ...tablasBase(), exercises: EJERCICIOS() }
  await loginComoAdmin(page, { tables: tablas, rpc: rpc ?? { admin_uso_ejercicios: rpcUso(tablas) } })
  await irARutinas(page)
  await page.getByRole('button', { name: 'Ejercicios', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Biblioteca de ejercicios' })).toBeVisible()
  await expect(page.getByText('Peso muerto')).toBeVisible()
  return tablas
}

function contarDeletes(page) {
  const contador = { n: 0 }
  page.on('request', (req) => {
    if (req.method() === 'DELETE' && new URL(req.url()).pathname === '/rest/v1/exercises') contador.n += 1
  })
  return contador
}

test.describe('Admin -- Biblioteca de ejercicios: no se borra un ejercicio en uso', () => {
  test('un ejercicio en uso no tiene botón de borrar y dice dónde se usa', async ({ page }) => {
    await abrirBiblioteca(page)

    await expect(page.getByText('En uso: 3 rutinas, 1 plantilla, pesos de 5 socios')).toBeVisible()
    await expect(page.getByLabel('Eliminar Peso muerto')).toHaveCount(0)
    await expect(page.getByLabel('Eliminar Plancha lateral')).toBeVisible()
  })

  test('un ejercicio sin uso: confirmación con texto verdadero y se borra de la lista', async ({ page }) => {
    const tablas = await abrirBiblioteca(page)
    const mensajes = []
    page.once('dialog', async (dialogo) => {
      mensajes.push(dialogo.message())
      await dialogo.accept()
    })

    await page.getByLabel('Eliminar Plancha lateral').click()

    await expect(page.getByText('Se borró "Plancha lateral".')).toBeVisible()
    expect(mensajes).toEqual([
      '¿Borrar "Plancha lateral" de la biblioteca? No lo usa ninguna rutina ni plantilla, y no tiene pesos cargados. No se puede deshacer.',
    ])
    await expect(page.getByLabel('Eliminar Plancha lateral')).toHaveCount(0)
    expect(tablas.exercises.map((e) => e.id)).toEqual(['ex-peso'])
  })

  test('cancelar la confirmación no manda ningún borrado', async ({ page }) => {
    await abrirBiblioteca(page)
    const deletes = contarDeletes(page)
    page.once('dialog', (dialogo) => dialogo.dismiss())

    await page.getByLabel('Eliminar Plancha lateral').click()

    await expect(page.getByLabel('Eliminar Plancha lateral')).toBeVisible()
    expect(deletes.n).toBe(0)
  })

  test('si la base lo rechaza con 23503 (se empezó a usar entre medio): mensaje claro y la lista se actualiza', async ({
    page,
  }) => {
    const tablas = await abrirBiblioteca(page)
    // La base real rechaza el DELETE: el ejercicio pasó a estar en una rutina.
    await page.route(
      (url) => url.pathname === '/rest/v1/exercises',
      async (route) => {
        if (route.request().method() !== 'DELETE') return route.fallback()
        USO['ex-libre'] = { rutinas_asignadas: 1, plantillas: 0, socios: 1, pesos: 0 }
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            code: '23503',
            message: 'update or delete on table "exercises" violates foreign key constraint "routine_exercises_exercise_id_fkey"',
            details: null,
            hint: null,
          }),
        })
      },
    )
    page.once('dialog', (dialogo) => dialogo.accept())

    try {
      await page.getByLabel('Eliminar Plancha lateral').click()

      await expect(
        page.getByText('No se puede borrar "Plancha lateral": se empezó a usar mientras tanto. Actualizamos la lista.'),
      ).toBeVisible()
      await expect(page.getByText(/foreign key/)).toHaveCount(0)
      // Recargó: ahora figura en uso y ya no ofrece borrarlo.
      await expect(page.getByText('En uso: 1 rutina')).toBeVisible()
      await expect(page.getByLabel('Eliminar Plancha lateral')).toHaveCount(0)
      expect(tablas.exercises.map((e) => e.id)).toContain('ex-libre')
    } finally {
      USO['ex-libre'] = { rutinas_asignadas: 0, plantillas: 0, socios: 0, pesos: 0 }
    }
  })

  test('si no se puede saber dónde se usa cada ejercicio, no se ofrece borrar ninguno y se avisa', async ({ page }) => {
    await abrirBiblioteca(page, {
      rpc: {
        admin_uso_ejercicios: () => ({
          __e2eError: { status: 400, body: { message: 'Esta acción requiere permisos de administrador.' } },
        }),
      },
    })

    await expect(page.getByText(/no se puede borrar ninguno/)).toBeVisible()
    await expect(page.getByLabel(/^Eliminar (Peso muerto|Plancha lateral)$/)).toHaveCount(0)
  })
})
