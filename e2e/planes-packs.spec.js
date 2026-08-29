import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS } from './support/fixtures.js'
import { irAConfiguracion } from './support/nav.js'

// "Planes y Precios" (checklist "Dinamismo total de packs y precios desde
// el Admin"): los packs/combos que acá se crean/editan son EXACTAMENTE lo
// que "Elegí tu pack" lee en tiempo real en la PWA (fetchPacks()) y lo que
// la Edge Function create-payment-preference usa para resolver el precio
// real de Mercado Pago -- nada de esto está hardcodeado en ningún lado. Un
// pack ya no es "1 disciplina <-> 1 pack": puede ser un combo real de N
// disciplinas de créditos (selector dinámico de filas) + opcionalmente
// Aparatos (switch independiente con días de vigencia configurables).

const DISC_BOXEO = { id: 'disc-boxeo', name: 'Boxeo', kind: 'credits' }

const PACK_EXISTENTE = {
  id: 'pack-crossfit-12',
  name: 'Pack 12 clases CrossFit',
  price: 30000,
  incluye_aparatos: false,
  dias_vigencia: null,
  creditos: [{ discipline_id: DISCIPLINA_CROSSFIT.id, credits: 12 }],
  is_active: true,
}

test('crear un combo real (Boxeo + CrossFit) aparece en la lista y queda guardado en `packs`', async ({ page }) => {
  const tablas = { ...tablasBase(), disciplines: [DISCIPLINA_CROSSFIT, DISC_BOXEO, DISCIPLINA_APARATOS], packs: [] }
  await loginComoAdmin(page, { tables: tablas })

  await irAConfiguracion(page)
  await expect(page.getByText('Todavía no hay ningún pack cargado.')).toBeVisible()

  await page.getByRole('button', { name: 'Nuevo Pack' }).click()
  await expect(page.getByRole('heading', { name: 'Nuevo Pack' })).toBeVisible()

  await page.getByLabel('Nombre del Plan/Combo').fill('Combo 8+8')
  await page.getByLabel('Precio ($)').fill('55000')

  await page.getByRole('button', { name: 'Agregar Disciplina' }).click()
  await page.getByLabel('Disciplina 1', { exact: true }).selectOption(DISC_BOXEO.id)
  await page.getByLabel('Créditos 1').fill('8')

  await page.getByRole('button', { name: 'Agregar Disciplina' }).click()
  await page.getByLabel('Disciplina 2', { exact: true }).selectOption(DISCIPLINA_CROSSFIT.id)
  await page.getByLabel('Créditos 2').fill('8')

  await page.getByRole('button', { name: 'Guardar', exact: true }).click()

  await expect(page.getByText('Combo 8+8')).toBeVisible()
  await expect(page.getByText('8 créditos Boxeo + 8 créditos CrossFit')).toBeVisible()
  expect(tablas.packs).toHaveLength(1)
  expect(tablas.packs[0]).toMatchObject({
    name: 'Combo 8+8',
    price: 55000,
    incluye_aparatos: false,
    dias_vigencia: null,
    creditos: [
      { discipline_id: DISC_BOXEO.id, credits: 8 },
      { discipline_id: DISCIPLINA_CROSSFIT.id, credits: 8 },
    ],
  })
})

test('crear un pase de Aparatos (¿Incluye Aparatos?) pide Días de Vigencia, no créditos', async ({ page }) => {
  const tablas = { ...tablasBase(), packs: [] }
  await loginComoAdmin(page, { tables: tablas })

  await irAConfiguracion(page)
  await page.getByRole('button', { name: 'Nuevo Pack' }).click()

  await page.getByLabel('Nombre del Plan/Combo').fill('Pase 2 Meses Aparatos')
  await expect(page.getByLabel('Días de Vigencia')).toHaveCount(0)
  await page.getByLabel('¿Incluye Aparatos?').click()
  await expect(page.getByLabel('Días de Vigencia')).toBeVisible()

  await page.getByLabel('Precio ($)').fill('70000')
  await page.getByRole('button', { name: '2 Meses (60 días)' }).click()
  await expect(page.getByLabel('Días de Vigencia')).toHaveValue('60')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()

  await expect(page.getByText('Pase 2 Meses Aparatos')).toBeVisible()
  await expect(page.getByText('Aparatos Pase Libre')).toBeVisible()
  expect(tablas.packs[0]).toMatchObject({ incluye_aparatos: true, dias_vigencia: 60, creditos: [] })
})

test('editar el precio de un pack existente persiste el nuevo valor', async ({ page }) => {
  const tablas = { ...tablasBase(), disciplines: [DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS], packs: [{ ...PACK_EXISTENTE }] }
  await loginComoAdmin(page, { tables: tablas })

  await irAConfiguracion(page)
  await expect(page.getByText('Pack 12 clases CrossFit')).toBeVisible()

  await page.getByLabel('Editar Pack 12 clases CrossFit').click()
  await expect(page.getByRole('heading', { name: 'Editar Pack' })).toBeVisible()
  await expect(page.getByLabel('Disciplina 1', { exact: true })).toHaveValue(DISCIPLINA_CROSSFIT.id)
  await expect(page.getByLabel('Créditos 1')).toHaveValue('12')
  await page.getByLabel('Precio ($)').fill('32000')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()

  await expect(page.getByText('$ 32.000', { exact: false })).toBeVisible()
  expect(tablas.packs[0].price).toBe(32000)
})
