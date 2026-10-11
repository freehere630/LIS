// ============================================================
// APEX LIS BRIDGE — Arrows KT-44 (Hematology / CBC)
// Bidirectional ASTM E1394 communication engine
// ============================================================

import net from 'net';
import os from 'os';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

// ASTM control characters
const ENQ = '\x05', ACK = '\x06', NAK = '\x15', EOT = '\x04';
const STX = '\x02', ETX = '\x03', CR = '\x0D', LF = '\x0A';

// Console colors
const C = {
  reset:  '\x1b[0m',
  bright: '\x1b[1m',
  blue:   '\x1b[34m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
  white:  '\x1b[37m',
};

// ============================================================
// CODE → LIMS PARAMETER NAME MAP
// Matches the exact names in MASTER_CBC_PARAMETERS (api.js)
// Add entries here if your KT-44 emits codes we don't know yet.
// ============================================================
const CODE_TO_LIMS_NAME = {
  // ---- Red cell series ----
  'HGB':    'Hemoglobin (Hb)',
  'HB':     'Hemoglobin (Hb)',
  'RBC':    'Total Red Blood Cell Count (RBC)',
  'HCT':    'Packed Cell Volume (PCV / Hematocrit)',
  'PCV':    'Packed Cell Volume (PCV / Hematocrit)',
  'MCV':    'Mean Corpuscular Volume (MCV)',
  'MCH':    'Mean Corpuscular Hemoglobin (MCH)',
  'MCHC':   'Mean Corpuscular Hb Concentration (MCHC)',
  'RDW-CV': 'RDW-CV',
  'RDWCV':  'RDW-CV',
  'RDW-SD': 'RDW-SD',
  'RDWSD':  'RDW-SD',

  // ---- White cell series ----
  'WBC':    'Total Leucocyte Count (WBC)',
  'GRAN%':  'Granulocytes (Machine Gran%)',
  'GRA%':   'Granulocytes (Machine Gran%)',
  'GRAN':   'Granulocytes (Machine Gran%)',
  'LYMPH%': 'Lymphocytes (Machine Lymph%)',
  'LYM%':   'Lymphocytes (Machine Lymph%)',
  'LYMPH':  'Lymphocytes (Machine Lymph%)',
  'MID%':   'Mid-cells (Machine Mid%)',
  'MON%':   'Mid-cells (Machine Mid%)',
  'MID':    'Mid-cells (Machine Mid%)',

  // ---- Platelet series ----
  'PLT':    'Total Platelet Count',
  'MPV':    'Mean Platelet Volume (MPV)',
  'PDW':    'Platelet Distribution Width (PDW)',

  // 5-part differential percentages (match your LIMS template)
  'Neutrophils':  'Neutrophils',
  'Lymphocytes':  'Lymphocytes',
  'Monocytes':    'Monocytes',
  'Eosinophils':  'Eosinophils',
  'Basophils':    'Basophils',

  // Absolute counts (bridge computes these from WBC × percentage)
  'ANC':  'Absolute Neutrophil Count (ANC)',
  'ALC':  'Absolute Lymphocyte Count (ALC)',
  'AMC':  'Absolute Monocyte Count (AMC)',
  'AEC':  'Absolute Eosinophil Count (AEC)',
  'ABC':  'Absolute Basophil Count (ABC)',

  // Platelet indices the bridge can derive
  'PCT':  'Plateletcrit (PCT)',
};

// ============================================================
// LIVE TELEMETRY
// ============================================================
const stats = {
  startedAt:    new Date().toLocaleTimeString(),
  supabase:     'CONNECTING...',
  clients:      0,
  queries:      0,
  results:      0,
  activeSample: '—',
};

const recentLogs = [];

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
  recentLogs.unshift(
    `${C.gray}[${time}]${C.reset} ${color}${tag.padEnd(10)}${C.reset} ${message}`
  );
  if (recentLogs.length > 8) recentLogs.pop();
  renderDashboard();
}

