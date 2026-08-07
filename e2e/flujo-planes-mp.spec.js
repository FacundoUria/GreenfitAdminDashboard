import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS, PROFILE_MARTINA } from './support/fixtures.js'
import { irAConfiguracion } from './support/nav.js'

// Flujo de punta a punta pedido ("Prueba 1: Pack por Créditos" / "Prueba 2:
// Membresía por Vencimiento"): Seba crea el pack en Configuración > Planes
// y Precios, y ESE MISMO pack -- sin ningún paso intermedio -- es el que
// aparece en Actividad Reciente apenas se aprueba una compra. Complementa
// (no reemplaza) planes-packs.spec.js (mecánica del alta) y
// actividad-reciente-mp.spec.js (mecánica del feed) probando la INTEGRACIÓN
// entre las dos: el pack recién creado acá es el que compra el socio allá,
// no uno hardcodeado aparte.
//
// La compra "aprobada por Mercado Pago" se simula agregando la fila que
// mp_process_payment deja en pagos_socio (ver
// backend/supabase_migration_mercadopago_payments.sql en greenfit-app) --
// ese webhook es server a server (Mercado Pago -> Supabase), no hay ningún
// botón de checkout real que un E2E del Admin pueda tocar.
test.describe('Admin -- flujo de punta a punta: alta de pack en Configuración -> compra aprobada visible en Actividad Reciente', () => {
  test('Prueba 1 (Créditos): "Pack 4 clases CrossFit" ($15.000) creado en Configuración aparece comprado en Actividad Reciente', async ({
    page,
  }) => {
    const tablas = { ...tablasBase(), packs: [] }
    await loginComoAdmin(page, { tables: tablas })

    await irAConfiguracion(page)
    await page.getByRole('button', { name: 'Nuevo Pack' }).click()
    await page.getByLabel('Nombre').fill('Pack 4 clases CrossFit')
    await page.getByLabel('Disciplina').selectOption(DISCIPLINA_CROSSFIT.id)
    await page.getByLabel('Precio').fill('15000')
    await page.getByLabel('Cantidad de créditos').fill('4')
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByText('Pack 4 clases CrossFit')).toBeVisible()

    // El webhook de Mercado Pago ya acreditó esta compra -- se simula
    // agregando la fila directo al fixture (misma técnica que
    // actividad-reciente-mp.spec.js), con el ID real del pack recién creado.
    tablas.pagos_socio = [
      {
        id: 'pago-mp-4-crossfit',
        user_id: PROFILE_MARTINA.id,
        paquete: 'Pack 4 clases CrossFit',
        monto: 15000,
        metodo_pago: 'mercado_pago',
        estado: 'pagado',
        origen: 'mercado_pago',
        mercado_pago_payment_id: 'mp-e2e-4-crossfit',
        created_at: new Date().toISOString(),
        profiles: { full_name: 'Martina Ríos' },
      },
    ]

    await page.getByRole('link', { name: 'Home', exact: true }).click()
    await expect(page.getByText('Actividad Reciente')).toBeVisible()
    await expect(
      page.getByText(/Martina Ríos.*Compró Pack 4 clases CrossFit por \$.*15\.000.*\(Mercado Pago\)/)
    ).toBeVisible()
  })

  test('Prueba 2 (Vencimiento): "Pase 2 Meses Aparatos" ($70.000) creado en Configuración aparece comprado en Actividad Reciente', async ({
    page,
  }) => {
    const tablas = { ...tablasBase(), packs: [] }
    await loginComoAdmin(page, { tables: tablas })

    await irAConfiguracion(page)
    await page.getByRole('button', { name: 'Nuevo Pack' }).click()
    await page.getByLabel('Nombre').fill('Pase 2 Meses Aparatos')
    await page.getByLabel('Disciplina').selectOption(DISCIPLINA_APARATOS.id)
    await expect(page.getByLabel('Días de vigencia')).toBeVisible()
    await page.getByLabel('Precio').fill('70000')
    await page.getByLabel('Días de vigencia').fill('60')
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByText('Pase 2 Meses Aparatos')).toBeVisible()
    await expect(page.getByText('Aparatos · 60 días')).toBeVisible()

    tablas.pagos_socio = [
      {
        id: 'pago-mp-2-meses-aparatos',
        user_id: PROFILE_MARTINA.id,
        paquete: 'Pase 2 Meses Aparatos',
        monto: 70000,
        metodo_pago: 'mercado_pago',
        estado: 'pagado',
        origen: 'mercado_pago',
        mercado_pago_payment_id: 'mp-e2e-2-meses-aparatos',
        created_at: new Date().toISOString(),
        profiles: { full_name: 'Martina Ríos' },
      },
    ]

    await page.getByRole('link', { name: 'Home', exact: true }).click()
    await expect(page.getByText('Actividad Reciente')).toBeVisible()
    await expect(
      page.getByText(/Martina Ríos.*Compró Pase 2 Meses Aparatos por \$.*70\.000.*\(Mercado Pago\)/)
    ).toBeVisible()
  })
})
