/**
 * DramaMind — Vercel Serverless API: KV Storage
 * 
 * 所有对 Upstash Redis 的读写都通过这个端点中转，
 * 确保 UPSTASH_REDIS_REST_URL / TOKEN 不暴露在前端代码里。
 *
 * 支持的操作（通过 ?op= 查询参数区分）：
 *   GET  ?op=get&key=xxx          → 读取单个 key
 *   GET  ?op=list&prefix=xxx      → 列出指定前缀的所有 keys
 *   POST ?op=set  { key, value }  → 写入
 *   POST ?op=del  { key }         → 删除单个 key
 *   POST ?op=delPrefix { prefix } → 删除某前缀下所有 key（批量）
 */

const BASE_URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN    = process.env.UPSTASH_REDIS_REST_TOKEN;

// ── Upstash REST helpers ──────────────────────────────────────────────────────

async function redisGet(key) {
  const res = await fetch(`${BASE_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const json = await res.json();
  return json.result; // string | null
}

async function redisSet(key, value) {
  // value must be a string; we JSON-stringify objects before calling
  const res = await fetch(`${BASE_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([value]),
  });
  const json = await res.json();
  return json.result === 'OK';
}

async function redisDel(key) {
  const res = await fetch(`${BASE_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const json = await res.json();
  return json.result >= 0;
}

async function redisScan(cursor, match, count = 100) {
  // SCAN cursor MATCH pattern COUNT count
  const res = await fetch(`${BASE_URL}/scan/${cursor}?match=${encodeURIComponent(match)}&count=${count}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const json = await res.json();
  // result: [nextCursor, [keys...]]
  return json.result;
}

async function listAllKeys(prefix) {
  const keys = [];
  let cursor = 0;
  do {
    const [nextCursor, batch] = await redisScan(cursor, `${prefix}*`, 200);
    keys.push(...batch);
    cursor = parseInt(nextCursor);
  } while (cursor !== 0);
  return keys;
}

// ── CORS helper ───────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req) {
  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (!BASE_URL || !TOKEN) {
    return jsonResp({ error: 'Upstash env vars not configured' }, 500);
  }

  const url = new URL(req.url, `https://${req.headers.get('host')}`);
  const op  = url.searchParams.get('op');

  try {
    // ── READ ops (GET) ───────────────────────────────────────────────────────

    if (req.method === 'GET') {
      if (op === 'get') {
        const key = url.searchParams.get('key');
        if (!key) return jsonResp({ error: 'key required' }, 400);
        const val = await redisGet(key);
        return jsonResp({ value: val });
      }

      if (op === 'list') {
        const prefix = url.searchParams.get('prefix') || 'dm:';
        const keys = await listAllKeys(prefix);
        return jsonResp({ keys });
      }

      return jsonResp({ error: 'unknown op' }, 400);
    }

    // ── WRITE ops (POST) ─────────────────────────────────────────────────────

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));

      if (op === 'set') {
        const { key, value } = body;
        if (!key || value === undefined) return jsonResp({ error: 'key and value required' }, 400);
        // Reject oversized payloads (> 4.5MB serialized)
        const str = typeof value === 'string' ? value : JSON.stringify(value);
        if (str.length > 4.5 * 1024 * 1024) {
          return jsonResp({ error: 'payload too large (>4.5MB)' }, 413);
        }
        const ok = await redisSet(key, str);
        return jsonResp({ ok });
      }

      if (op === 'del') {
        const { key } = body;
        if (!key) return jsonResp({ error: 'key required' }, 400);
        const ok = await redisDel(key);
        return jsonResp({ ok });
      }

      if (op === 'delPrefix') {
        const { prefix } = body;
        if (!prefix) return jsonResp({ error: 'prefix required' }, 400);
        const keys = await listAllKeys(prefix);
        await Promise.all(keys.map(k => redisDel(k)));
        return jsonResp({ ok: true, deleted: keys.length });
      }

      return jsonResp({ error: 'unknown op' }, 400);
    }

    return jsonResp({ error: 'method not allowed' }, 405);

  } catch (err) {
    console.error('[kv api]', err);
    return jsonResp({ error: err.message || 'internal error' }, 500);
  }
}

export const config = { runtime: 'edge' };
