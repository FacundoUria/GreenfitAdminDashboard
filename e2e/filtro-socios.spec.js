import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { irASocios } from './support/nav.js'
import { DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS } from './support/fixtures.js'

// BUG REAL, URGENTE: filtrando por "Inactivo" en Socios.jsx aparecían
// socios con badge "Activo" -- el filtro no excluía nada. Causa real
// (ver socioMetrics.js): un socio puede tener fecha_vencimiento vencida o
// residual (Aparatos nunca renovado) mientras tiene créditos REALES
// vigentes en otra disciplina (admin_fijar_creditos_disciplina/
// admin_ajustar_credito_disciplina nunca tocan fecha_vencimiento a
// propósito -- las dos fechas pueden divergir). estadoOperativoSocio()
// dejaba que fecha_vencimiento decidiera SOLA apenas existía, así que ese
// socio caía a 'vencido' (contado como "Inactivo" en el filtro) mientras
// EstadoBadge (que mira créditos reales directo) lo mostraba "Activo" --
// la fila aparecía con badge "Activo" bajo el filtro "Inactivo". Ahora un
// crédito real vigente gana siempre.
//
// Además: el filtro por disciplina comparaba contra `socio.plan` (texto
// legacy desincronizado) en vez de los créditos reales -- se arregló para
// que combinar "Inactivo" + una disciplina real sea una condición AND real,
// no una que se pise con la otra.

function fechaOffset(dias) {
  const fecha = new Date()
  fecha.setDate(fecha.getDate() + dias)
  return fecha.toISOString().slice(0, 10)
}

// El caso real del bug: Aparatos vencido hace 40 días, pero CrossFit con
// créditos reales vigentes -- tiene que contar como "Activo" de punta a
// punta (badge Y filtro), nunca "Inactivo"/"vencido".
const SOCIO_FANTASMA_ACTIVO = {
  id: 'socio-fantasma-activo',
  nombre: 'Ana',
  apellido: 'Fantasma',
  dni: '11000001',
  email: 'ana.fantasma@e2e.test',
  plan: ['Aparatos', 'CrossFit'],
  estado: 'Activo',
  fecha_vencimiento: fechaOffset(-40),
  dia_corte: 10,
  creditos: 6,
  activo: true,
  created_at: '2024-01-01T00:00:00.000Z',
}

// Dado de baja, sin ningún crédito real -- Inactivo por partida doble.
const SOCIO_BAJA = {
  id: 'socio-baja',
  nombre: 'Bruno',
  apellido: 'Baja',
  dni: '11000002',
  email: 'bruno.baja@e2e.test',
  plan: [],
  estado: 'Activo',
  fecha_vencimiento: null,
  dia_corte: null,
  creditos: 0,
  activo: false,
  created_at: '2024-01-01T00:00:00.000Z',
}

// Dado de baja, PERO con créditos reales de CrossFit todavía vigentes --
// la baja de cuenta gana igual (sigue "Inactivo"), y es el caso real para
// probar que "Inactivo" + "CrossFit" es un AND genuino: matchea las dos
// condiciones por separado, no una sola.
const SOCIO_BAJA_CON_CROSSFIT = {
  id: 'socio-baja-creditos',
  nombre: 'Noelia',
  apellido: 'BajaConCreditos',
  dni: '11000003',
  email: 'noelia.baja@e2e.test',
  plan: ['CrossFit'],
  estado: 'Activo',
  fecha_vencimiento: null,
  dia_corte: null,
  creditos: 4,
  activo: false,
  created_at: '2024-01-01T00:00:00.000Z',
}

// Vencido de verdad -- Aparatos vencido, sin ningún crédito real de ninguna
// disciplina detrás.
const SOCIO_VENCIDO_SIN_NADA = {
  id: 'socio-vencido-sin-nada',
  nombre: 'Vicky',
  apellido: 'Vencida',
  dni: '11000004',
  email: 'vicky.vencida@e2e.test',
  plan: ['Aparatos'],
  estado: 'Activo',
  fecha_vencimiento: fechaOffset(-20),
  dia_corte: 10,
  creditos: 0,
  activo: true,
  created_at: '2024-01-01T00:00:00.000Z',
}

