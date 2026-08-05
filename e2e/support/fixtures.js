// Fixtures compartidas entre specs -- un socio de prueba con ficha completa
// (socios + profiles + xp_events) para poder probar Ficha 360°, la tabla
// principal y el Check-in Rápido sin pisarse entre tests.

export const SOCIO_MARTINA = {
  id: 'e2e-socio-martina',
  nombre: 'Martina',
  apellido: 'Ríos',
  dni: '30111222',
  email: 'martina@e2e.test',
  telefono: '2610000000',
  plan: ['CrossFit'],
  estado: 'Activo',
  fecha_vencimiento: null,
  dia_corte: null,
  created_at: '2025-01-15T00:00:00.000Z',
  ultimo_pago: '2026-07-01',
  creditos: 4,
  activo: true,
}

export const PROFILE_MARTINA = {
  id: 'e2e-profile-martina',
  dni: SOCIO_MARTINA.dni,
  full_name: 'Martina Ríos',
  avatar_url: 'https://e2e-mock.supabase.co/storage/v1/object/public/avatars/martina/avatar.jpg',
  created_at: '2025-01-15T00:00:00.000Z',
  role: 'socio',
}

// 700 + 450 = 1150 XP -> NIVEL 3 (misma fórmula 500 XP/nivel que la PWA).
export const XP_EVENTS_MARTINA = [
  { id: 'xp-1', user_id: PROFILE_MARTINA.id, event_type: 'asistencia', xp_amount: 700, event_date: '2026-08-01', reference_id: 'booking-1' },
  { id: 'xp-2', user_id: PROFILE_MARTINA.id, event_type: 'asistencia', xp_amount: 450, event_date: '2026-08-02', reference_id: null },
]

export const DISCIPLINA_CROSSFIT = { id: 'disc-crossfit', name: 'CrossFit', kind: 'credits' }
export const DISCIPLINA_APARATOS = { id: 'disc-aparatos', name: 'Aparatos', kind: 'membership' }

export function tablasBase() {
  return {
    socios: [SOCIO_MARTINA],
    profiles: [PROFILE_MARTINA],
    xp_events: [...XP_EVENTS_MARTINA],
    disciplines: [DISCIPLINA_CROSSFIT, DISCIPLINA_APARATOS],
    configuracion: [{ id: 1, dias_tolerancia: 5, limite_cancelacion_minutos: 120, alias_cvu: null, titular_cuenta: null }],
    bookings: [],
    classes: [],
    routines: [],
    pagos_socio: [],
  }
}
