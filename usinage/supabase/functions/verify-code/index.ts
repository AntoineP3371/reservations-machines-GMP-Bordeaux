// Edge Function : verify-code
// Vérifie un code opérateur CÔTÉ SERVEUR (le code n'est plus lisible dans le navigateur).
// Entrée POST JSON : { kind:'operateur', name, code }  ->  { ok:boolean }
// Utilise la clé de service (contourne la RLS). Créée/déployée depuis le dashboard Supabase.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const { kind, name, code } = await req.json()
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    let ok = false
    if (kind === 'operateur') {
      const { data } = await sb.from('operateurs').select('code').eq('name', name).maybeSingle()
      const stored = (data?.code ?? '').toString().trim()
      ok = stored.length > 0 && stored === (code ?? '').toString().trim()
    } else if (kind === 'encadrant') {
      const { data } = await sb.from('parametres').select('valeur').eq('cle', 'code_encadrant').maybeSingle()
      const stored = ((data?.valeur) || '0000').toString().trim()
      ok = stored === (code ?? '').toString().trim()
    }
    return new Response(JSON.stringify({ ok }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
