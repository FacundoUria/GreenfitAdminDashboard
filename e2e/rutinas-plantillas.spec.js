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
    await loginComoAdmin(page, { tables: tablasBase() })

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
  })
})