function renderDashboard() {
  console.clear();
  const linkStatus = stats.clients > 0
    ? `${C.green}● CONNECTED (Online & Communicating)${C.reset}`
    : `${C.yellow}○ LISTENING (Awaiting Arrows KT-44 connection)${C.reset}`;

  console.log(`
${C.cyan}${C.bright}╔══════════════════════════════════════════════════════════════════════════════════╗
║               APEX LIS BRIDGE — ARROWS KT-44 (HEMATOLOGY / CBC)                  ║
║                     Bidirectional ASTM & HL7 Communication Engine                ║
╚══════════════════════════════════════════════════════════════════════════════════╝${C.reset}

  ${C.white}${C.bright}CONNECTION SPECIFICATIONS${C.reset}
  Local Server IP:  ${C.yellow}${C.bright}${getLocalIp()}${C.reset}
  Listening Port:   ${C.yellow}TCP ${process.env.ARROWS_PORT || 5200}${C.reset}
  Link Status:      ${linkStatus}
  Cloud LIMS:       ${stats.supabase.includes('OK') ? `${C.green}● LIVE CLOUD ACTIVE${C.reset}` : `${C.red}● ${stats.supabase}${C.reset}`}

${C.cyan}────────────────────────────────────────────────────────────────────────────────────${C.reset}
  ${C.white}${C.bright}SESSION COUNTERS${C.reset}
  Host Queries:     ${C.cyan}${stats.queries} blood samples scanned${C.reset}
  CBC Parameters:   ${C.green}${stats.results} results transferred${C.reset}
  Active Specimen:  ${C.white}${C.bright}${stats.activeSample}${C.reset}

${C.cyan}────────────────────────────────────────────────────────────────────────────────────${C.reset}
  ${C.white}${C.bright}ARROWS KT-44 LIVE DATA STREAM${C.reset}
${recentLogs.length > 0 ? recentLogs.join('\n') : `  ${C.gray}Awaiting whole blood vial aspiration on Arrows KT-44...${C.reset}`}

${C.cyan}────────────────────────────────────────────────────────────────────────────────────${C.reset}
  ${C.gray}Minimize to keep running in background. Press [Ctrl + C] to close this bridge only.${C.reset}
`);
}

// ============================================================
// SUPABASE CLIENT
// ============================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

(async () => {
  try {
    const { error } = await supabase.from('orders').select('id').limit(1);
    stats.supabase = error ? `ERROR (${error.code})` : 'OK (Connected)';
  } catch (e) {
    stats.supabase = 'DISCONNECTED';
  }
  renderDashboard();
})();

// ============================================================
// ASTM FRAME HELPERS
// ============================================================
function calculateAstmChecksum(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    sum = (sum + frame.charCodeAt(i)) % 256;
  }
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

function makeAstmFrame(frameNumber, payload) {
  const inner = `${frameNumber}${payload}${CR}${ETX}`;
  return `${STX}${inner}${calculateAstmChecksum(inner)}${CR}${LF}`;
}

// ============================================================
// HOST QUERY — Analyzer scanned a barcode, asks for worklist
// ============================================================
async function handleHostQuery(sampleBarcode, socket) {
  stats.queries++;
  stats.activeSample = sampleBarcode;
  addLog('[QUERY]', `Arrows KT-44 scanned tube: ${C.bright}${sampleBarcode}${C.reset}`, C.yellow);

  const { data: order, error } = await supabase
    .from('orders')
    .select(`*, patient:patients(*), order_tests(*, test:tests(*, test_parameters(*)))`)
    .eq('barcode', sampleBarcode.trim())
    .maybeSingle();

  if (error || !order) {
    addLog('[NO-ORDER]', `Barcode ${sampleBarcode} not in database`, C.red);
    socket.write(makeAstmFrame(1, `H|\\^&|||ApexLIS|||||||P|1`));
    socket.write(makeAstmFrame(2, `Q|1|^${sampleBarcode}||ALL||||||||X`));
    socket.write(makeAstmFrame(3, `L|1|N`));
    return;
  }

  const patient = order.patient || {};
  const genderCode = (patient.gender || '').toUpperCase().startsWith('F') ? 'F' : 'M';
  const ageStr = patient.age ? String(patient.age) : '0';
  const patientName = (patient.name || 'Patient').replace(/[|\^]/g, '');

  socket.write(makeAstmFrame(1, `H|\\^&|||ApexLIS|||||||P|1`));
  socket.write(makeAstmFrame(2, `P|1||${patient.id || 'PID'}||${patientName}||${ageStr}|${genderCode}`));
  socket.write(makeAstmFrame(3, `O|1|${sampleBarcode}||^^^CBC|||||||A||||WholeBlood`));
  socket.write(makeAstmFrame(4, `L|1|N`));

  addLog('[DISPATCH]', `Sent CBC worklist to Arrows KT-44 for ${sampleBarcode}`, C.green);
}

