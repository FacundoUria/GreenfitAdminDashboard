import { useState } from 'react'
import { CheckCircle2, Loader2, Save } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { useConfiguracion } from '../context/useConfiguracion'
import { sincronizarPreciosPacks } from '../utils/preciosPwa'
import Toggle from '../components/Toggle'
import DiasCerradosCard from '../components/DiasCerradosCard'

function mapConfigToForm(config) {
  return {
    precioCrossfit: String(config.precio_crossfit ?? 0),
    precioBoxeo: String(config.precio_boxeo ?? 0),
    precioKickboxing: String(config.precio_kickboxing ?? 0),
    precioAparatos: String(config.precio_aparatos ?? 0),
    diasTolerancia: String(config.dias_tolerancia ?? 5),
    limiteCancelacionMinutos: String(config.limite_cancelacion_minutos ?? (config.limite_cancelacion_hs ?? 2) * 60),
    aliasCvu: config.alias_cvu ?? '',
    titularCuenta: config.titular_cuenta ?? '',
    notifVencimientoActivo: Boolean(config.notif_vencimiento_activo ?? true),
    notifVencimientoDiasAntes: String(config.notif_vencimiento_dias_antes ?? 3),
    notifClaseActivo: Boolean(config.notif_clase_activo ?? true),
    notifClaseHorasAntes: String(config.notif_clase_horas_antes ?? 2),
    bannerActivo: Boolean(config.banner_activo ?? false),
    bannerMensaje: config.banner_mensaje ?? '',
    bannerLinkText: config.banner_link_text ?? '',
    bannerLinkUrl: config.banner_link_url ?? '',
    alertaAppActiva: Boolean(config.alerta_app_activa ?? false),
    alertaAppMensaje: config.alerta_app_mensaje ?? '',
    whatsappNumero: config.whatsapp_numero ?? '',
    instagramUsuario: config.instagram_usuario ?? '',
  }
}

function ConfigCard({ title, children }) {
  return (
    <div className="rounded-xl border border-white/5 bg-greenfit-card p-5">
      <h3 className="mb-4 border-b border-white/5 pb-3 text-base font-semibold text-white">{title}</h3>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  )
}

function NumberField({ label, value, onChange, prefix, suffix, disabled }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-gray-400">{label}</label>
      <div
        className={`flex items-center gap-2 rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 focus-within:border-greenfit-primary ${disabled ? 'opacity-50' : ''}`}
      >
        {prefix && <span className="text-sm text-gray-500">{prefix}</span>}
        <input
          type="number"
          min="0"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="w-full bg-transparent text-sm text-white outline-none disabled:cursor-not-allowed"
        />
        {suffix && <span className="text-sm text-gray-500">{suffix}</span>}
      </div>
    </div>
  )
}

function TextField({ label, value, onChange, placeholder }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-gray-400">{label}</label>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none placeholder:text-gray-600 focus:border-greenfit-primary"
      />
    </div>
  )
}

function Toast({ message }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg bg-greenfit-card px-4 py-3 shadow-xl ring-1 ring-white/10">
      <CheckCircle2 className="h-5 w-5 text-greenfit-primary" />
      <span className="text-sm font-medium text-white">{message}</span>
    </div>
  )
}