// Activo, vence en 3 días -- tiene que aparecer en "Por Vencer" (subconjunto
// de "Activo") y en "Activo", nunca en "Inactivo".
const SOCIO_POR_VENCER = {
  id: 'socio-por-vencer',
  nombre: 'Elena',
  apellido: 'PorVencer',
  dni: '11000005',
  email: 'elena.porvencer@e2e.test',
  plan: ['Aparatos'],
  estado: 'Activo',
  fecha_vencimiento: fechaOffset(3),
  dia_corte: 10,
  creditos: 0,
  activo: true,
  created_at: '2024-01-01T00:00:00.000Z',
}

const PROFILE_ANA = { id: 'profile-ana', dni: SOCIO_FANTASMA_ACTIVO.dni, full_name: 'Ana Fantasma' }
const PROFILE_NOELIA = { id: 'profile-noelia', dni: SOCIO_BAJA_CON_CROSSFIT.dni, full_name: 'Noelia BajaConCreditos' }
// Elena SÍ necesita una fila real de Aparatos que respalde su
// fecha_vencimiento -- a diferencia de Ana (el caso fantasma a propósito),
// acá se simula el caso SANO: en producción, toda fecha_vencimiento
// vigente viene siempre acompañada de una fila real (admin_acreditar_
// creditos_manual/admin_agregar_aparatos_socio siempre escriben las dos
// juntas) -- sin esta fila, EstadoBadge (que exige el respaldo real, ver
// ticket "Aparatos fantasma") la mostraría "Inactivo" mientras
// estadoOperativoSocio() la sigue viendo "activo" por fecha, un mismatch
// que no es el bug de ESTE ticket.
const PROFILE_ELENA = { id: 'profile-elena', dni: SOCIO_POR_VENCER.dni, full_name: 'Elena PorVencer' }

const EN_30_DIAS = `${fechaOffset(30)}T12:00:00.000Z`

