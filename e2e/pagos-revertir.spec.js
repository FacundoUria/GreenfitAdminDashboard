import { test, expect } from '@playwright/test'
import { loginComoAdmin } from './support/auth.js'
import { DISCIPLINA_APARATOS, DISCIPLINA_CROSSFIT, tablasBase } from './support/fixtures.js'

// Pagos -- Revertir un comprobante (regla F, ver
// supabase_migration_fix_revertir_comprobante_regla_f.sql). El flujo para
// Seba es el mismo de siempre (Revertir -> confirmar -> resultado); lo que
// se prueba acá es que cada resultado se vea, y que nada quede en silencio:
//   - sin avisos: toast verde
//   - con avisos: banner fijo, un aviso por línea, hasta que lo cierra
//   - ya revertido (otra pestaña): alert y la lista se recarga
//   - la RPC no pudo identificar algo: el error completo queda bajo ESA fila

const PACK_COMBO = {
  id: 'pack-combo',
  name: 'Combo Aparatos + 12 CrossFit',
  creditos: [{ discipline_id: DISCIPLINA_CROSSFIT.id, credits: 12 }],
  incluye_aparatos: true,
  dias_vigencia: 30,
}

function comprobante(extra) {
  return {
    id: 'pago-bruno',
    user_id: 'e2e-profile-bruno',
    paquete: PACK_COMBO.name,
    monto: 30000,
    pack_id: PACK_COMBO.id,
    comprobante_url: null,
    created_at: '2026-10-06T13:00:00.000Z',
    estado: 'pagado',
    reviewed_at: null,
    origen: 'transferencia_comprobante',
    detalle_acreditacion: {
      creditos: [{ discipline_id: DISCIPLINA_CROSSFIT.id, credits_otorgados: 12, lote_id: 'lote-1' }],
      aparatos: { discipline_id: DISCIPLINA_APARATOS.id, fecha_vencimiento_antes: null, fecha_vencimiento_despues: '2026-11-05' },
    },
    // El mock no resuelve joins: los embebidos van a mano, como los devolvería PostgREST.
    profiles: { full_name: 'Bruno Álvarez' },
    packs: PACK_COMBO,
    ...extra,
  }
}

// La RPC "real" del mock: si devuelve OK, deja el pago anulado en la tabla
// (así la recarga de la lista muestra lo mismo que mostraría producción).
function rpcRevertir(tablas, respuesta) {
  return () => {
    if (respuesta.__e2eError) return respuesta
    const fila = respuesta[0]
    if (fila.reversion_ok) {
      const pago = tablas.pagos_socio.find((p) => p.id === 'pago-bruno')
      pago.estado = 'anulado'
      pago.reviewed_at = '2026-10-07T15:00:00.000Z'
    }
    return respuesta
  }
}

async function abrirPagos(page, respuesta, pagos = [comprobante()]) {
  const tablas = { ...tablasBase(), pagos_socio: pagos }
  const llamadas = []
  const rpc = {
    admin_revertir_comprobante: async (request) => {
      llamadas.push(request.postDataJSON())
      return rpcRevertir(tablas, respuesta)()
    },
  }
  await loginComoAdmin(page, { tables: tablas, rpc })
  await page.getByRole('link', { name: 'Pagos', exact: true }).click()
  await expect(page.getByText('Bruno Álvarez')).toBeVisible()
  return { tablas, llamadas }
}

function filaBruno(page) {
  return page.getByRole('listitem').filter({ hasText: 'Bruno Álvarez' })
}

