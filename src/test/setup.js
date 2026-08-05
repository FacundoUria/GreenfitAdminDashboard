import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Sin `globals: true` en vite.config.js, @testing-library/react no detecta
// solo un `afterEach` global para su auto-cleanup -- sin esto, el DOM de un
// test queda montado para el siguiente DENTRO DEL MISMO ARCHIVO, y
// getByText/queryByText empiezan a "encontrar 2 elementos" que en realidad
// son de tests distintos acumulados.
afterEach(() => {
  cleanup()
})

// src/lib/supabaseClient.js llama a createClient() al importarse y avisa
// (console.warn) si faltan las env vars -- en test no hay .env real, les
// ponemos un valor dummy para que ese warning no ensucie la salida de cada
// test (ningún test abre una conexión real: cada uno mockea `supabase`
// explícitamente con vi.mock).
import.meta.env.VITE_SUPABASE_URL ||= 'https://test.supabase.co'
import.meta.env.VITE_SUPABASE_ANON_KEY ||= 'test-anon-key'
