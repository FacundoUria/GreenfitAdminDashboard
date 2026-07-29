import { useState } from 'react'
import { CheckCircle2, Loader2, Save } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { useConfiguracion } from '../context/useConfiguracion'
import Toggle from '../components/Toggle'

function mapConfigToForm(config) {
  return {
    precioCrossfit: String(config.precio_crossfit ?? 0),
    precioBoxeo: String(config.precio_boxeo ?? 0),
    precioKickstrike: String(config.precio_kickstrike ?? 0),
    precioAparatos: String(config.precio_aparatos ?? 0),
    diasTolerancia: String(config.dias_tolerancia ?? 5),
    limiteCancelacionHs: String(config.limite_cancelacion_hs ?? 2),
    bannerActivo: Boolean(config.banner_activo),
    bannerMensaje: config.banner_mensaje ?? '',
    aliasCvu: config.alias_cvu ?? '',
    titularCuenta: config.titular_cuenta ?? '',
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

function NumberField({ label, value, onChange, prefix, suffix }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-gray-400">{label}</label>
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 focus-within:border-greenfit-primary">
        {prefix && <span className="text-sm text-gray-500">{prefix}</span>}
        <input
          type="number"
          min="0"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full bg-transparent text-sm text-white outline-none"
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

    const { data, error: updateError } = await supabase
      .from('configuracion')
      .update({
        precio_crossfit: Number(form.precioCrossfit) || 0,
        precio_boxeo: Number(form.precioBoxeo) || 0,
        precio_kickstrike: Number(form.precioKickstrike) || 0,
        precio_aparatos: Number(form.precioAparatos) || 0,
        dias_tolerancia: Number(form.diasTolerancia) || 0,
        limite_cancelacion_hs: Number(form.limiteCancelacionHs) || 0,
        banner_activo: form.bannerActivo,
        banner_mensaje: form.bannerMensaje,
        alias_cvu: form.aliasCvu,
        titular_cuenta: form.titularCuenta,
      })
      .eq('id', 1)
      .select()

    setGuardando(false)

    // Un UPDATE bloqueado por RLS puede volver sin `error` pero sin filas afectadas.
    if (updateError || !data || data.length === 0) {
      console.error(
        'Error al guardar la configuración en Supabase:',
        updateError?.message ?? 'no se guardó ninguna fila (revisá las políticas RLS)',
      )
      setError('No se pudo guardar la configuración. Intentá nuevamente.')
      return
    }

    await onGuardado()
    setToastVisible(true)
    setTimeout(() => setToastVisible(false), 2500)
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
            label="Kickstrike"
            value={form.precioKickstrike}
            onChange={(value) => updateField('precioKickstrike', value)}
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
            value={form.limiteCancelacionHs}
            onChange={(value) => updateField('limiteCancelacionHs', value)}
            suffix="hs antes"
          />
        </ConfigCard>

        <ConfigCard title="📢 Banner / Anuncio para la App Mobile">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-400">Mostrar banner en la app</span>
            <Toggle
              checked={form.bannerActivo}
              onChange={(value) => updateField('bannerActivo', value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-400">Mensaje del anuncio</label>
            <textarea
              rows={3}
              value={form.bannerMensaje}
              onChange={(event) => updateField('bannerMensaje', event.target.value)}
              placeholder="Ej: Este viernes feriado abrimos de 9 a 13hs"
              className="resize-none rounded-lg border border-white/10 bg-greenfit-dark px-3 py-2 text-sm text-white outline-none placeholder:text-gray-600 focus:border-greenfit-primary"
            />
          </div>
        </ConfigCard>

        <ConfigCard title="💳 Cuentas de Cobro (Mostrador)">
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
