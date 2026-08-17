import { createReadStream, existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import pg from 'pg'

const { Pool } = pg
const mediaHosts = new Set(['cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'raw.githubusercontent.com', 'images.unsplash.com'])
const root = fileURLToPath(new URL('.', import.meta.url))
const dist = join(root, 'dist')
const port = Number(process.env.PORT || 10000)
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined }) : null

const defaultContent = {
  about: { kicker: '02 / HAKKIMDA', title: 'Sadece sonuç değil, sistem inşa ediyoruz.', text: 'Eren Başoğlu Coaching; antrenman, beslenme ve zihinsel dayanıklılığı tek bir sürdürülebilir sistemde birleştirir.', number: '01', subTitle: 'Herkese uyan tek bir plan yok.', paragraphOne: 'Vücudun, hayatın, hedeflerin ve geçmişin sana özel.', paragraphTwo: 'Sürecin her aşamasında veriye ve gerçek hayata göre ilerliyoruz.', cta: 'Birlikte başlayalım' },
  services: { intro: 'İhtiyacına göre şekillenen koçluk modelleri.', personal: 'Hedefine özel antrenman planı ve düzenli takip.', nutrition: 'Günlük yaşamına uyumlu kişisel beslenme sistemi.', transformation: 'Antrenman, beslenme ve alışkanlık takibini birleştiren kapsamlı koçluk.' },
  faqs: [],
}

async function initDatabase() {
  if (!pool) return
  await pool.query(`CREATE TABLE IF NOT EXISTS site_content (section TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()); CREATE TABLE IF NOT EXISTS transformations (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, detail TEXT NOT NULL, before_image TEXT NOT NULL, after_image TEXT NOT NULL, composite TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()); CREATE TABLE IF NOT EXISTS applications (id BIGSERIAL PRIMARY KEY, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`)
  const existing = await pool.query('SELECT section FROM site_content')
  if (existing.rowCount === 0) for (const [section, value] of Object.entries(defaultContent)) await pool.query('INSERT INTO site_content(section, value) VALUES ($1, $2)', [section, value])
}

function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
function tokenSignature(payload) { return createHmac('sha256', process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_PASSWORD || '').update(payload).digest('base64url') }
function createAdminToken() { const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 24 * 60 * 60 * 1000 })).toString('base64url'); return `${payload}.${tokenSignature(payload)}` }
function authorized(req) {
  const token = req.headers.authorization?.replace(/^Bearer /, '')
  if (!token || !process.env.ADMIN_PASSWORD) return false
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return false
  const expected = tokenSignature(payload)
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now() } catch { return false }
}
async function body(req) { let raw = ''; for await (const chunk of req) raw += chunk; if (raw.length > 30_000_000) throw new Error('payload_too_large'); return raw ? JSON.parse(raw) : {} }
async function api(req, res, pathname, searchParams) {
  if (req.method === 'GET' && pathname === '/api/media') {
    const target = searchParams.get('url')
    let remoteUrl
    try { remoteUrl = new URL(target) } catch { return json(res, 400, { error: 'invalid_media_url' }) }
    if (remoteUrl.protocol !== 'https:' || !mediaHosts.has(remoteUrl.hostname.toLowerCase())) return json(res, 403, { error: 'media_host_not_allowed' })
    try {
      const upstream = await fetch(remoteUrl, { redirect: 'follow' })
      let finalUrl
      try { finalUrl = new URL(upstream.url) } catch { return json(res, 502, { error: 'media_upstream_failed' }) }
      if (finalUrl.protocol !== 'https:' || !mediaHosts.has(finalUrl.hostname.toLowerCase())) return json(res, 403, { error: 'media_redirect_not_allowed' })
      if (!upstream.ok) return json(res, 502, { error: 'media_upstream_failed' })
      const headers = { 'content-type': upstream.headers.get('content-type') || 'application/octet-stream' }
      for (const header of ['cache-control', 'expires', 'etag', 'last-modified']) {
        const value = upstream.headers.get(header)
        if (value) headers[header] = value
      }
      res.writeHead(200, headers)
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch { return json(res, 502, { error: 'media_upstream_failed' }) }
    return
  }
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const credentials = await body(req)
    const username = process.env.ADMIN_USERNAME || 'erenbasoglu'
    if (credentials.username !== username || credentials.password !== process.env.ADMIN_PASSWORD) return json(res, 401, { error: 'invalid_credentials' })
    return json(res, 200, { token: createAdminToken() })
  }
  if (pathname === '/api/health') return json(res, 200, { ok: true, database: Boolean(pool) })
  if (!pool) return json(res, 503, { error: 'database_unavailable' })
  if (req.method === 'GET' && pathname === '/api/content') { const rows = await pool.query('SELECT section, value FROM site_content'); return json(res, 200, Object.fromEntries(rows.rows.map((row) => [row.section, row.value]))) }
  if (req.method === 'GET' && pathname === '/api/transformations') { const rows = await pool.query('SELECT id, name, detail, before_image AS "beforeImage", after_image AS "afterImage", composite, created_at AS "createdAt" FROM transformations ORDER BY created_at DESC'); return json(res, 200, rows.rows) }
  if (req.method === 'POST' && pathname === '/api/applications') { const payload = await body(req); const result = await pool.query('INSERT INTO applications(payload) VALUES ($1) RETURNING id, created_at AS "createdAt"', [payload]); return json(res, 201, result.rows[0]) }
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized' })
  if (req.method === 'GET' && pathname === '/api/applications') { const rows = await pool.query('SELECT id, payload, created_at AS "createdAt" FROM applications ORDER BY created_at DESC'); return json(res, 200, rows.rows.map((row) => ({ id: row.id, ...row.payload, createdAt: row.createdAt }))) }
  if (req.method === 'DELETE' && pathname.startsWith('/api/applications/')) { const id = pathname.slice('/api/applications/'.length); await pool.query('DELETE FROM applications WHERE id = $1', [id]); res.writeHead(204); return res.end() }
  if (req.method === 'PUT' && pathname.startsWith('/api/content/')) { const section = decodeURIComponent(pathname.slice('/api/content/'.length)); const value = await body(req); await pool.query('INSERT INTO site_content(section, value) VALUES ($1, $2) ON CONFLICT (section) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()', [section, value]); return json(res, 200, { section, value }) }
  if (req.method === 'POST' && pathname === '/api/transformations') { const value = await body(req); const result = await pool.query('INSERT INTO transformations(name, detail, before_image, after_image, composite) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, detail, before_image AS "beforeImage", after_image AS "afterImage", composite, created_at AS "createdAt"', [value.name, value.detail, value.beforeImage, value.afterImage, value.composite || null]); return json(res, 201, result.rows[0]) }
  if (req.method === 'DELETE' && pathname.startsWith('/api/transformations/')) { await pool.query('DELETE FROM transformations WHERE id = $1', [pathname.split('/').pop()]); return json(res, 204, {}) }
  return json(res, 404, { error: 'not_found' })
}

function staticFile(res, pathname) { const requested = pathname === '/' ? '/index.html' : pathname; const file = normalize(join(dist, requested)); if (!file.startsWith(dist) || !existsSync(file)) return false; const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' }; res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); createReadStream(file).pipe(res); return true }

const server = createServer(async (req, res) => { try { const url = new URL(req.url, `http://${req.headers.host}`); if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname, url.searchParams); if (!staticFile(res, url.pathname)) staticFile(res, '/index.html') } catch (error) { json(res, error.message === 'payload_too_large' ? 413 : 500, { error: 'server_error' }) } })
initDatabase().then(() => server.listen(port, '0.0.0.0', () => console.log(`Eren Coaching server listening on ${port}`))).catch((error) => { console.error(error); process.exit(1) })
