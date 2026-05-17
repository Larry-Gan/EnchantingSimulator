import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';

const SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/1lZRkY3kr0IFD6vKqfMqF56LlSy7rtNzf-w2JxBVAs9k/export?format=csv&gid=968793949';

const REQUIRED_COLUMNS = [
  'EnchantmentName',
  'Description',
  'Weight',
  'ItemLabels',
  'IncompatibleItemLabels',
  'EnchantmentLabels',
  'IncompatibleEnchantmentLabels'
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function splitList(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function isLikelyEnchantmentRow(row) {
  const name = String(row.EnchantmentName || '').trim();
  if (!name) {
    return false;
  }

  const hasAnyDataField = [
    row.Description,
    row.ItemLabels,
    row.IncompatibleItemLabels,
    row.EnchantmentLabels,
    row.IncompatibleEnchantmentLabels
  ].some((value) => String(value || '').trim().length > 0);

  return hasAnyDataField;
}

function assertArrayField(entry, fieldName) {
  if (!Array.isArray(entry[fieldName])) {
    throw new Error(`Malformed array field '${fieldName}' for enchant '${entry.name}'.`);
  }
  const hasBadValue = entry[fieldName].some((value) => typeof value !== 'string' || !value.trim());
  if (hasBadValue) {
    throw new Error(`Malformed array field '${fieldName}' for enchant '${entry.name}'.`);
  }
}

function assertNoDuplicateEnchantNames(enchants) {
  const seen = new Set();
  for (const enchant of enchants) {
    if (seen.has(enchant.name)) {
      throw new Error(`Duplicate enchant name in output: '${enchant.name}'.`);
    }
    seen.add(enchant.name);
  }
}

function tierFromLabels(labels) {
  for (const label of labels || []) {
    const match = /^TIER(\d+)$/i.exec(label);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

function toRoman(value) {
  const map = {
    1: 'I',
    2: 'II',
    3: 'III',
    4: 'IV',
    5: 'V'
  };
  return map[value] || String(value);
}

function canonicalizeDuplicateEnchantNames(enchants) {
  const grouped = new Map();
  for (let i = 0; i < enchants.length; i += 1) {
    const key = enchants[i].name;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(i);
  }

  let renamed = 0;
  for (const [name, indexes] of grouped.entries()) {
    if (indexes.length <= 1) {
      continue;
    }

    const used = new Set();
    for (const index of indexes) {
      const enchant = enchants[index];
      const tier = tierFromLabels(enchant.labels);
      let candidate = enchant.name;

      const roman = tier ? toRoman(tier) : null;
      if (roman && /\s(?:I|II|III|IV|V)$/.test(candidate)) {
        candidate = candidate.replace(/\s(?:I|II|III|IV|V)$/, ` ${roman}`);
      }

      if (used.has(candidate)) {
        const tierSuffix = tier ? `-T${tier}` : '';
        const itemSuffix = (enchant.itemLabels || []).join('-') || 'VARIANT';
        candidate = `${enchant.name} [${itemSuffix}${tierSuffix}]`;
      }

      let uniqueCandidate = candidate;
      let seq = 2;
      while (used.has(uniqueCandidate)) {
        uniqueCandidate = `${candidate}-${seq}`;
        seq += 1;
      }

      if (uniqueCandidate !== enchant.name) {
        enchant.name = uniqueCandidate;
        renamed += 1;
      }
      used.add(enchant.name);
    }
  }

  return renamed;
}

function validateAwakeningSource(source) {
  if (!source || typeof source !== 'object') {
    throw new Error('awakening-map.source.json must be an object.');
  }
  if (!source.awakeningMap || typeof source.awakeningMap !== 'object') {
    throw new Error("awakening-map.source.json missing object 'awakeningMap'.");
  }
  if (!source.awakenItemType || typeof source.awakenItemType !== 'object') {
    throw new Error("awakening-map.source.json missing object 'awakenItemType'.");
  }

  for (const [enchantName, itemNames] of Object.entries(source.awakeningMap)) {
    if (!Array.isArray(itemNames) || itemNames.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new Error(`Awakening map entry '${enchantName}' must be an array of item names.`);
    }
  }
  for (const [itemName, itemType] of Object.entries(source.awakenItemType)) {
    if (typeof itemType !== 'string' || !itemType.trim()) {
      throw new Error(`Awaken item type entry '${itemName}' must be a non-empty string.`);
    }
  }
}

function validateAugmentArray(name, data) {
  if (!Array.isArray(data)) {
    throw new Error(`${name} source must be a JSON array.`);
  }
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`${name} contains a non-object entry.`);
    }
    if (!entry.name || !entry.category) {
      throw new Error(`${name} entry missing required 'name' or 'category'.`);
    }
    if (typeof entry.cost !== 'number') {
      throw new Error(`${name} entry '${entry.name}' has non-numeric 'cost'.`);
    }
    if (entry.multipliers != null && typeof entry.multipliers !== 'object') {
      throw new Error(`${name} entry '${entry.name}' has invalid 'multipliers'.`);
    }
    if (entry.guaranteedMods != null && !Array.isArray(entry.guaranteedMods)) {
      throw new Error(`${name} entry '${entry.name}' has invalid 'guaranteedMods'.`);
    }
  }
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(filePath, serialized, 'utf8');
}

async function fetchSheetRows() {
  const response = await fetch(SHEET_CSV_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch sheet CSV: ${response.status} ${response.statusText}`);
  }
  const csvText = await response.text();
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: false
  });
  if (!rows.length) {
    throw new Error('Sheet CSV produced zero rows.');
  }

  const headers = Object.keys(rows[0]);
  const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  if (missing.length) {
    throw new Error(`Required sheet columns missing: ${missing.join(', ')}`);
  }

  return rows;
}

function buildEnchants(rows) {
  const enchants = rows
    .filter(isLikelyEnchantmentRow)
    .map((row) => {
      const name = String(row.EnchantmentName || '').trim();
      const description = String(row.Description || '').trim();
      const weight = Number(String(row.Weight || '').trim());
      if (!Number.isFinite(weight) || weight < 0) {
        throw new Error(`Invalid weight for enchant '${name}': '${row.Weight}'`);
      }

      const labels = splitList(row.EnchantmentLabels);
      const rollable = labels.includes('ROLLABLE');
      const requiresEngraving = labels.includes('REQUIRESENGRAVING') || labels.includes('ENGRAVINGONLY');

      return {
        name,
        description,
        weight,
        itemLabels: splitList(row.ItemLabels),
        incompatItemLabels: splitList(row.IncompatibleItemLabels),
        labels,
        incompatLabels: splitList(row.IncompatibleEnchantmentLabels),
        rollable,
        requiresEngraving
      };
    });

  if (!enchants.length) {
    throw new Error('Generated enchants.json is empty.');
  }

  const renamedDuplicateCount = canonicalizeDuplicateEnchantNames(enchants);

  assertNoDuplicateEnchantNames(enchants);

  for (const enchant of enchants) {
    assertArrayField(enchant, 'itemLabels');
    assertArrayField(enchant, 'incompatItemLabels');
    assertArrayField(enchant, 'labels');
    assertArrayField(enchant, 'incompatLabels');
  }

  return {
    enchants,
    renamedDuplicateCount
  };
}

async function main() {
  const rows = await fetchSheetRows();
  const { enchants, renamedDuplicateCount } = buildEnchants(rows);

  const artifactsSourcePath = path.join(ROOT, 'data', 'artifacts.source.json');
  const engravingsSourcePath = path.join(ROOT, 'data', 'engravings.source.json');
  const awakeningSourcePath = path.join(ROOT, 'data', 'awakening-map.source.json');

  const artifacts = await readJson(artifactsSourcePath);
  const engravings = await readJson(engravingsSourcePath);
  const awakening = await readJson(awakeningSourcePath);

  validateAugmentArray('artifacts', artifacts);
  validateAugmentArray('engravings', engravings);
  validateAwakeningSource(awakening);

  await writeJson(path.join(ROOT, 'enchants.json'), enchants);
  await writeJson(path.join(ROOT, 'artifacts.json'), artifacts);
  await writeJson(path.join(ROOT, 'engravings.json'), engravings);
  await writeJson(path.join(ROOT, 'awakening-map.json'), awakening);

  console.log('Data sync complete.');
  console.log(`- Sheet rows read: ${rows.length}`);
  console.log(`- Enchants generated: ${enchants.length}`);
  console.log(`- Duplicate names normalized: ${renamedDuplicateCount}`);
  console.log(`- Artifacts generated: ${artifacts.length}`);
  console.log(`- Engravings generated: ${engravings.length}`);
  console.log(`- Awakening entries: ${Object.keys(awakening.awakeningMap).length}`);
}

main().catch((error) => {
  console.error(`Sync failed: ${error.message}`);
  process.exitCode = 1;
});
