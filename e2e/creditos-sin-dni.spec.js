import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase } from './support/fixtures.js'
import { irASocios } from './support/nav.js'

// Bug crítico reportado: el import masivo de Crossfy (scripts/importar_socios.js)
// trajo ~750 socios sin DNI cargado (matcheados solo por email en ese
// script) -- esos socios nunca tuvieron un balance real inicializado en
// user_credits (ver parche_creditos_sin_dni.sql), y clickear sus botones
// de crédito en el panel operaba sobre algo que nunca existió.
//
// Rediseño (sacar los steppers de la tabla): el ajuste de créditos ahora
// vive en "Editar Socio" -> sección Créditos (CreditosEditablesSocio.jsx),
// que resuelve el user_id vía resolverUserIdPorDni(socio.dni) -- sin DNI,
// esa resolución nunca matchea nada y devuelve null, mismo bloqueo de
// entrada de siempre pero con el aviso genérico de "sin cuenta en la app"
// (ya no un mensaje específico de "falta el DNI": la sección no distingue
// AHORA el motivo exacto por el que no hay user_id resuelto -- sin DNI o
// con DNI pero sin cuenta creada todavía caen en el mismo aviso).
const SOCIO_SIN_DNI = {
  id: 'e2e-socio-sin-dni',
  nombre: 'Valentina',
  apellido: 'Cruz',
  dni: null,
  email: 'valentina@e2e.test',
  telefono: null,
  plan: ['CrossFit'],
  estado: 'Activo',
  fecha_vencimiento: null,
  dia_corte: null,
  created_at: '2025-03-01T00:00:00.000Z',
  ultimo_pago: '2026-07-01',
  creditos: 5,
  activo: true,
}

test.describe('Admin -- Socios sin DNI cargado (import masivo de Crossfy)', () => {
  test('intentar sumar créditos a un socio sin DNI, desde "Editar Socio", muestra la alerta y NO toca nada', async ({ page }) => {
    let mensajeAlerta = null
    const tablas = { ...tablasBase(), socios: [SOCIO_SIN_DNI] }
    await loginComoAdmin(page, { tables: tablas })

    page.once('dialog', async (dialog) => {
      mensajeAlerta = dialog.message()
      await dialog.accept()
    })

    await irASocios(page)
    const filaTabla = page.getByRole('table').getByRole('row', { name: /Valentina Cruz/ })
    await filaTabla.getByTitle('Editar').click()
    await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()

    await page.getByTitle('Sumar 1 crédito a CrossFit').click()

    await expect.poll(() => mensajeAlerta).toBe(
      'Este socio todavía no tiene cuenta en la app -- no se pueden editar créditos acá todavía.',
    )

    // No se creó ni tocó ninguna fila de user_credits -- la acción se
    // bloqueó ANTES de llamar a ningún RPC.
    expect(tablas.user_credits ?? []).toHaveLength(0)
  })

  test('un socio CON DNI sigue pudiendo sumar créditos normalmente desde "Editar Socio" (no se rompió el caso sano)', async ({
    page,
  }) => {
    const socioConDni = { ...SOCIO_SIN_DNI, id: 'e2e-socio-con-dni', dni: '30777888' }
    const profileConDni = {
      id: 'e2e-profile-con-dni',
      dni: socioConDni.dni,
      full_name: 'Valentina Cruz',
      avatar_url: null,
      created_at: '2025-03-01T00:00:00.000Z',
      role: 'socio',
    }
    const tablas = { ...tablasBase(), socios: [socioConDni], profiles: [profileConDni], user_credits: [] }
    await loginComoAdmin(page, {
      tables: tablas,
      rpc: {
        admin_ajustar_credito_disciplina: (request) => {
          const { p_user_id: userId, p_discipline_id: disciplineId, p_delta: delta } = request.postDataJSON()
          expect(userId).toBe(profileConDni.id)
          tablas.user_credits.push({
            id: 'uc-e2e-1',
            user_id: userId,
            discipline_id: disciplineId,
            remaining_credits: delta,
            expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            created_at: new Date().toISOString(),
            discipline: tablas.disciplines.find((d) => d.id === disciplineId),
          })
          return null
        },
      },
    })

    await irASocios(page)
    const filaTabla = page.getByRole('table').getByRole('row', { name: /Valentina Cruz/ })
    await filaTabla.getByTitle('Editar').click()
    await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()

    await page.getByTitle('Sumar 1 crédito a CrossFit').click()

    await expect.poll(() => tablas.user_credits.length).toBe(1)
    expect(tablas.user_credits[0].remaining_credits).toBe(1)
  })
})
