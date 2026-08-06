import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irASocios } from './support/nav.js'

// Socio con un plan de VENCIMIENTO (no de créditos) -- es el único caso en
// el que el modal muestra los datepickers de fecha de inicio/vencimiento.
// Nunca pagó todavía (fecha_vencimiento/dia_corte null) para ejercitar el
// caso más simple del default ("hoy" como fecha de inicio sugerida).
const SOCIO_VENCIMIENTO = {
  id: 'e2e-socio-vencimiento',
  nombre: 'Lucía',
  apellido: 'Paz',
  dni: '30222333',
  email: 'lucia@e2e.test',
  telefono: '2610000001',
  plan: ['Pase Libre'],
  estado: 'Activo',
  fecha_vencimiento: null,
  fecha_inicio_cuota: null,
  dia_corte: null,
  created_at: '2025-02-01T00:00:00.000Z',
  ultimo_pago: null,
  creditos: 0,
  activo: true,
}

// Mismo criterio UTC que `hoyISO()`/`toISODate()` de src/utils/fecha.js --
// evita que un test corrido cerca de medianoche en un huso detrás de UTC
// (ej. Argentina) calcule "hoy" distinto de lo que calcula el browser.
function isoUTC(date) {
  return date.toISOString().slice(0, 10)
}
function sumarDiasUTC(iso, dias) {
  const fecha = new Date(`${iso}T00:00:00.000Z`)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return isoUTC(fecha)
}

test('Registrar Pago permite un rango de fechas 100% custom (ej. 10 días) y persiste exacto', async ({ page }) => {
  const tablas = { ...tablasBase(), socios: [SOCIO_VENCIMIENTO] }
  await loginComoAdmin(page, { tables: tablas })

  await irASocios(page)
  await expect(page.getByRole('table').getByText('Lucía Paz')).toBeVisible()
  await page.locator('[title="Registrar Pago / Renovar Cuota"]:visible').click()
  await expect(page.getByText('Registrar Pago / Renovar Cuota')).toBeVisible()

  // Plan de vencimiento (Pase Libre) -- deben aparecer los dos datepickers,
  // no la grilla de créditos.
  await expect(page.getByLabel('Fecha de inicio')).toBeVisible()
  await expect(page.getByLabel('Fecha de vencimiento')).toBeVisible()

  const fechaInicioDeseada = isoUTC(new Date())
  const fechaVencimientoDeseada = sumarDiasUTC(fechaInicioDeseada, 10) // rango custom de 10 días

  await page.getByLabel('Fecha de inicio').fill(fechaInicioDeseada)
  await page.getByLabel('Fecha de vencimiento').fill(fechaVencimientoDeseada)

  await page.getByLabel('Monto cobrado (opcional)').fill('8000')
  await page.getByRole('button', { name: 'Confirmar' }).click()

  await expect(page.getByText('Pago registrado correctamente')).toBeVisible({ timeout: 10_000 })

  // 1) Lo que quedó persistido en `socios` (mock en memoria, mutado por el
  //    PATCH real que dispara la UI) coincide EXACTO con lo elegido a mano
  //    -- sin pasar por ningún formateo de fecha que pueda enmascarar un
  //    desfasaje de un día.
  expect(tablas.socios[0].fecha_inicio_cuota).toBe(fechaInicioDeseada)
  expect(tablas.socios[0].fecha_vencimiento).toBe(fechaVencimientoDeseada)

  // 2) La tabla de socios (re-fetch automático tras confirmar) refleja la
  //    fecha de vencimiento elegida -- se compara por día/mes/año en vez de
  //    contra un string armado a mano, para no depender del formato exacto
  //    (con o sin cero a la izquierda) que arme `toLocaleDateString('es-AR')`.
  const filaTabla = page.getByRole('table').getByRole('row', { name: /Lucía Paz/ })
  const textoFila = await filaTabla.textContent()
  const match = textoFila.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  expect(match, `no se encontró una fecha en la fila: "${textoFila}"`).not.toBeNull()
  const [, diaTexto, mesTexto, anioTexto] = match
  const [anioEsperado, mesEsperado, diaEsperado] = fechaVencimientoDeseada.split('-')
  expect(Number(diaTexto)).toBe(Number(diaEsperado))
  expect(Number(mesTexto)).toBe(Number(mesEsperado))
  expect(Number(anioTexto)).toBe(Number(anioEsperado))
})

test('Registrar Pago rechaza una fecha de vencimiento anterior a la de inicio', async ({ page }) => {
  const tablas = { ...tablasBase(), socios: [SOCIO_VENCIMIENTO] }
  await loginComoAdmin(page, { tables: tablas })

  await irASocios(page)
  await page.locator('[title="Registrar Pago / Renovar Cuota"]:visible').click()
  await expect(page.getByText('Registrar Pago / Renovar Cuota')).toBeVisible()

  const fechaInicioDeseada = isoUTC(new Date())
  const fechaVencimientoInvalida = sumarDiasUTC(fechaInicioDeseada, -5)

  await page.getByLabel('Fecha de inicio').fill(fechaInicioDeseada)
  await page.getByLabel('Fecha de vencimiento').fill(fechaVencimientoInvalida)
  await page.getByRole('button', { name: 'Confirmar' }).click()

  await expect(page.getByText('La fecha de vencimiento no puede ser anterior a la de inicio.')).toBeVisible()
  // No se disparó ningún PATCH -- el registro en el mock sigue intacto.
  expect(tablas.socios[0].fecha_vencimiento).toBeNull()
})
