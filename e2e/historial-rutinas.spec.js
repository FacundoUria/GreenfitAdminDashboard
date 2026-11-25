import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, PROFILE_MARTINA } from './support/fixtures.js'
import { irARutinas } from './support/nav.js'

// Historial de rutinas (Fase 1) en Rutinas > Asignación a Socios: la rutina actual arriba,
// el historial abajo (más nueva primero), cada una se abre en solo lectura con sus
// entrenamientos, y "Volver a asignar" (con confirmación) la copia como vigente: la
// actual pasa al historial. Nada se borra.

const EJ_SENTADILLA = { id: 'ex-1', name: 'Sentadilla', muscle_group: 'Piernas' }

function tablasConHistorial() {
  const tables = tablasBase()
  tables.exercises = [EJ_SENTADILLA]
  tables.routines = [
    {
      id: 'r-actual', user_id: PROFILE_MARTINA.id, title: 'Hipertrofia', is_template: false,
      created_at: '2026-10-01T13:00:00.000Z', vigente_desde: '2026-10-01T13:00:00.000Z', vigente_hasta: null, archivada_en: null,
    },
    {
      id: 'r-vieja', user_id: PROFILE_MARTINA.id, title: 'Fuerza', is_template: false,
      created_at: '2026-08-01T13:00:00.000Z', vigente_desde: '2026-08-01T13:00:00.000Z', vigente_hasta: '2026-10-01T13:00:00.000Z', archivada_en: null,
    },
  ]
  // El mock no resuelve embeds: los ejercicios van anidados a mano en cada día.
  tables.routine_days = [
    {
      id: 'd-actual', routine_id: 'r-actual', title: 'Día 1', order_index: 0,
      routine_exercises: [{ id: 're-a', exercise_id: 'ex-1', sets: 3, reps: '12', rest_seconds: 60, weight_suggestion: null, notes: null, order_index: 0, exercise: EJ_SENTADILLA }],
    },
    {
      id: 'd-vieja', routine_id: 'r-vieja', title: 'Tren inferior', order_index: 0,
      routine_exercises: [{ id: 're-v', exercise_id: 'ex-1', sets: 5, reps: '5', rest_seconds: 120, weight_suggestion: '80kg', notes: null, order_index: 0, exercise: EJ_SENTADILLA }],
    },
  ]
  tables.routine_history = [
    {
      id: 'h-1', user_id: PROFILE_MARTINA.id, routine_id: 'r-vieja', sesion_id: 's-1', fecha: '2026-09-10', titulo_dia: 'Tren inferior',
      nombre_ejercicio: 'Sentadilla', series: 5, repeticiones: '5', peso: '82kg', orden: 0, total_ejercicios: 1, completo: true,
      created_at: '2026-09-10T22:00:00.000Z', oculta_en: '2026-09-11T10:00:00.000Z',
    },
  ]
  return tables
}

async function elegirMartina(page) {
  await irARutinas(page)
  await page.getByRole('button', { name: 'Asignación a Socios' }).click()
  await page.getByPlaceholder('Buscar socio por nombre o DNI...').fill('Martina')
  await page.getByRole('button', { name: /Martina Ríos/ }).click()
}

test.describe('Admin -- Historial de rutinas del socio', () => {
  test('rutina actual arriba, historial abajo; una anterior se abre en solo lectura con sus entrenamientos (también los ocultos)', async ({ page }) => {
    await loginComoAdmin(page, { tables: tablasConHistorial() })
    await elegirMartina(page)

    const actual = page.getByRole('region', { name: 'Rutina actual' })
    await expect(actual.getByText('Hipertrofia')).toBeVisible()
    await expect(actual.getByText(/Desde el 01\/10\/2026/)).toBeVisible()

    const historial = page.getByRole('region', { name: 'Historial de rutinas' })
    await expect(historial.getByText('Historial de rutinas (1)')).toBeVisible()
    await expect(historial.getByText('Fuerza')).toBeVisible()
    await expect(historial.getByText(/Del 01\/08\/2026 al 01\/10\/2026 · 1 entrenamiento$/)).toBeVisible()

    await page.getByRole('button', { name: 'Ver Fuerza' }).click()
    const modal = page.getByRole('dialog', { name: 'Detalle de la rutina' })
    await expect(modal.getByText(/Rutina del historial: solo lectura/)).toBeVisible()
    await expect(modal.getByText(/5 × 5 · 120 s · Carga sugerida 80kg/)).toBeVisible()
    await expect(modal.getByText('Entrenamientos registrados en esta rutina (1)')).toBeVisible()
    await expect(modal.getByText(/82kg/)).toBeVisible()
    await expect(modal.getByText('Oculto por el socio')).toBeVisible()
    await expect(modal.locator('input, textarea, select')).toHaveCount(0)
  })

  test('"Volver a asignar" confirma y deja esa rutina como vigente; la actual pasa al historial', async ({ page }) => {
    const tables = tablasConHistorial()
    const llamadas = []
    const rpc = {
      // Emula admin_asignar_rutina: cierra la vigente y crea la copia.
      admin_asignar_rutina: (request) => {
        const body = request.postDataJSON()
        llamadas.push(body)
        const ahora = new Date().toISOString()
        const origen = tables.routines.find((r) => r.id === body.p_origen_id)
        for (const r of tables.routines) if (r.user_id === body.p_user_id && !r.vigente_hasta) r.vigente_hasta = ahora
        tables.routines.push({ ...origen, id: 'r-copia', created_at: ahora, vigente_desde: ahora, vigente_hasta: null })
        return 'r-copia'
      },
    }
    const dialogos = []
    page.on('dialog', async (dialog) => {
      dialogos.push(dialog.message())
      await dialog.accept()
    })
    await loginComoAdmin(page, { tables, rpc })
    await elegirMartina(page)

    await page.getByRole('button', { name: 'Volver a asignar Fuerza' }).click()

    await expect.poll(() => llamadas.length).toBe(1)
    expect(llamadas[0]).toEqual({ p_user_id: PROFILE_MARTINA.id, p_origen_id: 'r-vieja' })
    expect(dialogos[0]).toContain('La rutina actual ("Hipertrofia") pasa al historial del socio')

    const actual = page.getByRole('region', { name: 'Rutina actual' })
    await expect(actual.getByText('Fuerza')).toBeVisible()
    const historial = page.getByRole('region', { name: 'Historial de rutinas' })
    await expect(historial.getByText('Historial de rutinas (2)')).toBeVisible()
    await expect(historial.getByText('Hipertrofia')).toBeVisible()
    // Nada se borró: las tres rutinas siguen en la tabla.
    expect(tables.routines.map((r) => r.id).sort()).toEqual(['r-actual', 'r-copia', 'r-vieja'])
  })
})
