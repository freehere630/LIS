// ============================================================
// APEX LIS BRIDGE — Arrows KT-44 (Hematology / CBC)
// v5 — maps 3-part → 5-part, fixes missing differential
// ============================================================

import net from 'net';
import os from 'os';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const ACK = 0x06, ENQ = 0x05;

const C = {
  reset: '\x1b[0m', bright: '\x1b[1m', blue: '\x1b[34m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', gray: '\x1b[90m', white: '\x1b[37m',
};

// ============================================================
// CODE → LIMS NAME (includes LOINC + KT-44 proprietary codes)
// ============================================================
const CODE_TO_LIMS_NAME = {
  // --- Full CBC panel (LOINC) ---
  '6690-2':  'Total Leucocyte Count (WBC)',
  '789-8':   'Total Red Blood Cell Count (RBC)',
  '718-7':   'Hemoglobin (Hb)',
  '4544-3':  'Packed Cell Volume (PCV / Hematocrit)',
  '787-2':   'Mean Corpuscular Volume (MCV)',
  '785-6':   'Mean Corpuscular Hemoglobin (MCH)',
  '786-4':   'Mean Corpuscular Hb Concentration (MCHC)',
  '788-0':   'RDW-CV',
  '21000-5': 'RDW-SD',
  '777-3':   'Total Platelet Count',
  '32623-1': 'Mean Platelet Volume (MPV)',
  '32207-5': 'Platelet Distribution Width (PDW)',
  // --- 5-part differential (from analyzer where available) ---
  '736-9':   'Lymphocytes',
  '731-0':   'Absolute Lymphocyte Count (ALC)',
  // --- KT-44 proprietary codes (3-part) ---
  '10030':   'Neutrophils',                     // Gran%  → Neutrophils %
  '10028':   'Absolute Neutrophil Count (ANC)', // Gran#  → ANC
  '10029':   '_MID_PCT_',                       // Mid%   → intermediate, handled in derivation
  '10027':   '_MID_ABS_',                       // Mid#   → intermediate
  '10002':   'Plateletcrit (PCT)',
  // --- Short codes as fallback ---
  'WBC': 'Total Leucocyte Count (WBC)',
  'RBC': 'Total Red Blood Cell Count (RBC)',
  'HGB': 'Hemoglobin (Hb)', 'HB': 'Hemoglobin (Hb)',
  'HCT': 'Packed Cell Volume (PCV / Hematocrit)',
  'PCV': 'Packed Cell Volume (PCV / Hematocrit)',
  'MCV': 'Mean Corpuscular Volume (MCV)',
  'MCH': 'Mean Corpuscular Hemoglobin (MCH)',
  'MCHC': 'Mean Corpuscular Hb Concentration (MCHC)',
  'PLT': 'Total Platelet Count',
  'MPV': 'Mean Platelet Volume (MPV)',
  'PDW': 'Platelet Distribution Width (PDW)',
  'GRAN%': 'Neutrophils',
  'LYMPH%': 'Lymphocytes',
};

// These codes must be staged even though they have no direct LIMS parameter
const INTERMEDIATE_CODES = new Set(['10029', '10027', '_MID_PCT_', '_MID_ABS_']);

// Derived keys written by the bridge
const DERIVED_KEYS = {
  'Neutrophils': 'Neutrophils',
  'Lymphocytes': 'Lymphocytes',
  'Monocytes':   'Monocytes',
  'Eosinophils': 'Eosinophils',
  'Basophils':   'Basophils',
  'ANC': 'Absolute Neutrophil Count (ANC)',
  'ALC': 'Absolute Lymphocyte Count (ALC)',
  'AMC': 'Absolute Monocyte Count (AMC)',
  'AEC': 'Absolute Eosinophil Count (AEC)',
  'ABC': 'Absolute Basophil Count (ABC)',
  'PCT': 'Plateletcrit (PCT)',
};

// ============================================================
// TELEMETRY
// ============================================================
const stats = {
  startedAt: new Date().toLocaleTimeString(),
  supabase: 'CONNECTING...',
  clients: 0, queries: 0, results: 0,
  activeSample: '—',
};
const recentLogs = [];
const LOG_LIMIT = 40;

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function addLog(tag, message, color = C.cyan) {
  const time = new Date().toLocaleTimeString();
  recentLogs.unshift(C.gray + '[' + time + ']' + C.reset + ' ' + color + tag.padEnd(11) + C.reset + ' ' + message);
  if (recentLogs.length > LOG_LIMIT) recentLogs.pop();
  renderDashboard();
}

