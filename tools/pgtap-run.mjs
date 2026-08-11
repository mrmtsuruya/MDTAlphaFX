// PGlite + pgTAP harness for the Supabase database tests.
//
// Runs every migration in supabase/migrations/ in order against a self-contained
// Postgres 16 (PGlite, WASM — no Docker or Postgres server needed), loads pgTAP
// from tools/pgtap/pgtap.sql.in, then executes each pgTAP file in
// supabase/tests/database/ and prints its TAP output.
//
//   node tools/pgtap-run.mjs            # all database tests
//   node tools/pgtap-run.mjs 002        # only files matching "002"
//
// Supabase-only pieces that real Postgres lacks are stubbed in the scaffold
// (roles, an auth.users table with auth.uid()/auth.jwt() reading
// request.jwt.claims, and cron/net/vault objects for the scheduler migration).
// The three CREATE EXTENSION statements PGlite cannot load (pg_cron, pg_net,
// supabase_vault) are stripped before applying; the PL/pgSQL bodies that
// reference them still resolve against the stubs, so the migration itself is
// validated. pgTAP is pure PL/pgSQL: its install script is loaded with the
// build-time placeholders substituted (upstream's Makefile replaces __VERSION__
// with NUMVERSION, e.g. "1.3", because the value sits inside a SQL-language
// function body and must be a valid numeric literal).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const REPO_ROOT = join(import.meta.dirname, "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase/migrations");
const TESTS_DIR = join(REPO_ROOT, "supabase/tests/database");
const PGTAP_SQL = join(import.meta.dirname, "pgtap", "pgtap.sql.in");

const FILTER = process.argv[2];

const SCAFFOLD = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text,
  raw_user_meta_data jsonb
);
-- Supabase-style auth.uid(): reads the request.jwt.claims 'sub' set via
-- SET LOCAL request.jwt.claims, so pgTAP tests can impersonate users.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true), '')::jsonb
$$;

-- Stubs for the C extensions PGlite cannot load (pg_cron / pg_net /
-- supabase_vault). The 20260811030000 migration references cron.schedule,
-- net.http_post and vault.decrypted_secrets inside PL/pgSQL bodies, which
-- must resolve at CREATE FUNCTION time; the harness strips the CREATE
-- EXTENSION statements themselves (see prepForPGlite).
CREATE SCHEMA cron;
CREATE FUNCTION cron.schedule(p_job_name text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
CREATE SCHEMA net;
CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb)
RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
CREATE SCHEMA vault;
CREATE TABLE vault.decrypted_secrets (
  name text PRIMARY KEY,
  decrypted_secret text,
  updated_at timestamptz DEFAULT now()
);
`;

// PGlite bundles no pg_cron / pg_net / supabase_vault shared libraries, so
// their CREATE EXTENSION statements cannot run; the schemas and functions the
// migration bodies reference are provided by the scaffold stubs above.
function prepForPGlite(sql) {
  return sql.replace(
    /^CREATE EXTENSION IF NOT EXISTS (pg_cron|pg_net|supabase_vault)\b[^;]*;/gim,
    "-- CREATE EXTENSION (stubbed for PGlite)",
  );
}

// pgTAP is pure PL/pgSQL; load its install script with the build-time
// placeholders substituted. Upstream's Makefile substitutes __VERSION__ with
// NUMVERSION (e.g. "1.3"): the value sits inside a SQL-language function
// body, so it must be a valid numeric literal ("1.3.3" would not parse).
function pgtapSql() {
  const raw = readFileSync(PGTAP_SQL, "utf8");
  return raw.replaceAll("__OS__", "unknown").replaceAll("__VERSION__", "1.3");
}

function tapLine(value) {
  // pgTAP assertions return setof text (TAP lines like 'ok 1 - desc').
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const first = Object.values(value)[0];
    return typeof first === "string" ? first : JSON.stringify(value);
  }
  return String(value);
}

async function main() {
  const db = new PGlite();

  console.log("== scaffold ==");
  await db.exec(SCAFFOLD);
  await db.exec(pgtapSql());
  console.log("roles + auth stub + pgTAP (1.3) ready\n");

  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  console.log(`== applying ${migrationFiles.length} migrations ==`);
  let migrationsOk = true;
  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    try {
      await db.exec(prepForPGlite(sql));
      console.log(`ok - ${file}`);
    } catch (error) {
      migrationsOk = false;
      console.log(`FAIL - ${file}: ${error.message}`);
      if (error.position) {
        const p = Number(error.position);
        console.log(`       ...${JSON.stringify(sql.slice(p - 100, p + 60))}`);
      }
      try {
        await db.exec("ROLLBACK;");
      } catch {}
    }
  }

  const testFiles = readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.sql"))
    .filter((f) => !FILTER || f.includes(FILTER))
    .sort();
  console.log(`\n== running ${testFiles.length} pgTAP files ==`);
  let allOk = migrationsOk;
  for (const file of testFiles) {
    const sql = readFileSync(join(TESTS_DIR, file), "utf8");
    console.log(`\n--- ${file} ---`);
    try {
      const results = await db.exec(sql);
      for (const result of results) {
        for (const row of result.rows) {
          const line = tapLine(row);
          if (line != null) {
            console.log(line);
            if (line.startsWith("not ok")) allOk = false;
          }
        }
      }
    } catch (error) {
      allOk = false;
      console.log(`ERROR in ${file}: ${error.message}`);
      // The failed test file left the transaction aborted; clear it so the
      // next file starts from a clean state.
      try {
        await db.exec("ROLLBACK;");
      } catch {}
    }
  }

  await db.close();
  console.log(`\n${allOk ? "ALL_PASS" : "SOME_FAILED"}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
