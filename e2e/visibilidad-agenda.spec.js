import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { tablasBase, DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS } from './support/fixtures.js'
import { irADisciplinas } from './support/nav.js'

// Checklist punto 2: switch "Mostrar en la Agenda de reservas de la PWA" en
// Editar Disciplina -- pensado para pases libres como Aparatos (no tienen
// turnos reales que reservar). No afecta la Landing (esa sigue mostrando
// disciplinas por `is_active` únicamente, columna aparte -- ver
// supabase_migration_show_in_agenda.sql).

test('una disciplina con show_in_agenda=false muestra el aviso "Oculta de la Agenda" en su tarjeta', async ({
  page,
}) => {
  await loginComoAdmin(page, {
    tables: {
      ...tablasBase(),
      disciplines: [DISCIPLINA_CROSSFIT, { ...DISCIPLINA_APARATOS, show_in_agenda: false }],
    },
  })

  await irADisciplinas(page)
  const tarjetaAparatos = page.getByTestId(`disciplina-card-${DISCIPLINA_APARATOS.id}`)
  await expect(tarjetaAparatos.getByText('Oculta de la Agenda (pase libre)')).toBeVisible()

  // Una disciplina de créditos, sin la columna seteada explícitamente
  // (default true), no muestra ningún aviso.
  const tarjetaCrossfit = page.getByTestId(`disciplina-card-${DISCIPLINA_CROSSFIT.id}`)
  await expect(tarjetaCrossfit.getByText('Oculta de la Agenda', { exact: false })).toHaveCount(0)
})

test('destildar el switch en Editar Disciplina persiste show_in_agenda=false y aparece el aviso', async ({ page }) => {
  await loginComoAdmin(page, {
    tables: { ...tablasBase(), disciplines: [DISCIPLINA_APARATOS] }, // arranca sin el campo (=> default true en la UI)
  })

  await irADisciplinas(page)
  const tarjeta = page.getByTestId(`disciplina-card-${DISCIPLINA_APARATOS.id}`)
  await expect(tarjeta.getByText('Oculta de la Agenda', { exact: false })).toHaveCount(0)

  await tarjeta.getByText('Editar', { exact: true }).click()
  await expect(page.getByText('Editar Disciplina')).toBeVisible()

  const switchAgenda = page.getByRole('checkbox', { name: /Mostrar en la Agenda de reservas de la PWA/ })
  await expect(switchAgenda).toBeChecked()
  await switchAgenda.uncheck()
  await page.getByRole('button', { name: 'Guardar' }).click()

  await expect(page.getByText('Disciplina actualizada')).toBeVisible()
  await expect(tarjeta.getByText('Oculta de la Agenda (pase libre)')).toBeVisible()
})
