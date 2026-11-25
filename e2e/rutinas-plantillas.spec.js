import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irARutinas } from './support/nav.js'

// Cubre el checklist del rediseño de Rutinas en el Admin: empty state de
// Plantillas, el modal de Biblioteca de Ejercicios, y el editor de
// plantillas con la grilla compacta de Series/Reps/Carga/Descanso.
test.describe('Admin -- Rutinas (rediseño Plantillas/Biblioteca/Editor)', () => {
  test('el estado vacío de Plantillas muestra el ícono y el microcopy del "cajón de rutinas"', async ({ page }) => {
    await loginComoAdmin(page, { tables: tablasBase() })

    await irARutinas(page)

    await expect(page.getByText('Tu cajón de rutinas base')).toBeVisible()
    await expect(
      page.getByText(
        'Armá rutinas generales acá (ej. "Adaptación 4 días") y asignalas rápido a tus socios desde su perfil.',
      ),
    ).toBeVisible()
  })

  test('Biblioteca de Ejercicios: muestra el texto explicativo y permite cargar un ejercicio', async ({ page }) => {
    await loginComoAdmin(page, { tables: tablasBase() })

    await irARutinas(page)
    await page.getByRole('button', { name: 'Ejercicios', exact: true }).click()

    await expect(page.getByRole('heading', { name: 'Biblioteca de ejercicios' })).toBeVisible()
    await expect(
      page.getByText('Agregá los ejercicios que usás siempre para no tener que escribirlos de cero cada vez.'),
    ).toBeVisible()
    // Separación visual explícita entre la tarjeta de creación y la lista.
    await expect(page.getByText('Nuevo ejercicio')).toBeVisible()
    await expect(page.getByText('Tu biblioteca')).toBeVisible()

    await page.getByPlaceholder('Nombre del ejercicio').fill('Remo con barra')
    await page.getByRole('button', { name: 'Agregar ejercicio' }).click()

    await expect(page.getByText('Remo con barra')).toBeVisible()
    await expect(page.getByText('Tu biblioteca (1)')).toBeVisible()
  })

  test('crear una plantilla nueva con la grilla compacta de Series/Reps/Carga/Descanso y verla en la Biblioteca', async ({
    page,
  }) => {
    // Guardar va en UNA llamada al servidor (admin_guardar_rutina, historial de rutinas
    // F1): el mock la emula agregando la plantilla a la tabla.
    const tables = tablasBase()
    const guardados = []
    const rpc = {
      admin_guardar_rutina: (request) => {
        const { p_rutina } = request.postDataJSON()
        guardados.push(p_rutina)
        const id = `e2e-rutina-${guardados.length}`
        tables.routines.push({ id, user_id: null, title: p_rutina.title, is_template: p_rutina.user_id === null, created_at: new Date().toISOString() })
        return id
      },
    }
    await loginComoAdmin(page, { tables, rpc })

    await irARutinas(page)
    await page.getByRole('button', { name: 'Crear la primera plantilla' }).click()
    await expect(page.getByRole('heading', { name: 'Nueva plantilla' })).toBeVisible()
    await expect(page.getByText('Información general')).toBeVisible()

    await page.getByPlaceholder('Ej: Rutina Fuerza 4 días').fill('Adaptación 4 días')
    await page.getByPlaceholder('Ej: Pecho y Espalda').fill('Full Body')

    await page.locator('label:text-is("Nombre") + input').fill('Sentadilla')
    await page.locator('label:text-is("Series") + input').fill('4')
    await page.locator('label:text-is("Reps") + input').fill('8-10')
    await page.locator('label:text-is("Carga") + input').fill('40kg')
    await page.locator('label:text-is("Descanso (s)") + input').fill('90')

    await page.getByRole('button', { name: 'Guardar rutina' }).click()

    await expect(page.getByRole('heading', { name: 'Nueva plantilla' })).not.toBeVisible()
    await expect(page.getByText('Adaptación 4 días')).toBeVisible()

    // Lo que viajó: sin socio (= plantilla), y el ejercicio nuevo para crear en la biblioteca.
    expect(guardados).toHaveLength(1)
    expect(guardados[0]).toMatchObject({ id: null, user_id: null, como_nueva: false, title: 'Adaptación 4 días' })
    expect(guardados[0].days[0]).toMatchObject({ title: 'Full Body' })
    expect(guardados[0].days[0].exercises[0]).toMatchObject({
      exercise_id: null,
      nuevo: { name: 'Sentadilla' },
      sets: 4,
      reps: '8-10',
      weight_suggestion: '40kg',
      rest_seconds: 90,
    })
  })
})