test.describe('Pagos -- Revertir comprobante (regla F)', () => {
  test('la confirmación dice qué se vence y que no vuelve el plan anterior; sin avisos muestra el toast y la fila queda Anulado', async ({ page }) => {
    const { llamadas } = await abrirPagos(page, [{ reversion_ok: true, aparatos_advertencia: null }])

    let textoConfirm = ''
    page.once('dialog', async (dialog) => {
      textoConfirm = dialog.message()
      await dialog.accept()
    })
    await filaBruno(page).getByRole('button', { name: 'Revertir' }).click()

    await expect(page.getByText('Acreditación revertida -- se le quitó lo que quedaba sin usar a Bruno Álvarez.')).toBeVisible()
    expect(textoConfirm).toContain('Se le va a quitar: Aparatos + 12 créditos CrossFit.')
    expect(textoConfirm).toContain('Se le vence ya todo lo que dio este pago, incluido Aparatos.')
    expect(textoConfirm).toContain('No se le devuelve el plan anterior.')
    expect(textoConfirm).toContain('Las reservas futuras no se cancelan.')
    expect(llamadas).toEqual([{ p_pagos_socio_id: 'pago-bruno' }])

    await page.getByRole('button', { name: 'Actualizar historial de comprobantes' }).click()
    await expect(filaBruno(page).getByText('Anulado')).toBeVisible()
    await expect(filaBruno(page).getByText(/^Revertido /)).toBeVisible()
    await expect(filaBruno(page).getByRole('button', { name: 'Revertir' })).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('con avisos: banner fijo con un aviso por línea, sin toast, y se cierra con la X', async ({ page }) => {
    const avisos = [
      'El Aparatos de este pago tenía la fecha cambiada a mano (vencía el 21/11/2026): igual se le venció.',
      'Tiene 1 reserva(s) futura(s) pagada(s) con créditos de este pago (CrossFit 19hs del 09/10): no se cancelaron. Si se cancelan, el crédito no vuelve porque el lote quedó vencido.',
      'Sigue vigente (no es de este pago, no se tocó): Boxeo (3 créditos) hasta el 06/11/2026.',
    ]
    await abrirPagos(page, [{ reversion_ok: true, aparatos_advertencia: avisos.join(' | ') }])

    page.once('dialog', (dialog) => dialog.accept())
    await filaBruno(page).getByRole('button', { name: 'Revertir' }).click()

    const banner = page.getByRole('alert')
    await expect(banner).toBeVisible()
    await expect(banner.getByText('Bruno Álvarez: acreditación revertida, con avisos')).toBeVisible()
    await expect(banner.getByRole('listitem')).toHaveText(avisos)
    await expect(page.getByText(/Acreditación revertida --/)).toHaveCount(0)

    // No se va solo (el toast dura 2,5 s; el banner tiene que seguir).
    await page.waitForTimeout(3000)
    await expect(banner).toBeVisible()

    await page.getByLabel('Cerrar advertencia').click()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('ya revertido desde otra pestaña: alert y la lista se recarga', async ({ page }) => {
    const { tablas } = await abrirPagos(page, [
      { reversion_ok: false, aparatos_advertencia: 'Este pago ya estaba revertido: no se cambió nada.' },
    ])
    // Otra pestaña ya lo anuló: la recarga tiene que mostrarlo así.
    let textoAlert = ''
    page.once('dialog', (dialog) => {
      page.once('dialog', async (alerta) => {
        textoAlert = alerta.message()
        tablas.pagos_socio[0].estado = 'anulado'
        tablas.pagos_socio[0].reviewed_at = '2026-10-07T14:00:00.000Z'
        await alerta.accept()
      })
      return dialog.accept()
    })
    await filaBruno(page).getByRole('button', { name: 'Revertir' }).click()

    await expect(filaBruno(page).getByText('Anulado')).toBeVisible()
    expect(textoAlert).toContain('ya había sido revertido antes')
  })

  test('la RPC no pudo identificar algo: el error completo queda bajo esa fila, sigue Pagado y con el botón', async ({ page }) => {
    const mensaje =
      'No se pudo revertir: el lote de créditos de CrossFit que figura en este pago no lo creó este pago (puede ser un comprobante de antes del 10/09, cuando los créditos se sumaban a un lote existente). No se cambió nada: corregí los créditos a mano desde Socios.'
    await abrirPagos(page, { __e2eError: { status: 400, body: { code: 'P0001', message: mensaje } } })

    page.once('dialog', (dialog) => dialog.accept())
    await filaBruno(page).getByRole('button', { name: 'Revertir' }).click()

    await expect(filaBruno(page).getByText(mensaje)).toBeVisible()
    await expect(filaBruno(page).getByText('Pagado')).toBeVisible()
    await expect(filaBruno(page).getByRole('button', { name: 'Revertir' })).toBeEnabled()
    await expect(page.getByText(/Acreditación revertida/)).toHaveCount(0)
  })

  test('cancelar la confirmación no llama a la RPC', async ({ page }) => {
    const { llamadas } = await abrirPagos(page, [{ reversion_ok: true, aparatos_advertencia: null }])

    page.once('dialog', (dialog) => dialog.dismiss())
    await filaBruno(page).getByRole('button', { name: 'Revertir' }).click()

    await page.waitForTimeout(500)
    expect(llamadas).toHaveLength(0)
    await expect(filaBruno(page).getByText('Pagado')).toBeVisible()
  })

  test('doble click: una sola llamada a la RPC', async ({ page }) => {
    const { llamadas } = await abrirPagos(page, [{ reversion_ok: true, aparatos_advertencia: null }])

    page.on('dialog', (dialog) => dialog.accept())
    const boton = filaBruno(page).getByRole('button', { name: 'Revertir' })
    await boton.dblclick()

    await expect(page.getByText(/Acreditación revertida --/)).toBeVisible()
    expect(llamadas).toHaveLength(1)
  })
})