// ============================================================
// CBC PARAMETER BUFFER + 5-PART DIFFERENTIAL DERIVATION
// ============================================================
const pendingSamples = new Map();
//   Map< barcode, { orderId, params: {}, timeout } >

function normalizeWbc(raw) {
  // 3-part analyzers usually send WBC as 10^3/uL (e.g. 6.5).
  // The LIMS stores /cumm (e.g. 6500). If the machine value looks
  // like thousands (below 100), scale it up. No real patient has
  // WBC below 100 /cumm.
  const n = parseFloat(String(raw).replace(/,/g, ''));
  if (isNaN(n)) return null;
  return n < 100 ? (n * 1000).toFixed(0) : n.toFixed(0);
}

// Cache: order_id -> { paramName -> paramId }
const paramIdCache = new Map();

async function loadParamMapForOrder(orderId) {
  if (paramIdCache.has(orderId)) return paramIdCache.get(orderId);

  const { data: orderTests } = await supabase
    .from('order_tests')
    .select('test:tests(test_parameters(*))')
    .eq('order_id', orderId);

  const map = {};
  if (orderTests) {
    for (const ot of orderTests) {
      const params = ot.test?.test_parameters || [];
      for (const p of params) {
        if (p.name) map[p.name.trim()] = p.id;
      }
    }
  }
  paramIdCache.set(orderId, map);
  return map;
}

async function resolveLimsParamId(orderId, code) {
  const trimmed = String(code || '').trim();
  if (!trimmed) return null;

  // 1. Look up the LIMS parameter NAME from our static map
  let limsName = CODE_TO_LIMS_NAME[trimmed.toUpperCase()];
  if (!limsName) limsName = CODE_TO_LIMS_NAME[trimmed]; // exact case (for derived names)
  if (!limsName) {
    addLog('[UNMAPPED]', `Code '${trimmed}' not in CODE_TO_LIMS_NAME`, C.yellow);
    return null;
  }

  // 2. Get exact param ID for this order
  const paramMap = await loadParamMapForOrder(orderId);
  const paramId = paramMap[limsName];
  if (!paramId) {
    addLog(
      '[UNMAPPED]',
      `Code '${trimmed}' → '${limsName}' but order has no such parameter`,
      C.yellow
    );
    return null;
  }
  return paramId;
}

async function saveParamToSupabase(orderId, code, value) {
  const paramId = await resolveLimsParamId(orderId, code);
  if (!paramId) return false;

  const { error } = await supabase.from('results').upsert(
    {
      order_id: orderId,
      parameter_id: paramId,
      result_value: String(value).trim(),
      status_flag: 'AUTOMATED',
      analyzer_source: 'ARROWS_KT44',
    },
    { onConflict: 'order_id,parameter_id' }
  );

  if (error) {
    addLog('[DB-ERR]', `Save failed for ${code}: ${error.message}`, C.red);
    return false;
  }
  return true;
}