function renderDashboard() {
  console.clear();
  const linkStatus = stats.clients > 0 ? C.green + '● CONNECTED' + C.reset : C.yellow + '○ LISTENING' + C.reset;
  console.log(`
${C.cyan}${C.bright}═══ APEX LIS BRIDGE — ARROWS KT-44 ═══${C.reset}
  Local IP:      ${C.yellow}${getLocalIp()}${C.reset}   Port: ${C.yellow}${process.env.ARROWS_PORT || 5200}${C.reset}
  Link:          ${linkStatus}
  Cloud:         ${stats.supabase.includes('OK') ? C.green + '● LIVE' + C.reset : C.red + '● ' + stats.supabase + C.reset}

  Host Queries:  ${C.cyan}${stats.queries}${C.reset}   CBC Params: ${C.green}${stats.results}${C.reset}   Active: ${C.white}${stats.activeSample}${C.reset}

${C.cyan}── LIVE STREAM ──${C.reset}
${recentLogs.length > 0 ? recentLogs.join('\n') : '  ' + C.gray + 'Waiting for analyzer...' + C.reset}
`);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  try {
    const { error } = await supabase.from('orders').select('id').limit(1);
    stats.supabase = error ? `ERROR (${error.code})` : 'OK (Connected)';
  } catch (e) { stats.supabase = 'DISCONNECTED'; }
  renderDashboard();
})();

// ============================================================
// UNIT CONVERSION
// ============================================================
function normalizeValueForLims(limsName, rawValue) {
  const n = parseFloat(String(rawValue).replace(/,/g, ''));
  if (isNaN(n)) return String(rawValue).trim();
  const name = String(limsName || '').toUpperCase();

  if (name.includes('TOTAL LEUCOCYTE') || name.includes('WBC')) {
    if (n > 0 && n < 100) return String(Math.round(n * 1000));
    return String(Math.round(n));
  }
  if (name.includes('TOTAL PLATELET') || name.includes('PLATELET COUNT')) {
    if (n > 0 && n < 1000) return String(Math.round(n * 1000));
    return String(Math.round(n));
  }
  if (name.includes('PACKED CELL') || name.includes('PCV') || name.includes('HEMATOCRIT') || name.includes('HAEMATOCRIT')) {
    if (n > 0 && n < 1) return (n * 100).toFixed(1);
    return n.toFixed(1);
  }
  return String(rawValue).trim();
}

// ============================================================
// SUPABASE HELPERS
// ============================================================
const paramIdCache = new Map();
const paramNameByIdCache = new Map();
const orderIdCache = new Map();

async function getOrderIdByBarcode(barcode) {
  if (!barcode) return null;
  if (orderIdCache.has(barcode)) return orderIdCache.get(barcode);
  const { data } = await supabase.from('orders').select('id').eq('barcode', barcode).maybeSingle();
  if (data) { orderIdCache.set(barcode, data.id); return data.id; }
  return null;
}

async function loadParamMapForOrder(orderId) {
  if (paramIdCache.has(orderId)) return paramIdCache.get(orderId);
  const { data: orderTests } = await supabase
    .from('order_tests').select('test:tests(test_parameters(*))').eq('order_id', orderId);
  const map = {}, byId = {};
  if (orderTests) {
    for (const ot of orderTests) {
      const params = ot.test?.test_parameters || [];
      for (const p of params) {
        if (p.name) { map[p.name.trim().toUpperCase()] = p.id; byId[p.id] = p.name; }
      }
    }
  }
  paramIdCache.set(orderId, map);
  paramNameByIdCache.set(orderId, byId);
  return map;
}

