/**
 * DramaMind — Vercel Serverless API: KV Storage
 *
 * 修复说明（v2）：
 * - 将 process.env 读取从模块顶层移入 handler 函数体内
 *   （Edge Runtime 不支持顶层 process.env，会导致 FUNCTION_INVOCATION_FAILED）
 * - 其余逻辑不变
 *
 * 支持的操作（通过 ?op= 查询参数区分）：
 *   GET  ?op=get&key=xxx          → 读取单个 key
 *   GET  ?op=list&prefix=xxx      → 列出指定前缀的所有 keys
 *   POST ?op=set  { key, value }  → 写入
 *   POST ?op=del  { key }         → 删除单个 key
 *   POST ?op=delPrefix { prefix } → 删除某前缀下所有 key（批量）
 */

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

// ── Upstash REST helpers（接收 baseUrl / token 参数，避免顶层 process.env）──

async function redisGet(baseUrl, token, key) {
  const res = await fetch(`${baseUrl}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  return json.result; // string | null
}

async function redisSet(baseUrl, token, key, value) {
  const res = await fetch(`${baseUrl}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([value]),
  });
  const json = await res.json();
  return json.result === 'OK';
}

async function redisDel(baseUrl, token, key) {
  const res = await fetch(`${baseUrl}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  return json.result >= 0;
}

async function redisScan(baseUrl, token, cursor, match, count = 100) {
  const res = await fetch(
    `${baseUrl}/scan/${cursor}?match=${encodeURIComponent(match)}&count=${count}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const json = await res.json();
  return json.result; // [nextCursor, [keys...]]
}

async function listAllKeys(baseUrl, token, prefix) {
  const keys = [];
  let cursor = 0;
  do {
    const [nextCursor, batch] = await redisScan(baseUrl, token, cursor, `${prefix}*`, 200);
    keys.push(...batch);
    cursor = parseInt(nextCursor);
  } while (cursor !== 0);
  return keys;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req) {
  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // ✅ 关键修复：env 读取在函数体内，而非模块顶层
  //    Edge Runtime 模块顶层调用 process.env 会导致 FUNCTION_INVOCATION_FAILED
  const BASE_URL = process.env.KV_REST_API_URL;
  const TOKEN    = process.env.KV_REST_API_TOKEN;

  if (!BASE_URL || !TOKEN) {
    return jsonResp({ error: 'KV_REST_API_URL / KV_REST_API_TOKEN 未在 Vercel 配置' }, 500);
  }

  const url = new URL(req.url, `https://${req.headers.get('host')}`);
  const op  = url.searchParams.get('op');

  try {
    // ── READ ops (GET) ───────────────────────────────────────────────────────

    if (req.method === 'GET') {
      if (op === 'get') {
        const key = url.searchParams.get('key');
        if (!key) return jsonResp({ error: 'key required' }, 400);
        const val = await redisGet(BASE_URL, TOKEN, key);
        return jsonResp({ value: val });
      }

      if (op === 'list') {
        const prefix = url.searchParams.get('prefix') || 'dm:';
        const keys = await listAllKeys(BASE_URL, TOKEN, prefix);
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
        const str = typeof value === 'string' ? value : JSON.stringify(value);
        if (str.length > 4.5 * 1024 * 1024) {
          return jsonResp({ error: 'payload too large (>4.5MB)' }, 413);
        }
        const ok = await redisSet(BASE_URL, TOKEN, key, str);
        return jsonResp({ ok });
      }

      if (op === 'del') {
        const { key } = body;
        if (!key) return jsonResp({ error: 'key required' }, 400);
        const ok = await redisDel(BASE_URL, TOKEN, key);
        return jsonResp({ ok });
      }

      if (op === 'delPrefix') {
        const { prefix } = body;
        if (!prefix) return jsonResp({ error: 'prefix required' }, 400);
        const keys = await listAllKeys(BASE_URL, TOKEN, prefix);
        await Promise.all(keys.map(k => redisDel(BASE_URL, TOKEN, k)));
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
