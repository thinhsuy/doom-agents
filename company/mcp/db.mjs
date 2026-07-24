// db.mjs — talk to the company Postgres via `docker exec psql`, the same path
// build.py/dbio.py uses. The DB lives in the neighbour's Docker container and is
// NOT reachable on host 127.0.0.1:5432 (a native postgresql@16 shadows the port),
// so a normal pg TCP driver can't reach it — docker exec is the working route.
//
// No SQL injection: string literals are single-quote-escaped (Postgres runs with
// standard_conforming_strings on) and JSON is passed as an escaped literal cast to
// ::jsonb. Same discipline as dbio.py.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV_FILE = join(HERE, '..', '.env.local')

export function loadEnv() {
  let text
  try {
    text = readFileSync(ENV_FILE, 'utf8')
  } catch {
    throw new Error(`${ENV_FILE} not found — copy company/.env.example and fill it in.`)
  }
  const env = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    const i = t.indexOf('=')
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  for (const k of ['PGCONTAINER', 'PGUSER', 'PGDATABASE', 'PGPASSWORD']) {
    if (!env[k]) throw new Error(`${ENV_FILE} is missing ${k}`)
  }
  return env
}

function run(env, args, stdin) {
  const r = spawnSync(
    'docker',
    [
      'exec', '-i',
      '-e', `PGPASSWORD=${env.PGPASSWORD}`,
      env.PGCONTAINER,
      'psql', '-U', env.PGUSER, '-h', '127.0.0.1', '-d', env.PGDATABASE,
      '-v', 'ON_ERROR_STOP=1', ...args,
    ],
    { input: stdin, encoding: 'utf8', timeout: 30_000 },
  )
  if (r.error) throw new Error(`docker exec failed: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`psql exit ${r.status}: ${(r.stderr || '').trim()}`)
  return r.stdout
}

/** SQL string literal — safe under standard_conforming_strings. */
export function lit(s) {
  if (s === null || s === undefined) return 'NULL'
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/** JSON value as an escaped ::jsonb literal. */
export function jlit(obj) {
  return lit(JSON.stringify(obj)) + '::jsonb'
}

/** A list of strings as a Postgres text[] literal (empty list -> '{}'). */
export function arr(items) {
  if (!items || items.length === 0) return `'{}'::text[]`
  return 'ARRAY[' + items.map(lit).join(',') + ']::text[]'
}

/** Run statements (no result needed). */
export function exec(env, sql) {
  run(env, ['-q', '-f', '-'], sql)
}

// -q suppresses command tags ("INSERT 0 1") and NOTICEs so an INSERT ... RETURNING
// yields only its value; query tuples still print.
/** Run a query whose single column is JSON; return the parsed value (or null). */
export function queryJson(env, sql) {
  const out = run(env, ['-q', '-tAc', sql], undefined).trim()
  return out ? JSON.parse(out) : null
}

/** Run a query returning a single scalar text value. */
export function queryScalar(env, sql) {
  return run(env, ['-q', '-tAc', sql], undefined).trim()
}