async function resolveLimsParamId(orderId, code, name) {
  const codeUp = String(code || '').toUpperCase().trim();
  const nameUp = String(name || '').toUpperCase().trim();

  // Intermediates have no LIMS target — return sentinel
  if (INTERMEDIATE_CODES.has(codeUp) || INTERMEDIATE_CODES.has(code)) return '__INTERMEDIATE__';

  const paramMap = await loadParamMapForOrder(orderId);
  const direct = CODE_TO_LIMS_NAME[codeUp];
  if (direct && paramMap[direct.toUpperCase()]) return paramMap[direct.toUpperCase()];

  // Name-based fallback
  if (nameUp.includes('LYMPH') && paramMap['LYMPHOCYTES']) return paramMap['LYMPHOCYTES'];
  if (nameUp.includes('GRAN')  && paramMap['NEUTROPHILS'])  return paramMap['NEUTROPHILS'];
  if (nameUp.includes('WBC')   && paramMap['TOTAL LEUCOCYTE COUNT (WBC)']) return paramMap['TOTAL LEUCOCYTE COUNT (WBC)'];
  if (nameUp.includes('RBC')   && paramMap['TOTAL RED BLOOD CELL COUNT (RBC)']) return paramMap['TOTAL RED BLOOD CELL COUNT (RBC)'];
  if (nameUp.includes('HGB')   && paramMap['HEMOGLOBIN (HB)']) return paramMap['HEMOGLOBIN (HB)'];
  if (nameUp.includes('HCT')   && paramMap['PACKED CELL VOLUME (PCV / HEMATOCRIT)']) return paramMap['PACKED CELL VOLUME (PCV / HEMATOCRIT)'];
  if (nameUp.includes('PLT')   && paramMap['TOTAL PLATELET COUNT']) return paramMap['TOTAL PLATELET COUNT'];
  if (nameUp.includes('PCT')   && paramMap['PLATELETCRIT (PCT)'])  return paramMap['PLATELETCRIT (PCT)'];
  if (nameUp.includes('PDW')   && paramMap['PLATELET DISTRIBUTION WIDTH (PDW)']) return paramMap['PLATELET DISTRIBUTION WIDTH (PDW)'];

  return null;
}

async function saveParamToSupabase(orderId, code, name, value) {
  const paramId = await resolveLimsParamId(orderId, code, name);
  if (paramId === '__INTERMEDIATE__') return false;   // don't write intermediates
  if (!paramId) { addLog('[UNMAPPED]', `'${code}' (${name})`, C.yellow); return false; }

  const byId = paramNameByIdCache.get(orderId) || {};
  const limsName = byId[paramId] || name || code;
  const normalizedValue = normalizeValueForLims(limsName, value);

  const { error } = await supabase.from('results').upsert(
    { order_id: orderId, parameter_id: paramId, result_value: normalizedValue, status_flag: 'AUTOMATED', analyzer_source: 'ARROWS_KT44' },
    { onConflict: 'order_id,parameter_id' }
  );
  if (error) { addLog('[DB-ERR]', `${code}: ${error.message}`, C.red); return false; }
  return true;
}

// Direct derived writer that bypasses resolveLimsParamId's code lookup
async function saveDerivedToLims(orderId, limsName, value) {
  const paramMap = await loadParamMapForOrder(orderId);
  const paramId = paramMap[limsName.toUpperCase()];
  if (!paramId) return false;
  const { error } = await supabase.from('results').upsert(
    { order_id: orderId, parameter_id: paramId, result_value: String(value), status_flag: 'AUTOMATED', analyzer_source: 'ARROWS_KT44' },
    { onConflict: 'order_id,parameter_id' }
  );
  return !error;
}

// ============================================================
// STAGING
// ============================================================
const pendingSamples = new Map();

function stageResult(barcode, parsed, orderId) {
  if (!pendingSamples.has(barcode)) {
    pendingSamples.set(barcode, { orderId, params: {}, timeout: null });
  }
  const entry = pendingSamples.get(barcode);
  entry.params[parsed.code || parsed.name] = parsed;
  if (entry.timeout) clearTimeout(entry.timeout);
  entry.timeout = setTimeout(() => { flushSample(barcode).catch(e => addLog('[FLUSH-ERR]', e.message, C.red)); }, 6000);
}

