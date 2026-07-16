// Edge Function : demande-op
// Écritures des demandes d'impression 3D, avec vérification CÔTÉ SERVEUR.
// Auth par action :
//   create  : public (mais la LIMITE par projet est vérifiée côté serveur)
//   valider : code encadrant
//   lancer / statut / archive / reorder : code opérateur (nom + code)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const b = await req.json()
    const action = b.action
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const opOk = async (name?: string, code?: string) => {
      if (!name || !code) return false
      const { data } = await sb.from('operateurs').select('code').eq('name', name).maybeSingle()
      const s = (data?.code ?? '').toString().trim()
      return s.length > 0 && s === code.toString().trim()
    }
    const encOk = async (code?: string) => {
      const { data } = await sb.from('parametres').select('valeur').eq('cle', 'code_encadrant').maybeSingle()
      return ((data?.valeur) || '0000').toString().trim() === (code ?? '').toString().trim()
    }

    if (action === 'create') {
      const d = b.demande || {}
      const projet = (d.projet ?? '').toString()
      if (!projet) return json({ ok: false, error: 'no projet' }, 400)
      // Limite par projet (vérifiée serveur)
      const { data: params } = await sb.from('parametres').select('cle, valeur')
      let limDef = 10
      let limMap: Record<string, any> = {}
      for (const p of (params || []) as any[]) {
        if (p.cle === 'limite_defaut') { const n = parseInt(p.valeur); if (n) limDef = n }
        if (p.cle === 'limites_projets') { try { limMap = JSON.parse(p.valeur) || {} } catch (_) {} }
      }
      const lim = (limMap[projet] != null) ? Number(limMap[projet]) : limDef
      const { count } = await sb.from('demandes').select('id', { count: 'exact', head: true }).eq('projet', projet)
      if ((count || 0) >= lim) return json({ ok: false, error: 'limit', lim })
      const ins = await sb.from('demandes').insert(d)
      if (ins.error) throw ins.error
      return json({ ok: true })
    }

    if (action === 'valider') {
      if (!(await encOk(b.encadrantCode))) return json({ ok: false, error: 'auth' }, 401)
      const patch = {
        statut: b.ok ? 'validee' : 'refusee',
        encadrant_nom: (b.encadrantNom ?? '').toString(),
        encadrant_valide_at: new Date().toISOString(),
        encadrant_commentaire: (b.commentaire ?? '').toString(),
      }
      const { data, error } = await sb.from('demandes').update(patch).eq('id', b.id).select().single()
      if (error) throw error
      return json({ ok: true, demande: data })
    }

    if (action === 'lancer') {
      if (!(await opOk(b.operateur, b.opCode))) return json({ ok: false, error: 'auth' }, 401)
      const { error } = await sb.from('demandes').update({
        statut: 'en_cours', duree_reelle_min: b.duree, en_cours_at: new Date().toISOString(),
        imprime_at: null, operateur_nom: (b.operateur ?? '').toString(),
      }).eq('id', b.id)
      if (error) throw error
      return json({ ok: true })
    }

    if (action === 'statut') {
      if (!(await opOk(b.operateur, b.opCode))) return json({ ok: false, error: 'auth' }, 401)
      const patch: any = { statut: b.statut, operateur_nom: (b.operateur ?? '').toString() }
      if (b.statut === 'imprimee') patch.imprime_at = new Date().toISOString()
      if (b.statut === 'validee') { patch.en_cours_at = null; patch.imprime_at = null }
      const { error } = await sb.from('demandes').update(patch).eq('id', b.id)
      if (error) throw error
      return json({ ok: true })
    }

    if (action === 'archive') {
      if (!(await opOk(b.operateur, b.opCode))) return json({ ok: false, error: 'auth' }, 401)
      const { error } = await sb.from('demandes').update({ archive: !!b.archive }).eq('id', b.id)
      if (error) throw error
      return json({ ok: true })
    }

    if (action === 'reorder') {
      if (!(await opOk(b.operateur, b.opCode))) return json({ ok: false, error: 'auth' }, 401)
      const res = await sb.from('demandes').select('*').eq('statut', 'validee')
      if (res.error) throw res.error
      const data = (res.data || []).filter((d: any) => !d.archive)
      data.sort((a: any, c: any) => {
        if ((c.priorite || 0) !== (a.priorite || 0)) return (c.priorite || 0) - (a.priorite || 0)
        return new Date(a.created_at).getTime() - new Date(c.created_at).getTime()
      })
      const i = data.findIndex((d: any) => d.id === b.id)
      const j = i + (b.dir || 0)
      if (i < 0 || j < 0 || j >= data.length) return json({ ok: true })
      const tmp = data[i]; data[i] = data[j]; data[j] = tmp
      for (let k = 0; k < data.length; k++) {
        const up = await sb.from('demandes').update({ priorite: (data.length - k) * 10 }).eq('id', data[k].id)
        if (up.error) throw up.error
      }
      return json({ ok: true })
    }

    return json({ ok: false, error: 'bad action' }, 400)
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500)
  }
})
