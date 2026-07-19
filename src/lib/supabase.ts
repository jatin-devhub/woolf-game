import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export function isConfigured(): boolean {
  return Boolean(url && anon && !url.includes('YOUR_') && !anon.includes('YOUR_'))
}

export const supabase: SupabaseClient = createClient(
  url || 'http://127.0.0.1:54321',
  anon || 'missing-key',
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
)

export function configError(): string | null {
  if (!url || !anon) {
    return 'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env'
  }
  return null
}