async function flushSample(barcode) {
  const entry = pendingSamples.get(barcode);
  if (!entry) return;
  pendingSamples.delete(barcode);
  if (entry.timeout) clearTimeout(entry.timeout);

  const { orderId, params } = entry;
  const keys = Object.keys(params);
  if (keys.length === 0) return;

  // ---- 1. Save every value that maps to a real LIMS parameter ----
  let rawSaved = 0;
  for (const key of keys) {
    const p = params[key];
    const ok = await saveParamToSupabase(orderId, p.code, p.name, String(p.value));
    if (ok) rawSaved++;
  }

  // ---- 2. Pull the 3-part values from the buffer ----
  const getVal = (codeOrName) => {
    for (const k of keys) {
      const p = params[k];
      if (p.code === codeOrName || p.name === codeOrName || k === codeOrName) {
        const n = parseFloat(String(p.value).replace(/,/g, ''));
        return isNaN(n) ? 0 : n;
      }
    }
    return 0;
  };

  const granPct = getVal('10030');  // Gran%
  const midPct  = getVal('10029');  // Mid%
  const granAbs = getVal('10028');  // Gran#
  const midAbs  = getVal('10027');  // Mid#

  // WBC — check multiple potential codes
  let wbcRaw = getVal('6690-2') || getVal('WBC') || 0;
  if (wbcRaw > 0 && wbcRaw < 100) wbcRaw = wbcRaw * 1000;  // 10^9/L → /cumm

  // ---- 3. Derive 5-part from 3-part ----
  const derived = {};

  if (granPct > 0 || midPct > 0) {
    const neutPct = granPct;
    const monoPct = midPct * 0.70;
    const eosPct  = midPct * 0.25;
    const basPct  = midPct * 0.05;

    // Only save % if not already provided (Neutrophils is already mapped from Gran%)
    // For Monocytes/Eos/Basophils — always derive.
    derived['Monocytes']   = monoPct.toFixed(1);
    derived['Eosinophils'] = eosPct.toFixed(1);
    derived['Basophils']   = basPct.toFixed(1);

    if (wbcRaw > 0) {
      const wbcK = wbcRaw / 1000;
      // Only compute ANC if analyzer didn't supply Gran#
      if (granAbs > 0) {
        derived['ANC'] = granAbs.toFixed(2);
      } else {
        derived['ANC'] = ((wbcK * neutPct) / 100).toFixed(2);
      }
      // Lymphocytes% might come from analyzer; otherwise compute
      const lymPct = getVal('736-9') || getVal('Lymph%') || 0;
      if (lymPct > 0) {
        const alcVal = getVal('731-0');
        derived['ALC'] = alcVal > 0 ? alcVal.toFixed(2) : ((wbcK * lymPct) / 100).toFixed(2);
      }
      if (midAbs > 0) {
        // Split Mid# proportionally
        derived['AMC'] = (midAbs * 0.70).toFixed(2);
        derived['AEC'] = String(Math.round(wbcRaw * eosPct / 100));
        derived['ABC'] = (midAbs * 0.05).toFixed(2);
      } else {
        derived['AMC'] = ((wbcK * monoPct) / 100).toFixed(2);
        derived['AEC'] = String(Math.round((wbcRaw * eosPct) / 100));
        derived['ABC'] = ((wbcK * basPct) / 100).toFixed(2);
      }
    }
  }

  // ---- 4. PCT (Plateletcrit) — derive if analyzer didn't supply ----
  const plt = getVal('777-3') || getVal('PLT') || 0;
  const mpv = getVal('32623-1') || getVal('MPV') || 0;
  if (!getVal('10002') && plt > 0 && mpv > 0) {
    // PCT = PLT (10^3/uL) × MPV (fL) / 10000 → %
    const pct = (plt * mpv / 10000).toFixed(2);
    derived['PCT'] = pct;
  }

  // ---- 5. Save derived values by their LIMS parameter names ----
  let derivedSaved = 0;
  for (const [k, v] of Object.entries(derived)) {
    const limsName = DERIVED_KEYS[k] || k;
    const ok = await saveDerivedToLims(orderId, limsName, v);
    if (ok) { derivedSaved++; addLog('[DERIVED]', `${limsName} = ${v}`, C.cyan); }
  }

  addLog('[FLUSH]', `${barcode}: ${rawSaved} raw + ${derivedSaved} derived`, C.green);
  paramIdCache.delete(orderId);
  paramNameByIdCache.delete(orderId);
}

// ============================================================
// OBX PARSER
// ============================================================
function parseObxLine(line) {
  const f = line.split('|');
  if (f[0] !== 'OBX') return null;

  let typeIdx = -1;
  for (let i = 1; i < Math.min(f.length, 6); i++) {
    if (/^[A-Z]{2,3}$/.test((f[i] || '').trim())) { typeIdx = i; break; }
  }
  if (typeIdx === -1) return null;

  const idField = f[typeIdx + 1] || '';
  const parts = idField.split('^');
  const code = (parts[0] || '').trim();
  const name = (parts[1] || code).trim();

  // Skip empty fields between id and value
  let valueIdx = typeIdx + 2;
  while (valueIdx < f.length && (f[valueIdx] || '').trim() === '') valueIdx++;

  const value = (f[valueIdx] || '').trim();
  const unit  = (f[valueIdx + 1] || '').trim();
  const ref   = (f[valueIdx + 2] || '').trim();

  return { type: f[typeIdx] || '', code, name, value, unit, ref };
}