async function flushSample(sampleBarcode) {
  const entry = pendingSamples.get(sampleBarcode);
  if (!entry) return;

  pendingSamples.delete(sampleBarcode);
  if (entry.timeout) clearTimeout(entry.timeout);

  const { orderId, params } = entry;
  const rawKeys = Object.keys(params);
  if (rawKeys.length === 0) return;

  // 1. Persist every raw machine value
  let rawSaved = 0;
  for (const code of rawKeys) {
    const val = params[code];
    const valueToSave = code.toUpperCase() === 'WBC' ? normalizeWbc(val) : String(val);
    if (valueToSave == null) continue;
    const ok = await saveParamToSupabase(orderId, code, valueToSave);
    if (ok) rawSaved++;
  }

  // 2. Derive 5-part differential from 3-part machine output
  const norm = (k) => {
    const v = params[k];
    return v != null ? parseFloat(v) : null;
  };

  const lymphPct = norm('Lymph%') ?? norm('LYM%') ?? norm('Lymph') ?? 0;
  const midPct   = norm('Mid%')   ?? norm('MON%') ?? norm('Mid')   ?? 0;
  const granPct  = norm('Gran%')  ?? norm('GRA%') ?? norm('Gran')  ?? 0;
  const wbcRaw   = params['WBC'] ?? params['Wbc'] ?? null;

  const derived = {};

  if (granPct > 0 || lymphPct > 0 || midPct > 0) {
    const neutPct = granPct;
    const lymPct  = lymphPct;
    const monPct  = midPct * 0.70;
    const eosPct  = midPct * 0.25;
    const basPct  = midPct * 0.05;

    // ---- 5-part differential percentages (as the analyzer reported) ----
    derived['Neutrophils'] = neutPct.toFixed(1);
    derived['Lymphocytes'] = lymPct.toFixed(1);
    derived['Monocytes']   = monPct.toFixed(1);
    derived['Eosinophils'] = eosPct.toFixed(1);
    derived['Basophils']   = basPct.toFixed(1);

    if (wbcRaw != null) {
      const wbcCumm = parseFloat(normalizeWbc(wbcRaw));
      if (!isNaN(wbcCumm) && wbcCumm > 0) {
        const wbcThousands = wbcCumm / 1000;   // convert /cumm → 10^9/L

        // ---- Absolute counts in 10^9/L (except AEC which is per /cumm) ----
        derived['ANC'] = ((wbcThousands * neutPct) / 100).toFixed(2);
        derived['ALC'] = ((wbcThousands * lymPct)  / 100).toFixed(2);
        derived['AMC'] = ((wbcThousands * monPct)  / 100).toFixed(2);
        derived['ABC'] = ((wbcThousands * basPct)  / 100).toFixed(2);

        // AEC is stored as an absolute raw count (/cumm) in your template
        derived['AEC'] = String(Math.round((wbcCumm * eosPct) / 100));
      }
    }
  }

  // ---- Plateletcrit = PLT (10^3/uL) × MPV (fL) / 10,000 ----
  const pltRaw = params['PLT'] ?? params['Plt'];
  const mpvRaw = params['MPV'] ?? params['Mpv'];
  if (pltRaw != null && mpvRaw != null) {
    const pltNum = parseFloat(pltRaw);
    const mpvNum = parseFloat(mpvRaw);
    if (!isNaN(pltNum) && !isNaN(mpvNum) && pltNum > 0 && mpvNum > 0) {
      derived['PCT'] = (pltNum * mpvNum / 10000).toFixed(2);
    }
  }

  // 3. Persist derived values
  let derivedSaved = 0;
  for (const [code, val] of Object.entries(derived)) {
    const ok = await saveParamToSupabase(orderId, code, val);
    if (ok) derivedSaved++;
  }

  addLog(
    '[FLUSH]',
    `Sample ${sampleBarcode}: ${rawSaved}/${rawKeys.length} raw + ${derivedSaved} derived saved`,
    C.green
  );

  // Free the param cache for this order to avoid unbounded growth
  paramIdCache.delete(orderId);
}

