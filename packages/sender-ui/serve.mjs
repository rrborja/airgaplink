import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, resolve, sep } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist')
const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 5173)
const apiTarget = new URL(process.env.SENDER_API_TARGET || 'http://127.0.0.1:3001')
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
}

if (!existsSync(join(root, 'index.html'))) {
  console.error('Sender build missing. Run pnpm --filter sender-ui build first.')
  process.exit(1)
}

createServer((request, response) => {
  let pathname, search
  try { const url = new URL(request.url || '/', 'http://localhost'); pathname = decodeURIComponent(url.pathname); search = url.search }
  catch { response.writeHead(400, { Connection: 'close' }).end(); return }

  // Only the explicitly selected QR compatibility mode uses this control API.
  // High-Speed Optical never sends file bytes or control packets to it.
  if (pathname.startsWith('/api/')) {
    const target = new URL(pathname + search, apiTarget)
    const forward = target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = forward(target, { method: request.method, headers: { ...request.headers, host: target.host } }, incoming => {
      response.writeHead(incoming.statusCode || 502, { ...incoming.headers, connection: 'close' })
      incoming.pipe(response)
    })
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502, { Connection: 'close' }); response.end() })
    request.pipe(upstream)
    return
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Connection: 'close' }).end(); return }
  const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
  if (!path.startsWith(root + sep)) { response.writeHead(403, { Connection: 'close' }).end(); return }
  let size
  try { const stat = statSync(path); if (!stat.isFile()) throw new Error('Not a file'); size = stat.size }
  catch { response.writeHead(404, { Connection: 'close' }).end(); return }
  response.writeHead(200, {
    'Content-Type': mime[extname(path)] || 'application/octet-stream',
    'Content-Length': size,
    // The HTML points at hashed bundles and must be re-fetched on reload so
    // Safari does not keep running an older transfer implementation.
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
    Connection: 'close',
  })
  if (request.method === 'HEAD') { response.end(); return }
  createReadStream(path).pipe(response)
}).listen(port, host, () => console.log(`Static sender UI ready at http://${host}:${port}`))