function ConfiguracionForm({ configuracionInicial, onGuardado }) {
  const [form, setForm] = useState(() => mapConfigToForm(configuracionInicial))
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  const [toastVisible, setToastVisible] = useState(false)

  const updateField = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const handleGuardar = async () => {
    setGuardando(true)
    setError(null)

    const precios = {
      precio_crossfit: Number(form.precioCrossfit) || 0,
      precio_boxeo: Number(form.precioBoxeo) || 0,
      precio_kickboxing: Number(form.precioKickboxing) || 0,
      precio_aparatos: Number(form.precioAparatos) || 0,
    }

    const { data, error: updateError } = await supabase
      .from('configuracion')
      .update({
        ...precios,
        dias_tolerancia: Number(form.diasTolerancia) || 0,
        limite_cancelacion_minutos: Number(form.limiteCancelacionMinutos) || 0,
        alias_cvu: form.aliasCvu,
        titular_cuenta: form.titularCuenta,
        notif_vencimiento_activo: form.notifVencimientoActivo,
        notif_vencimiento_dias_antes: Number(form.notifVencimientoDiasAntes) || 0,
        notif_clase_activo: form.notifClaseActivo,
        notif_clase_horas_antes: Number(form.notifClaseHorasAntes) || 0,
        banner_activo: form.bannerActivo,
        banner_mensaje: form.bannerMensaje.trim(),
        banner_link_text: form.bannerLinkText.trim() || null,
        banner_link_url: form.bannerLinkUrl.trim() || null,
        alerta_app_activa: form.alertaAppActiva,
        alerta_app_mensaje: form.alertaAppMensaje.trim(),
        whatsapp_numero: form.whatsappNumero.trim(),
        instagram_usuario: form.instagramUsuario.trim(),
      })
      .eq('id', 1)
      .select()

    // Un UPDATE bloqueado por RLS puede volver sin `error` pero sin filas afectadas.
    if (updateError || !data || data.length === 0) {
      console.error(
        'Error al guardar la configuración en Supabase:',
        updateError?.message ?? 'no se guardó ninguna fila (revisá las políticas RLS)',
      )
      setError('No se pudo guardar la configuración. Intentá nuevamente.')
      setGuardando(false)
      return
    }

    // Los precios que ve el socio en "Elegí tu pack" salen de `packs.price`,
    // no de esta tabla -- sin este paso, Configuración y la PWA vuelven a
    // desincronizarse apenas se edita un precio.
    const resultadoSync = await sincronizarPreciosPacks(precios)

    setGuardando(false)
    await onGuardado()
    setToastVisible(true)
    setTimeout(() => setToastVisible(false), 2500)

    if (!resultadoSync.synced) {
      window.alert(
        `Se guardó la configuración, pero no se pudo sincronizar el precio de: ${resultadoSync.errores.join(', ')}. Revisá la consola.`,
      )
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Configuración del Gimnasio</h2>
          <p className="text-sm text-gray-400">Precios, reglas de negocio y datos para cobros.</p>
        </div>
        <button
          type="button"
          onClick={handleGuardar}
          disabled={guardando}
          className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          <Save className="h-4 w-4" />
          {guardando ? 'Guardando...' : 'Guardar Cambios'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ConfigCard title="💰 Planes y Precios">
          <p className="-mt-2 text-xs text-gray-500">
            Estos valores son la única fuente de verdad: se reflejan automáticamente en "Elegí tu pack" de la
            app de socios.
          </p>
          <NumberField
            label="CrossFit"
            value={form.precioCrossfit}
            onChange={(value) => updateField('precioCrossfit', value)}
            prefix="$"
          />
          <NumberField
            label="Boxeo"
            value={form.precioBoxeo}
            onChange={(value) => updateField('precioBoxeo', value)}
            prefix="$"
          />
          <NumberField
            label="Kickboxing"
            value={form.precioKickboxing}
            onChange={(value) => updateField('precioKickboxing', value)}
            prefix="$"
          />
          <NumberField
            label="Aparatos / Musculación"
            value={form.precioAparatos}
            onChange={(value) => updateField('precioAparatos', value)}
            prefix="$"
          />
        </ConfigCard>

        <ConfigCard title="⏳ Reglas de Negocio">
          <NumberField
            label="Días de tolerancia de pago"
            value={form.diasTolerancia}
            onChange={(value) => updateField('diasTolerancia', value)}
            suffix="días"
          />
          <NumberField
            label="Límite para cancelar una clase"
            value={form.limiteCancelacionMinutos}
            onChange={(value) => updateField('limiteCancelacionMinutos', value)}
            suffix="min antes"
          />
        </ConfigCard>

        <ConfigCard title="💳 Cuentas de Cobro (Mostrador)">
          <p className="-mt-2 text-xs text-gray-500">
            Se muestran en la app de socios al momento de pagar o renovar por transferencia.
          </p>
          <TextField
            label="Alias / CVU"
            value={form.aliasCvu}
            onChange={(value) => updateField('aliasCvu', value)}
            placeholder="greenfit.gym"
          />
          <TextField
            label="Nombre del Titular"
            value={form.titularCuenta}
            onChange={(value) => updateField('titularCuenta', value)}
            placeholder="Greenfit SRL"
          />
        </ConfigCard>

        <ConfigCard title="🔔 Notificaciones y Recordatorios">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-400">Recordatorio de vencimiento de cuota</span>
            <Toggle
              checked={form.notifVencimientoActivo}
              onChange={(value) => updateField('notifVencimientoActivo', value)}
            />
          </div>
          <NumberField
            label="Avisar"
            value={form.notifVencimientoDiasAntes}
            onChange={(value) => updateField('notifVencimientoDiasAntes', value)}
            suffix="días antes"
            disabled={!form.notifVencimientoActivo}
          />

          <div className="mt-2 flex items-center justify-between gap-3 border-t border-white/5 pt-4">
            <span className="text-sm text-gray-400">Recordatorio de clase reservada</span>
            <Toggle
              checked={form.notifClaseActivo}
              onChange={(value) => updateField('notifClaseActivo', value)}
            />
          </div>
          <NumberField
            label="Recordar clase"
            value={form.notifClaseHorasAntes}
            onChange={(value) => updateField('notifClaseHorasAntes', value)}
            suffix="hs antes"
            disabled={!form.notifClaseActivo}
          />
        </ConfigCard>

        <ConfigCard title="📢 Banner de Anuncios">
          <p className="-mt-2 text-xs text-gray-500">
            Es la barra verde que aparece arriba de todo en la landing. Si está desactivado, o el mensaje queda
            vacío, la landing no muestra nada ahí.
          </p>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-400">Mostrar banner en la landing</span>
            <Toggle checked={form.bannerActivo} onChange={(value) => updateField('bannerActivo', value)} />
          </div>
          <TextField
            label="Mensaje"
            value={form.bannerMensaje}
            onChange={(value) => updateField('bannerMensaje', value)}
            placeholder="Ej: ¡Nuevo horario sábados! Aparatos también de 10 a 13 hs"
          />
          <TextField
            label="Texto del link (opcional)"
            value={form.bannerLinkText}
            onChange={(value) => updateField('bannerLinkText', value)}
            placeholder="Ej: Ver horarios completos"
          />
          <TextField
            label="URL del link (opcional)"
            value={form.bannerLinkUrl}
            onChange={(value) => updateField('bannerLinkUrl', value)}
            placeholder="Ej: https://greenfit.fit/#clases"
          />
        </ConfigCard>

        <ConfigCard title="🔔 Alerta Global (App de Socios)">
          <p className="-mt-2 text-xs text-gray-500">
            Es un aviso flotante que se muestra al abrir la app de socios (PWA) -- distinto del banner de la
            landing de arriba, esta audiencia es solo la gente ya logueada en la app.
          </p>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-400">Mostrar alerta en la app de socios</span>
            <Toggle checked={form.alertaAppActiva} onChange={(value) => updateField('alertaAppActiva', value)} />
          </div>
          <TextField
            label="Mensaje"
            value={form.alertaAppMensaje}
            onChange={(value) => updateField('alertaAppMensaje', value)}
            placeholder="Ej: El sábado el gimnasio cierra a las 14 hs por mantenimiento"
          />
        </ConfigCard>

        <ConfigCard title="📱 Redes Sociales">
          <p className="-mt-2 text-xs text-gray-500">
            Se usan para todos los links e íconos de WhatsApp/Instagram de la landing (header, botón flotante,
            contacto y footer).
          </p>
          <TextField
            label="WhatsApp (solo número, con código de país)"
            value={form.whatsappNumero}
            onChange={(value) => updateField('whatsappNumero', value)}
            placeholder="Ej: 5492617139662"
          />
          <TextField
            label="Usuario de Instagram (sin @)"
            value={form.instagramUsuario}
            onChange={(value) => updateField('instagramUsuario', value)}
            placeholder="Ej: green_fitargentina"
          />
        </ConfigCard>

        <DiasCerradosCard />
      </div>

      {toastVisible && <Toast message="Cambios guardados correctamente" />}
    </div>
  )
}

function Configuracion() {
  const { configuracion, loading, refetch } = useConfiguracion()

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl bg-greenfit-card p-10 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Cargando configuración...
      </div>
    )
  }

  return <ConfiguracionForm configuracionInicial={configuracion} onGuardado={refetch} />
}

export default Configuracion
