import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS } from './support/fixtures.js'
import { irAConfiguracion } from './support/nav.js'

// "Planes y Precios" (checklist "Dinamismo total de packs y precios desde
// el Admin"): los packs que acá se crean/editan son EXACTAMENTE lo que
// "Elegí tu pack" lee en tiempo real en la PWA (fetchPacks()) y lo que la
// Edge Function create-payment-preference usa para resolver el precio real
// de Mercado Pago -- nada de esto está hardcodeado en ningún lado.

const PACK_EXISTENTE = {
  id: 'pack-crossfit-12',
  name: 'Pack 12 clases CrossFit',
  discipline_id: DISCIPLINA_CROSSFIT.id,
  price: 30000,
  credits: 12,
  duration_days: null,
  is_active: true,
  disciplines: { name: 'CrossFit', kind: 'credits' },
}

test('crear un pack nuevo de créditos aparece en la lista y queda guardado en `packs`', async ({ page }) => {
  const tablas = { ...tablasBase(), packs: [] }
  await loginComoAdmin(page, { tables: tablas })

  await irAConfiguracion(page)
  await expect(page.getByText('Todavía no hay ningún pack cargado.')).toBeVisible()

  await page.getByRole('button', { name: 'Nuevo Pack' }).click()
  await expect(page.getByRole('heading', { name: 'Nuevo Pack' })).toBeVisible()

  await page.getByLabel('Nombre').fill('Pack 6 clases CrossFit')
  await page.getByLabel('Disciplina').selectOption(DISCIPLINA_CROSSFIT.id)
  await page.getByLabel('Precio').fill('10000')
  await page.getByLabel('Cantidad de créditos').fill('6')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()

  await expect(page.getByText('Pack 6 clases CrossFit')).toBeVisible()
  await expect(page.getByText('CrossFit · 6 créditos')).toBeVisible()
  expect(tablas.packs).toHaveLength(1)
  expect(tablas.packs[0]).toMatchObject({
    name: 'Pack 6 clases CrossFit',
    discipline_id: DISCIPLINA_CROSSFIT.id,
    price: 10000,
    credits: 6,
    duration_days: null,
  })
})

test('crear un pack de Aparatos (membresía) pide días de vigencia, no créditos', async ({ page }) => {
  const tablas = { ...tablasBase(), packs: [] }
  await loginComoAdmin(page, { tables: tablas })

  await irAConfiguracion(page)
  await page.getByRole('button', { name: 'Nuevo Pack' }).click()

  await page.getByLabel('Nombre').fill('Mes libre Aparatos')
  await page.getByLabel('Disciplina').selectOption(DISCIPLINA_APARATOS.id)
  await expect(page.getByLabel('Días de vigencia')).toBeVisible()
  await expect(page.getByLabel('Cantidad de créditos')).toHaveCount(0)

  await page.getByLabel('Precio').fill('21000')
  await page.getByLabel('Días de vigencia').fill('30')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()

  await expect(page.getByText('Mes libre Aparatos')).toBeVisible()
  await expect(page.getByText('Aparatos · 30 días')).toBeVisible()
  expect(tablas.packs[0]).toMatchObject({ credits: null, duration_days: 30 })
})

test('editar el precio de un pack existente persiste el nuevo valor', async ({ page }) => {
  const tablas = { ...tablasBase(), packs: [{ ...PACK_EXISTENTE }] }
  await loginComoAdmin(page, { tables: tablas })

  await irAConfiguracion(page)
  await expect(page.getByText('Pack 12 clases CrossFit')).toBeVisible()

  await page.getByLabel('Editar Pack 12 clases CrossFit').click()
  await expect(page.getByRole('heading', { name: 'Editar Pack' })).toBeVisible()
  await page.getByLabel('Precio').fill('32000')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()

  await expect(page.getByText('$ 32.000', { exact: false })).toBeVisible()
  expect(tablas.packs[0].price).toBe(32000)
})
