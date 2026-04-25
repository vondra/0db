#!/usr/bin/env node
/**
 * Generate `engine/noise-compute/src/city_consts_generated.rs` from
 * `scripts/h3-admin-metros.json`. The metro ids are the source of truth; the
 * Rust file is a derived artefact that callers (e.g. `defaults.rs`) import
 * via `use crate::city_consts_generated::*;`.
 *
 * Run after editing the JSON:
 *   node scripts/gen-city-consts-rs.mjs
 *
 * Generated file is committed alongside the JSON so engine builds stay
 * reproducible.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const JSON_PATH = resolve(ROOT, 'scripts/h3-admin-metros.json')
const OUT_PATH = resolve(ROOT, 'engine/noise-compute/src/city_consts_generated.rs')

/** PascalCase / CamelCase → UPPER_SNAKE_CASE.
 *  Example: "SaoPaulo" → "SAO_PAULO", "MexicoCity" → "MEXICO_CITY". */
function toSnake(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase()
}

function main() {
  const data = JSON.parse(readFileSync(JSON_PATH, 'utf-8'))
  const metros = data.metros
  if (!Array.isArray(metros)) {
    console.error(`ERROR: ${JSON_PATH} is missing a 'metros' array`)
    process.exit(1)
  }

  // Detect duplicate ids — would silently corrupt the cascade.
  const idsSeen = new Map()
  for (const m of metros) {
    if (idsSeen.has(m.id)) {
      console.error(`ERROR: duplicate metro id ${m.id} (${m.name} vs ${idsSeen.get(m.id)})`)
      process.exit(1)
    }
    idsSeen.set(m.id, m.name)
  }

  const lines = [
    '//! City id constants — DO NOT EDIT.',
    '//!',
    '//! Generated from `scripts/h3-admin-metros.json` by',
    '//! `scripts/gen-city-consts-rs.mjs`. Re-run after editing the JSON.',
    '',
  ]
  for (const m of metros.sort((a, b) => a.id - b.id)) {
    lines.push(`pub const CITY_${toSnake(m.name)}: u16 = ${m.id};`)
  }
  lines.push('')

  writeFileSync(OUT_PATH, lines.join('\n'))
  console.log(`Wrote ${OUT_PATH} — ${metros.length} city constants`)
}

main()