function stageResult(sampleBarcode, testCode, resultValue, orderId) {
  if (!pendingSamples.has(sampleBarcode)) {
    pendingSamples.set(sampleBarcode, { orderId, params: {}, timeout: null });
  }
  const entry = pendingSamples.get(sampleBarcode);
  entry.params[testCode.trim()] = String(resultValue).trim();

  if (entry.timeout) clearTimeout(entry.timeout);
  entry.timeout = setTimeout(() => {
    flushSample(sampleBarcode).catch((e) =>
      addLog('[FLUSH-ERR]', e.message, C.red)
    );
  }, 8000);
}

async function handleIncomingResult(sampleBarcode, testCode, resultValue) {
  stats.results++;
  stats.activeSample = `${sampleBarcode} (${testCode}: ${resultValue})`;

  // DIAGNOSTIC: log every raw code the analyzer sends so we can extend
  // CODE_TO_LIMS_NAME if any code shows up as [UNMAPPED] later.
  addLog('[RAW]', `'${testCode}' = ${resultValue}`, C.gray);

  const { data: order } = await supabase
    .from('orders')
    .select('id')
    .eq('barcode', sampleBarcode.trim())
    .maybeSingle();

  if (!order) {
    addLog('[ERR]', `Unknown tube barcode: ${sampleBarcode}`, C.red);
    return;
  }

  stageResult(sampleBarcode.trim(), testCode, resultValue, order.id);
}

// ============================================================
// TCP SERVER
// ============================================================
const server = net.createServer((socket) => {
  stats.clients++;
  addLog('[LINK]', `Arrows KT-44 connected (${socket.remoteAddress})`, C.green);

  let buffer = '';
  let currentBarcode = '';

  socket.on('data', async (chunk) => {
    const dataStr = chunk.toString('ascii');

    // Handle ENQ handshake carefully: some analyzers send ENQ + first
    // frame in the same TCP packet. Don't return early — just ACK and
    // fall through to process the rest.
    if (dataStr.includes(ENQ)) {
      socket.write(ACK);
    }

    // Strip control chars except CR/LF before buffer processing
    const cleaned = dataStr.replace(/[\x02\x03\x04\x05\x06]/g, '');
    buffer += cleaned;

    if (buffer.includes(CR) || buffer.includes(LF)) {
      socket.write(ACK);
      const lines = buffer.split(/[\r\n]+/);
      buffer = '';

      for (const rawLine of lines) {
        // Strip leading frame number digit(s)
        const clean = rawLine.replace(/^\d+/, '');
        const parts = clean.split('|');
        const type = parts[0]?.trim();

        if (type === 'O') {
          const incomingBarcode = parts[2]?.trim() || '';
          if (currentBarcode && currentBarcode !== incomingBarcode) {
            await flushSample(currentBarcode);
          }
          currentBarcode = incomingBarcode;
        } else if (type === 'H') {
          for (const bc of Array.from(pendingSamples.keys())) {
            await flushSample(bc);
          }
          currentBarcode = '';
        } else if (type === 'Q') {
          const qBarcode = parts[2]?.replace(/^\^/, '').split('^')[0]?.trim();
          if (qBarcode) await handleHostQuery(qBarcode, socket);
        } else if (type === 'R') {
          const tCode = (parts[2] || '').replace(/^\^+/, '').split('^')[0]?.trim();
          const val = parts[3]?.trim();
          if (currentBarcode && tCode && val) {
            await handleIncomingResult(currentBarcode, tCode, val);
          }
        } else if (type === 'L') {
          if (currentBarcode) await flushSample(currentBarcode);
          currentBarcode = '';
        }
      }
    }
  });

  socket.on('close', async () => {
    stats.clients = Math.max(0, stats.clients - 1);
    for (const bc of Array.from(pendingSamples.keys())) {
      await flushSample(bc).catch(() => {});
    }
    addLog('[UNLINK]', `Arrows KT-44 disconnected`, C.yellow);
  });

  socket.on('error', (err) => {
    addLog('[ERROR]', `Arrows: ${err.message}`, C.red);
  });
});

const port = parseInt(process.env.ARROWS_PORT || '5200', 10);
server.listen(port, '0.0.0.0', () => renderDashboard());