test('filtro de estado (Activo/Inactivo/Por Vencer) + disciplina -- AND real, sin socios Activos colados bajo "Inactivo"', async ({
  page,
}) => {
  await loginComoAdmin(page, {
    tables: {
      socios: [SOCIO_FANTASMA_ACTIVO, SOCIO_BAJA, SOCIO_BAJA_CON_CROSSFIT, SOCIO_VENCIDO_SIN_NADA, SOCIO_POR_VENCER],
      profiles: [PROFILE_ANA, PROFILE_NOELIA, PROFILE_ELENA],
      // `discipline: {...}` embebido a mano -- el mock (supabaseMock.js) no
      // resuelve joins reales.
      user_credits: [
        {
          id: 'uc-ana-crossfit',
          user_id: PROFILE_ANA.id,
          discipline_id: DISCIPLINA_CROSSFIT.id,
          remaining_credits: 6,
          expires_at: EN_30_DIAS,
          discipline: DISCIPLINA_CROSSFIT,
        },
        {
          id: 'uc-noelia-crossfit',
          user_id: PROFILE_NOELIA.id,
          discipline_id: DISCIPLINA_CROSSFIT.id,
          remaining_credits: 4,
          expires_at: EN_30_DIAS,
          discipline: DISCIPLINA_CROSSFIT,
        },
        {
          id: 'uc-elena-aparatos',
          user_id: PROFILE_ELENA.id,
          discipline_id: DISCIPLINA_APARATOS.id,
          remaining_credits: null,
          expires_at: `${SOCIO_POR_VENCER.fecha_vencimiento}T12:00:00.000Z`,
          discipline: DISCIPLINA_APARATOS,
        },
      ],
      disciplines: [DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS],
      configuracion: [{ id: 1, dias_tolerancia: 5, limite_cancelacion_minutos: 120, alias_cvu: null, titular_cuenta: null }],
      xp_events: [],
      bookings: [],
      classes: [],
      routines: [],
      pagos_socio: [],
    },
  })

  await irASocios(page)
  const tabla = page.getByRole('table')
  const selectEstado = page.locator('select').first()
  const selectPlan = page.getByLabel('Filtrar por plan/disciplina')

  // Filtro por defecto es 'activo'. Ana depende del fetch de créditos
  // reales (fetchCreditosPorDisciplina) y Elena depende del fetch de
  // Aparatos real (fetchAparatosVigentePorDni) -- son DOS fetches
  // independientes, disparados en paralelo pero resueltos por separado
  // (ninguno espera al otro). Esperar a las dos ACÁ, antes de tocar el
  // filtro, evita una carrera real: sin esto, Ana podía aparecer (créditos
  // ya resueltos) mientras Aparatos todavía no -- y los checks de más abajo
  // que dependen de Elena (aparatosVigenteReal) leían el Map todavía vacío.
  await expect(tabla.getByText('Ana Fantasma')).toBeVisible()
  await expect(tabla.getByText('Elena PorVencer')).toBeVisible()

  // 1) Solo "Inactivo" -- Ana (Activa de verdad) NO tiene que aparecer, y
  // ningún badge "Activo" tiene que estar en la tabla filtrada.
  await selectEstado.selectOption('inactivo')
  await expect(tabla.getByText('Bruno Baja')).toBeVisible()
  await expect(tabla.getByText('Noelia BajaConCreditos')).toBeVisible()
  await expect(tabla.getByText('Vicky Vencida')).toBeVisible()
  await expect(tabla.getByText('Ana Fantasma')).toHaveCount(0)
  await expect(tabla.getByText('Elena PorVencer')).toHaveCount(0)
  await expect(tabla.getByText('Activo', { exact: true })).toHaveCount(0)

  // 2) Combinar "Inactivo" + "CrossFit" -- AND real: de los 3 inactivos de
  // arriba, solo Noelia tiene créditos reales de CrossFit detrás. Bruno
  // (inactivo, sin nada) y Vicky (inactiva, sin nada) quedan afuera --
  // "Inactivo" no alcanza solo, tiene que matchear las dos condiciones.
  await selectPlan.selectOption('CrossFit')
  await expect(tabla.getByText('Noelia BajaConCreditos')).toBeVisible()
  await expect(tabla.getByText('Bruno Baja')).toHaveCount(0)
  await expect(tabla.getByText('Vicky Vencida')).toHaveCount(0)
  await selectPlan.selectOption('todos')

  // 3) Solo "Activo" -- ningún badge "Inactivo" tiene que aparecer, y Ana
  // (el caso del bug) SÍ tiene que estar.
  await selectEstado.selectOption('activo')
  await expect(tabla.getByText('Ana Fantasma')).toBeVisible()
  await expect(tabla.getByText('Elena PorVencer')).toBeVisible()
  await expect(tabla.getByText('Bruno Baja')).toHaveCount(0)
  await expect(tabla.getByText('Noelia BajaConCreditos')).toHaveCount(0)
  await expect(tabla.getByText('Vicky Vencida')).toHaveCount(0)
  await expect(tabla.getByText('Inactivo', { exact: true })).toHaveCount(0)

  // 4) "Por Vencer" -- solo Elena (vence en 3 días); Ana NO entra acá aunque
  // sea "Activo" -- su fecha real ya está vencida hace 40 días, no "por
  // vencer" (esaPorVencer exige 0 <= díasRestantes <= 5).
  await selectEstado.selectOption('por_vencer')
  await expect(tabla.getByText('Elena PorVencer')).toBeVisible()
  await expect(tabla.getByText('Ana Fantasma')).toHaveCount(0)
})
