import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT } from './support/fixtures.js'
import { irADisciplinas } from './support/nav.js'

// Cubre el checklist de "Gestión completa de horarios en Disciplinas":
// la tarjeta muestra los días/horario reales (mismo criterio de
// agrupado/formato que "Elegí tu ritmo" en la landing, ver
// src/utils/horarios.js) y el modal de Editar permite modificar una franja
// existente y agregar una nueva, persistiendo ambas en `classes` -- la
// MISMA tabla que consume la landing, así que confirmar que la tarjeta del
// propio Admin refleja el cambio (re-fetch de la misma tabla que "Elegí tu
// ritmo" ya lee) es la prueba, dentro del alcance de este repo, de que el
// cambio se propaga correctamente a esa sección pública.
const CLASE_INICIAL = {
  id: 'clase-crossfit-1',
  discipline_id: DISCIPLINA_CROSSFIT.id,
  title: 'CrossFit',
  instructor: 'Seba',
  capacity: 20,
  days_of_week: [1, 3, 5],
  start_time: '18:00:00',
  end_time: '19:00:00',
}

test('editar los horarios de una disciplina se refleja en su tarjeta', async ({ page }) => {
  await loginComoAdmin(page, {
    tables: { ...tablasBase(), classes: [CLASE_INICIAL] },
  })

  await irADisciplinas(page)
  const tarjeta = page.getByTestId(`disciplina-card-${DISCIPLINA_CROSSFIT.id}`)
  await expect(tarjeta).toBeVisible()

  // La tarjeta ya muestra el horario real cargado (agrupado y formateado
  // igual que la landing: "Lun, Mié, Vie — 18:00 a 19:00 hs").
  await expect(tarjeta.getByText('Lun, Mié, Vie — 18:00 a 19:00 hs')).toBeVisible()

  await tarjeta.getByText('Editar', { exact: true }).click()
  await expect(page.getByText('Editar Disciplina')).toBeVisible()

  // Modifica la franja existente: cambia el rango horario de 18-19 a 19-20.
  await page.getByLabel('Desde').fill('19:00')
  await page.getByLabel('Hasta').fill('20:00')

  // Agrega una segunda franja (Sábado 10 a 11).
  await page.getByText('Agregar franja horaria', { exact: true }).click()
  await page.getByRole('button', { name: 'S', exact: true }).nth(1).click() // el toggle de día "S" (Sábado) de la 2da franja
  const horasSegundaFranja = page.locator('#horaInicio-1, #horaFin-1')
  await horasSegundaFranja.nth(0).fill('10:00')
  await horasSegundaFranja.nth(1).fill('11:00')

  await page.getByRole('button', { name: 'Guardar' }).click()

  await expect(page.getByText('Disciplina actualizada')).toBeVisible()
  // La tarjeta ahora refleja las DOS franjas nuevas -- ni rastro de la vieja.
  await expect(tarjeta.getByText('Lun, Mié, Vie — 19:00 a 20:00 hs')).toBeVisible()
  await expect(tarjeta.getByText('Sáb — 10:00 a 11:00 hs')).toBeVisible()
  await expect(tarjeta.getByText('18:00 a 19:00', { exact: false })).toHaveCount(0)
})

test('una disciplina de membresía (Aparatos) SIN franjas cargadas muestra el fallback "Pase libre"', async ({
  page,
}) => {
  await loginComoAdmin(page, { tables: tablasBase() })

  await irADisciplinas(page)
  const tarjeta = page.getByTestId('disciplina-card-disc-aparatos')
  await expect(tarjeta).toBeVisible()
  await expect(tarjeta.getByText('Pase libre / Horario de gimnasio')).toBeVisible()
})

// Antes, "Editar Disciplina" bloqueaba por completo la carga de horarios
// para kind=membership (mostraba un texto fijo explicando que no tiene
// horarios) -- ahora usa el MISMO selector de franjas que créditos, y lo
// que se cargue ahí es lo que la propia tarjeta del Admin Y la landing
// ("Elegí tu ritmo") terminan mostrando en vez del fallback de Pase Libre.
test('cargar franjas horarias reales en Aparatos (por vencimiento) ya no está bloqueado', async ({ page }) => {
  await loginComoAdmin(page, { tables: tablasBase() })

  await irADisciplinas(page)
  const tarjeta = page.getByTestId('disciplina-card-disc-aparatos')
  await tarjeta.getByText('Editar', { exact: true }).click()

  await expect(page.getByText('Editar Disciplina')).toBeVisible()
  // El texto de bloqueo viejo ya no existe para ningún tipo de disciplina.
  await expect(
    page.getByText('Este tipo de disciplina es de acceso libre (pase por vencimiento) y no tiene horarios fijos.'),
  ).toHaveCount(0)

  await page.getByText('Agregar franja horaria', { exact: true }).click()
  await page.getByRole('button', { name: 'L', exact: true }).click() // Lunes
  await page.getByRole('button', { name: 'V', exact: true }).click() // Viernes
  await page.getByLabel('Desde').fill('07:00')
  await page.getByLabel('Hasta').fill('22:00')

  await page.getByRole('button', { name: 'Guardar' }).click()
  await expect(page.getByText('Disciplina actualizada')).toBeVisible()

  // La tarjeta del propio Admin ya no muestra el fallback -- muestra el
  // horario real recién cargado.
  await expect(tarjeta.getByText('Lun, Vie — 07:00 a 22:00 hs')).toBeVisible()
  await expect(tarjeta.getByText('Pase libre / Horario de gimnasio')).toHaveCount(0)
})

// Regresión de producción: crear una disciplina "Por vencimiento" desde cero
// (no editar una ya existente) sin cargar NINGUNA franja horaria -- las
// franjas son 100% opcionales para cualquier `kind`, así que el alta tiene
// que insertar la fila en `disciplines` sin más, sin tocar `classes` para
// nada. El campo "Días de vigencia" (30) reutiliza `default_capacity` --
// mismo campo que usa "Cupo predeterminado" para créditos, sin migración
// nueva -- para que "Registrar Pago" pueda sugerir el vencimiento solo.
test('crear una disciplina "Por vencimiento" (Gimnasio, 30 días) sin franjas horarias se guarda sin errores', async ({
  page,
}) => {
  const tables = tablasBase()
  await loginComoAdmin(page, { tables })

  await irADisciplinas(page)
  await page.getByRole('button', { name: 'Nueva Disciplina' }).click()
  await expect(page.getByRole('heading', { name: 'Nueva Disciplina' })).toBeVisible()

  await page.getByLabel('Nombre').fill('Gimnasio')
  await page.getByLabel('Tipo').selectOption('membership')
  await expect(page.getByLabel('Días de vigencia (sugerido en Registrar Pago)')).toBeVisible()
  await page.getByLabel('Días de vigencia (sugerido en Registrar Pago)').fill('30')

  // Sin franjas: no se toca "Agregar franja horaria" para nada.
  await page.getByRole('button', { name: 'Guardar' }).click()

  await expect(page.getByText('Disciplina creada')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('No se pudo crear la disciplina', { exact: false })).toHaveCount(0)

  const nueva = tables.disciplines.find((d) => d.name === 'Gimnasio')
  expect(nueva).toBeTruthy()
  expect(nueva.kind).toBe('membership')
  expect(nueva.default_capacity).toBe(30)
  // Ninguna franja se insertó en `classes` para esta disciplina.
  expect(tables.classes.filter((c) => c.discipline_id === nueva.id)).toHaveLength(0)

  await expect(page.getByTestId(`disciplina-card-${nueva.id}`)).toBeVisible()
})
