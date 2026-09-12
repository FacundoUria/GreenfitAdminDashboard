import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT } from './support/fixtures.js'
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
// esa resolución nunca matchea nada y devuelve null.
//
// FIX de "plan único": esa sección ya no lee socio.plan para decidir qué
// mostrar, sino fetchCreditosPorDisciplina() (que también resuelve por DNI
// contra `profiles`) -- sin DNI, esa función tampoco matchea ninguna fila,
// así que la sección de Créditos directamente no aparece (en vez de
// aparecer con un botón que alertara "sin cuenta en la app" al clickearlo).
// El bloqueo de entrada sigue siendo el mismo -- ningún RPC se dispara --
// solo cambió el mecanismo: ausencia de UI en vez de alert en runtime.
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
  test('un socio sin DNI cargado no muestra la sección de Créditos en "Editar Socio" -- no hay nada que tocar', async ({ page }) => {
    // user_credits explícito en [] -- sin esto, se heredaría la fila real
    // de Martina que trae tablasBase() (CAMBIO 3, ver fixtures.js), ajena a
    // este socio y a este test.
    const tablas = { ...tablasBase(), socios: [SOCIO_SIN_DNI], user_credits: [] }
    await loginComoAdmin(page, { tables: tablas })

    await irASocios(page)
    const filaTabla = page.getByRole('table').getByRole('row', { name: /Valentina Cruz/ })
    await filaTabla.getByTitle('Editar').click()
    await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()

    // Sin DNI, fetchCreditosPorDisciplina no resuelve ningún user_id -- no
    // hay ninguna disciplina con lotes que mostrar, y sin userId tampoco se
    // puede ofrecer "+ Agregar Aparatos" (destinado a fallar siempre) --
    // la sección entera de Créditos no aparece (nada que clickear, ningún
    // RPC que pueda dispararse por accidente).
    await expect(page.getByRole('heading', { name: 'Créditos', exact: true })).toHaveCount(0)
    expect(tablas.user_credits).toHaveLength(0)
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
    const tablas = {
      ...tablasBase(),
      socios: [socioConDni],
      profiles: [profileConDni],
      // Lote activo real preexistente -- desde el fix de "plan único", la
      // sección de Créditos ya no se apoya en socio.plan para decidir qué
      // mostrar, así que necesita al menos un lote activo real para que
      // aparezca el botón "Sumar 1 crédito a CrossFit" (a diferencia de
      // antes, ya no alcanza con que CrossFit esté tildado en el plan).
      user_credits: [
        {
          id: 'uc-previo',
          user_id: profileConDni.id,
          discipline_id: DISCIPLINA_CROSSFIT.id,
          remaining_credits: 3,
          expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          created_at: '2026-08-01T00:00:00.000Z',
          discipline: DISCIPLINA_CROSSFIT,
        },
      ],
    }
    await loginComoAdmin(page, {
      tables: tablas,
      rpc: {
        admin_ajustar_credito_disciplina: (request) => {
          const { p_user_id: userId, p_discipline_id: disciplineId, p_delta: delta } = request.postDataJSON()
          expect(userId).toBe(profileConDni.id)
          const activo = tablas.user_credits.find(
            (f) => f.user_id === userId && f.discipline_id === disciplineId && (f.remaining_credits ?? 0) > 0,
          )
          if (activo) {
            activo.remaining_credits += delta
          } else {
            tablas.user_credits.push({
              id: 'uc-e2e-1',
              user_id: userId,
              discipline_id: disciplineId,
              remaining_credits: delta,
              expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
              created_at: new Date().toISOString(),
              discipline: tablas.disciplines.find((d) => d.id === disciplineId),
            })
          }
          return null
        },
      },
    })

    await irASocios(page)
    const filaTabla = page.getByRole('table').getByRole('row', { name: /Valentina Cruz/ })
    await filaTabla.getByTitle('Editar').click()
    await expect(page.getByRole('heading', { name: 'Editar Socio' })).toBeVisible()

    await page.getByTitle('Sumar 1 crédito a CrossFit').click()

    await expect.poll(() => tablas.user_credits.find((f) => f.id === 'uc-previo').remaining_credits).toBe(4)
  })
})
