/**
 * Vector Memory — Semantic search for Vance
 *
 * PostgreSQL + pgvector for indexed vector similarity search.
 * Uses OpenAI text-embedding-3-small for embeddings ($0.02/1M tokens).
 * HNSW index for fast cosine similarity queries.
 */

const { Pool } = require('pg');

const EMBEDDING_MODEL = 'text-embedding-3-small';

let pool = null;
let openaiKey = null;
let ready = false;

// ─── Init ────────────────────────────────────────────────────────

async function init(apiKey) {
  openaiKey = apiKey;

  pool = new Pool({
    database: 'vance',
    host: '/tmp', // Unix socket (default for Homebrew PostgreSQL)
  });

  try {
    const res = await pool.query('SELECT count(*) FROM vectors');
    ready = true;
    console.log(`  Vector Memory: ${res.rows[0].count} entries (pgvector)`);
  } catch (e) {
    console.error('  Vector Memory: DB connection failed —', e.message);
    ready = false;
  }
}

// ─── Embedding API ───────────────────────────────────────────────

async function getEmbedding(text) {
  if (!openaiKey) throw new Error('No OpenAI API key for embeddings');

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding API error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

// ─── Store ───────────────────────────────────────────────────────

/**
 * Store a document with its embedding
 * @param {string} content - Text content to store
 * @param {object} metadata - { type, source, projectId, tags }
 */
async function store(content, metadata = {}) {
  if (!ready) return { id: null, stored: false, error: 'Vector DB not ready' };

  try {
    const embedding = await getEmbedding(content);
    const id = `vec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const vecStr = `[${embedding.join(',')}]`;

    await pool.query(
      `INSERT INTO vectors (id, content, embedding, type, source, project_id, tags)
       VALUES ($1, $2, $3::vector, $4, $5, $6, $7)`,
      [
        id,
        content.slice(0, 4000),
        vecStr,
        metadata.type || 'memory',
        metadata.source || null,
        metadata.projectId || null,
        metadata.tags || [],
      ]
    );

    return { id, stored: true };
  } catch (e) {
    console.error('Vector store error:', e.message);
    return { id: null, stored: false, error: e.message };
  }
}

/**
 * Store multiple documents in batch
 */
async function storeBatch(items) {
  const results = [];
  for (const item of items) {
    const result = await store(item.content, item.metadata);
    results.push(result);
  }
  return results;
}

// ─── Search ──────────────────────────────────────────────────────

/**
 * Semantic search across stored vectors using pgvector cosine distance
 * @param {string} query - Natural language query
 * @param {object} options - { limit, type, projectId, minScore }
 * @returns {Array} Ranked results with similarity scores
 */
async function search(query, options = {}) {
  if (!ready) return [];
  const { limit = 5, type = null, projectId = null, minScore = 0.3 } = options;

  try {
    const queryEmbedding = await getEmbedding(query);
    const vecStr = `[${queryEmbedding.join(',')}]`;

    // Build query with optional filters
    let sql = `SELECT id, content, type, source, project_id, tags, created_at,
               1 - (embedding <=> $1::vector) AS score
               FROM vectors WHERE 1=1`;
    const params = [vecStr];
    let paramIdx = 2;

    if (type) {
      sql += ` AND type = $${paramIdx}`;
      params.push(type);
      paramIdx++;
    }
    if (projectId) {
      sql += ` AND project_id = $${paramIdx}`;
      params.push(projectId);
      paramIdx++;
    }

    sql += ` AND 1 - (embedding <=> $1::vector) >= $${paramIdx}`;
    params.push(minScore);
    paramIdx++;

    sql += ` ORDER BY embedding <=> $1::vector LIMIT $${paramIdx}`;
    params.push(limit);

    const res = await pool.query(sql, params);

    return res.rows.map(r => ({
      id: r.id,
      content: r.content,
      metadata: {
        type: r.type,
        source: r.source,
        projectId: r.project_id,
        tags: r.tags || [],
        createdAt: r.created_at,
      },
      score: parseFloat(r.score),
    }));
  } catch (e) {
    console.error('Vector search error:', e.message);
    return [];
  }
}

// ─── Management ──────────────────────────────────────────────────

/**
 * Delete a vector entry by ID
 */
async function remove(id) {
  if (!ready) return false;
  try {
    const res = await pool.query('DELETE FROM vectors WHERE id = $1', [id]);
    return res.rowCount > 0;
  } catch (e) {
    console.error('Vector remove error:', e.message);
    return false;
  }
}

/**
 * Delete all vectors matching a filter
 */
async function removeByFilter(filter = {}) {
  if (!ready) return 0;
  try {
    let sql = 'DELETE FROM vectors WHERE 1=1';
    const params = [];
    let idx = 1;

    if (filter.type) {
      sql += ` AND type = $${idx}`;
      params.push(filter.type);
      idx++;
    }
    if (filter.projectId) {
      sql += ` AND project_id = $${idx}`;
      params.push(filter.projectId);
      idx++;
    }
    if (filter.olderThan) {
      sql += ` AND created_at < $${idx}`;
      params.push(new Date(filter.olderThan));
      idx++;
    }

    const res = await pool.query(sql, params);
    return res.rowCount;
  } catch (e) {
    console.error('Vector removeByFilter error:', e.message);
    return 0;
  }
}

/**
 * Get stats about the vector store
 */
function getStats() {
  if (!ready) return { totalEntries: 0, byType: {}, backend: 'pgvector (not connected)' };

  // Use cached stats to avoid blocking — refresh async
  return { ...cachedStats, backend: 'pgvector' };
}

let cachedStats = { totalEntries: 0, byType: {} };

async function refreshStats() {
  if (!ready) return;
  try {
    const countRes = await pool.query('SELECT count(*) FROM vectors');
    const typeRes = await pool.query('SELECT type, count(*) as cnt FROM vectors GROUP BY type');
    const byType = {};
    for (const r of typeRes.rows) byType[r.type] = parseInt(r.cnt);
    cachedStats = { totalEntries: parseInt(countRes.rows[0].count), byType };
  } catch {}
}

// Refresh stats every 30s
setInterval(() => { if (ready) refreshStats().catch(() => {}); }, 30000);

/**
 * Re-index a content source
 */
async function reindex(source, items) {
  if (!ready) return [];
  await pool.query('DELETE FROM vectors WHERE source = $1', [source]);
  return storeBatch(items.map(item => ({
    content: item.content,
    metadata: { ...item.metadata, source },
  })));
}

module.exports = {
  init,
  store,
  storeBatch,
  search,
  remove,
  removeByFilter,
  getStats,
  reindex,
  getEmbedding,
};