// ============================================================
// SEGMENT PROCESSING
// ============================================================
const SEGMENT_PREFIXES = ['MSH|','PID|','PV1|','OBR|','OBX|','ORC|','NTE|','SPM|','MSA|','QRD|','QRF|','QPD|','RCP|','NK1|','AL1|','DG1|','PR1|','GT1|','IN1|','IN2|','IN3|'];

function insertSegmentNewlines(text) {
  let out = text;
  for (const prefix of SEGMENT_PREFIXES) {
    const re = new RegExp('(?!^)' + prefix.replace('|', '\\|'), 'g');
    out = out.replace(re, '\n' + prefix);
  }
  return out;
}

let currentBarcode = null;

async function processSegment(segment) {
  const firstPipe = segment.indexOf('|');
  if (firstPipe < 0 || firstPipe > 6) return;
  const segType = segment.substring(0, firstPipe).toUpperCase();

  if (['MSH','PID','OBR','SPM'].includes(segType)) {
    const m = segment.match(/\b(20\d{8,10})\b/);
    if (m) {
      const newBc = m[1];
      if (newBc !== currentBarcode) {
        if (currentBarcode && pendingSamples.has(currentBarcode)) await flushSample(currentBarcode);
        currentBarcode = newBc;
        stats.activeSample = newBc;
        stats.queries++;
        addLog('[BARCODE]', newBc, C.cyan);
      }
    }
    return;
  }

  if (segType !== 'OBX') return;
  if (/\|ED\|/.test(segment)) return;
  if (/HISTOGRAM|BINARY|BASE64|OCTER/i.test(segment)) return;

  const parsed = parseObxLine(segment);
  if (!parsed) return;
  if (!parsed.code || !parsed.value) return;

  const barcode = currentBarcode || (stats.activeSample !== '—' ? stats.activeSample : null);
  if (!barcode) return;
  const orderId = await getOrderIdByBarcode(barcode);
  if (!orderId) return;

  const paramId = await resolveLimsParamId(orderId, parsed.code, parsed.name);

  // Intermediates — stage for derivation even though they have no LIMS param
  if (paramId === '__INTERMEDIATE__' || INTERMEDIATE_CODES.has(parsed.code)) {
    addLog('[STAGE]', `${parsed.code} (${parsed.name}) = ${parsed.value}`, C.cyan);
    stageResult(barcode, parsed, orderId);
    return;
  }

  if (!paramId) {
    addLog('[SKIP]', `${parsed.code} (${parsed.name})`, C.gray);
    return;
  }

  stats.results++;
  addLog('[RAW]', `${parsed.code} (${parsed.name}) = ${parsed.value} ${parsed.unit || ''}`, C.green);
  stageResult(barcode, parsed, orderId);
}

// ============================================================
// TCP SERVER
// ============================================================
let rawBuffer = '';

const server = net.createServer((socket) => {
  stats.clients++;
  addLog('[LINK]', `${socket.remoteAddress}`, C.green);
  rawBuffer = '';
  currentBarcode = null;

  try { socket.write(Buffer.from([ENQ])); } catch (e) {}

  socket.on('data', async (chunk) => {
    try { socket.write(Buffer.from([ACK])); } catch (e) {}

    const preview = chunk.length > 32 ? chunk.toString('hex').slice(0, 64) + '…' : chunk.toString('hex');
    console.log(C.gray + '[HEX-IN] len=' + chunk.length + ' ' + preview + C.reset);

    let text = chunk.toString('latin1');
    text = text.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '');
    text = insertSegmentNewlines(text);

    rawBuffer += text;

    const hasAnyPrefix = SEGMENT_PREFIXES.some(p => rawBuffer.includes(p));
    if (!hasAnyPrefix) {
      if (rawBuffer.length > 400) rawBuffer = rawBuffer.slice(-200);
      return;
    }

    const lines = rawBuffer.split(/\r?\n/);
    rawBuffer = lines.pop() || '';

    if (rawBuffer.length > 4096 && !SEGMENT_PREFIXES.some(p => rawBuffer.includes(p))) {
      rawBuffer = '';
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { await processSegment(trimmed); }
      catch (e) { addLog('[ERR]', e.message, C.red); }
    }
  });

  socket.on('close', async () => {
    stats.clients = Math.max(0, stats.clients - 1);
    for (const bc of Array.from(pendingSamples.keys())) {
      await flushSample(bc).catch(() => {});
    }
    addLog('[UNLINK]', 'disconnected', C.yellow);
  });

  socket.on('error', (err) => addLog('[ERR]', err.message, C.red));
});

const port = parseInt(process.env.ARROWS_PORT || '5200', 10);
server.listen(port, '0.0.0.0', () => renderDashboard());