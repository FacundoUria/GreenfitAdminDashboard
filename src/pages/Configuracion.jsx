import { useState } from 'react'
import { CheckCircle2, Pencil, Save } from 'lucide-react'
import Toggle from '../components/Toggle'

const configInicial = {
  reservas: {
    reservaDesde: '9 hs antes',
    cierreReserva: 'Sin límite',
    cancelacion: 'Hasta 15 min antes',
    agendaVisible: '2 días',
    consentimientoLegal: true,
    aptoFisico: true,
  },
  clases: {
    cargaAutomatica: 'Activa (14 días)',
    ausentesAutomaticos: true,
    moduloProfesores: false,
  },
  pagos: {
    altaDesdeApp: true,
    mercadoPagoConectado: true,
    emailComprobantes: 'facturacion@greenfit.fit',
  },
  vencimientos: {
    autoRenovacion: false,
    plazoPago: 'Activa (15 días de tolerancia)',
  },
}

function TextField({ label, value, editing, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-sm text-gray-400">{label}</span>
      {editing ? (
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-40 rounded-lg border border-white/10 bg-greenfit-dark px-2.5 py-1.5 text-right text-sm text-white outline-none focus:border-greenfit-primary"
        />
      ) : (
        <span className="text-sm font-medium text-white">{value}</span>
      )}
    </div>
  )
}

function ToggleField({ label, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-sm text-gray-400">{label}</span>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  )
}

function ConfigCard({ title, editing, onToggleEdit, children }) {
  return (
    <div className="rounded-xl border border-white/5 bg-greenfit-card p-5">
      <div className="mb-2 flex items-center justify-between border-b border-white/5 pb-3">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <button
          type="button"
          onClick={onToggleEdit}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            editing
              ? 'border-greenfit-primary text-greenfit-primary hover:bg-greenfit-primary/10'
              : 'border-white/10 text-gray-300 hover:bg-white/5 hover:text-white'
          }`}
        >
          <Pencil className="h-3.5 w-3.5" />
          {editing ? 'Listo' : 'Editar'}
        </button>
      </div>
      <div className="divide-y divide-white/5">{children}</div>
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

function Configuracion() {
  const [config, setConfig] = useState(configInicial)
  const [editingCard, setEditingCard] = useState(null)
  const [toastVisible, setToastVisible] = useState(false)

  const updateField = (card, field, value) => {
    setConfig((prev) => ({
      ...prev,
      [card]: { ...prev[card], [field]: value },
    }))
  }

  const toggleEdit = (card) => {
    setEditingCard((prev) => (prev === card ? null : card))
  }

  const handleGuardarCambios = () => {
    setEditingCard(null)
    setToastVisible(true)
    setTimeout(() => setToastVisible(false), 2500)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Configuración del Gimnasio</h2>
          <p className="text-sm text-gray-400">Administrá las reglas de reservas, clases, pagos y vencimientos.</p>
        </div>
        <button
          type="button"
          onClick={handleGuardarCambios}
          className="flex items-center gap-2 rounded-lg bg-greenfit-primary px-4 py-2 text-sm font-semibold text-greenfit-dark transition-opacity hover:opacity-90"
        >
          <Save className="h-4 w-4" />
          Guardar Cambios
        </button>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ConfigCard
          title="Reservas"
          editing={editingCard === 'reservas'}
          onToggleEdit={() => toggleEdit('reservas')}
        >
          <TextField
            label="Reserva desde"
            value={config.reservas.reservaDesde}
            editing={editingCard === 'reservas'}
            onChange={(value) => updateField('reservas', 'reservaDesde', value)}
          />
          <TextField
            label="Cierre de reserva"
            value={config.reservas.cierreReserva}
            editing={editingCard === 'reservas'}
            onChange={(value) => updateField('reservas', 'cierreReserva', value)}
          />
          <TextField
            label="Cancelación"
            value={config.reservas.cancelacion}
            editing={editingCard === 'reservas'}
            onChange={(value) => updateField('reservas', 'cancelacion', value)}
          />
          <TextField
            label="Agenda visible"
            value={config.reservas.agendaVisible}
            editing={editingCard === 'reservas'}
            onChange={(value) => updateField('reservas', 'agendaVisible', value)}
          />
          <ToggleField
            label="Consentimiento Legal"
            checked={config.reservas.consentimientoLegal}
            onChange={(value) => updateField('reservas', 'consentimientoLegal', value)}
          />
          <ToggleField
            label="Apto Físico"
            checked={config.reservas.aptoFisico}
            onChange={(value) => updateField('reservas', 'aptoFisico', value)}
          />
        </ConfigCard>

        <ConfigCard
          title="Clases"
          editing={editingCard === 'clases'}
          onToggleEdit={() => toggleEdit('clases')}
        >
          <TextField
            label="Carga automática de clases"
            value={config.clases.cargaAutomatica}
            editing={editingCard === 'clases'}
            onChange={(value) => updateField('clases', 'cargaAutomatica', value)}
          />
          <ToggleField
            label="Ausentes automáticos"
            checked={config.clases.ausentesAutomaticos}
            onChange={(value) => updateField('clases', 'ausentesAutomaticos', value)}
          />
          <ToggleField
            label="Módulo de profesores"
            checked={config.clases.moduloProfesores}
            onChange={(value) => updateField('clases', 'moduloProfesores', value)}
          />
        </ConfigCard>

        <ConfigCard
          title="Pagos y Cobros"
          editing={editingCard === 'pagos'}
          onToggleEdit={() => toggleEdit('pagos')}
        >
          <ToggleField
            label="Alta desde la app"
            checked={config.pagos.altaDesdeApp}
            onChange={(value) => updateField('pagos', 'altaDesdeApp', value)}
          />
          <div className="flex items-center justify-between gap-3 py-2">
            <span className="text-sm text-gray-400">Mercado Pago</span>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                config.pagos.mercadoPagoConectado
                  ? 'bg-greenfit-primary/15 text-greenfit-primary'
                  : 'bg-red-500/15 text-red-400'
              }`}
            >
              {config.pagos.mercadoPagoConectado ? 'Credenciales conectadas' : 'Sin conectar'}
            </span>
          </div>
          <TextField
            label="Email de comprobantes"
            value={config.pagos.emailComprobantes}
            editing={editingCard === 'pagos'}
            onChange={(value) => updateField('pagos', 'emailComprobantes', value)}
          />
        </ConfigCard>

        <ConfigCard
          title="Vencimientos y Deuda"
          editing={editingCard === 'vencimientos'}
          onToggleEdit={() => toggleEdit('vencimientos')}
        >
          <ToggleField
            label="Auto-renovación"
            checked={config.vencimientos.autoRenovacion}
            onChange={(value) => updateField('vencimientos', 'autoRenovacion', value)}
          />
          <TextField
            label="Plazo de pago / suspensión"
            value={config.vencimientos.plazoPago}
            editing={editingCard === 'vencimientos'}
            onChange={(value) => updateField('vencimientos', 'plazoPago', value)}
          />
        </ConfigCard>
      </div>

      {toastVisible && <Toast message="Cambios guardados correctamente" />}
    </div>
  )
}

export default Configuracion
