// Edge Function : admin-op
// Écritures réservées à l'ADMIN sur le planning (machines, blocages, actions admin sur réservations).
// Le mot de passe admin est vérifié par son empreinte SHA-256 (variable d'env ADMIN_PW_HASH).
// Entrée POST JSON : { action, adminCode, ...params }
//
// Actions (étape 2a) :
//   saveMachines  { machines:[{name,color,position}], renames:[{from,to}] }
//   machineStatus { machine, status, status_reason, status_date }
// (d'autres actions — blocages, réservations admin, undo/redo — seront ajoutées à l'étape 2b)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const body = await req.json()
    const { action, adminCode } = body

    // Authentification admin
    const expected = (Deno.env.get('ADMIN_PW_HASH') || '').trim()
    if (!expected || (await sha256hex((adminCode ?? '').toString())) !== expected) {
      return json({ ok: false, error: 'unauthorized' }, 401)
    }

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    if (action === 'saveMachines') {
      const machines = (body.machines || []) as any[]
      const renames = (body.renames || []) as any[]
      // conserver les statuts (panne) par nom
      const backup = (await sb.from('machines').select('*')).data || []
      const st: Record<string, any> = {}
      for (const m of backup as any[]) st[m.name] = { status: m.status || 'ok', status_reason: m.status_reason || '', status_date: m.status_date || null }
      const del = await sb.from('machines').delete().neq('name', '__never__')
      if (del.error) throw del.error
      const rows = machines
        .filter((m) => (m?.name ?? '').toString().trim())
        .map((m, i) => ({
          name: m.name.toString().trim(),
          color: (m.color || '#3b82f6').toString(),
          position: Number.isFinite(m.position) ? m.position : i,
          status: st[m.name]?.status || 'ok',
          status_reason: st[m.name]?.status_reason || '',
          status_date: st[m.name]?.status_date || null,
        }))
      if (rows.length) {
        const ins = await sb.from('machines').insert(rows)
        if (ins.error) { if (backup.length) await sb.from('machines').insert(backup); throw ins.error }
      }
      // propager les renommages aux réservations et créneaux bloqués
      for (const r of renames) {
        if (r?.from && r?.to && r.from !== r.to) {
          await sb.from('bookings').update({ machine: r.to }).eq('machine', r.from)
          await sb.from('disabled_slots').update({ machine: r.to }).eq('machine', r.from)
        }
      }
      return json({ ok: true })
    }

    if (action === 'machineStatus') {
      const { machine, status, status_reason, status_date } = body
      const { error } = await sb.from('machines')
        .update({ status, status_reason: status_reason || '', status_date: status_date || null })
        .eq('name', machine)
      if (error) throw error
      return json({ ok: true })
    }

    if (action === 'block') {
      const { machine, date, slot, reason } = body
      const { error } = await sb.from('disabled_slots').insert({ machine, date, slot, reason: reason || '' })
      if (error && error.code !== '23505') throw error   // ignore doublon
      return json({ ok: true })
    }

    if (action === 'unblock') {
      const { machine, date, slot } = body
      const { error } = await sb.from('disabled_slots').delete().match({ machine, date, slot })
      if (error) throw error
      return json({ ok: true })
    }

    if (action === 'blockHalfDay') {
      const { machine, date, slots, reason } = body
      // ne bloque pas un créneau déjà réservé
      const booked = (await sb.from('bookings').select('slot').eq('machine', machine).eq('date', date)).data || []
      const bookedSet = new Set((booked as any[]).map((x) => x.slot))
      let count = 0
      for (const slot of (slots || [])) {
        if (bookedSet.has(slot)) continue
        const { error } = await sb.from('disabled_slots').insert({ machine, date, slot, reason: reason || '' })
        if (!error || error.code === '23505') count++
      }
      return json({ ok: true, count })
    }

    return json({ ok: false, error: 'bad action' }, 400)
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500)
  }
})
