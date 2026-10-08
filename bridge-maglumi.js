import net from 'net';
import os from 'os';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

// MLLP Framing Bytes (Page B-10 Table 1.3-1)
const VT = '\x0B'; // 0x0B (<SB> Start Block)
const FS = '\x1C'; // 0x1C (<EB> End Block)
const CR = '\x0D'; // 0x0D (<CR> Carriage Return)
const LF = '\x0A';

// App-Like Modern Color Palette
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  cyan: '\x1b[96m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  magenta: '\x1b[95m',
  red: '\x1b[91m',
  blue: '\x1b[94m',
  gray: '\x1b[90m',
  white: '\x1b[97m'
};

// 10-Minute In-Memory Cache (Protects Supabase Free Tier)
const orderCache = new Map();
function cacheOrder(barcode, orderData) {
  orderCache.set(String(barcode).trim(), {
    data: orderData,
    expiry: Date.now() + (10 * 60 * 1000)
  });
}

function getCachedOrder(barcode) {
  const cached = orderCache.get(String(barcode).trim());
  if (cached && Date.now() < cached.expiry) return cached.data;
  orderCache.delete(String(barcode).trim());
  return null;
}

const stats = {
  clients: 0,
  queries: 0,
  results: 0,
  activeSample: '—',
  supabase: 'CONNECTING...'
};

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function timestamp() {
  return new Date().toLocaleTimeString();
}

function getLocalHl7Timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function log(tag, message, color = C.cyan) {
  console.log(`${C.gray}[${timestamp()}]${C.reset} ${color}${tag.padEnd(11)}${C.reset} ${message}`);
}

console.log(`
${C.magenta}${C.bold}╔══════════════════════════════════════════════════════════════════════════════════════╗
║               APEX LIS BRIDGE — SNIBE MAGLUMI X3 (OFFICIAL HL7 OML^O33)              ║
║                 Profile-Expansion & Smart Clinical Alias Engine                      ║
╚══════════════════════════════════════════════════════════════════════════════════╝${C.reset}

${C.cyan}╭─── SYSTEM TELEMETRY ─────────────────────────────────────────────────────────────────╮${C.reset}
${C.cyan}│${C.reset}  ${C.white}Local Server IP :${C.reset} ${C.yellow}${C.bold}${getLocalIp()}${C.reset} (Port: ${C.yellow}${process.env.MAGLUMI_PORT || 5003}${C.reset})
${C.cyan}│${C.reset}  ${C.white}Profile Support :${C.reset} ${C.green}Active (Auto-unpacks Profiles into Individual Assays)${C.reset}
${C.cyan}│${C.reset}  ${C.white}Maglumi Link    :${C.reset} ${stats.clients > 0 ? `${C.green}${C.bold}● CONNECTED & ONLINE${C.reset}` : `${C.yellow}○ LISTENING (Awaiting Analyzer)${C.reset}`}
${C.cyan}│${C.reset}  ${C.white}Supabase Cloud  :${C.reset} ${stats.supabase.includes('OK') ? `${C.green}${C.bold}● LIVE CLOUD ACTIVE${C.reset}` : `${C.yellow}● ${stats.supabase}${C.reset}`}
${C.cyan}╰──────────────────────────────────────────────────────────────────────────────────────╯${C.reset}
`);

// Supabase Connection
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  try {
    const { error } = await supabase.from('orders').select('id').limit(1);
    if (error) {
      stats.supabase = `ERROR: ${error.message}`;
      log('[CLOUD]', `${C.red}Database Error: ${error.message}${C.reset}`);
    } else {
      stats.supabase = 'OK (Live)';
      log('[CLOUD]', `${C.green}Supabase Cloud Database Online & Synchronized${C.reset}`);
    }
  } catch (e) {
    stats.supabase = 'OFFLINE';
    log('[CLOUD]', `${C.red}Connection failed: ${e.message}${C.reset}`);
  }
})();

function wrapMllp(hl7Text) {
  return `${VT}${hl7Text}${FS}${CR}`;
}

function makeHl7Ack(mshSegment, ackCode = 'AA', textMessage = 'Message Accepted') {
  const fields = (mshSegment || '').split('|');
  const sendingApp = fields[4] || 'Lis';
  const receivingApp = fields[2] || 'Maglumi X3';
  const messageControlId = fields[9] || '1';
  const localNow = getLocalHl7Timestamp();

  const msh = `MSH|^~\\&|${sendingApp}||${receivingApp}||${localNow}||ACK|${Date.now()}|P|2.5|||NE|NE||UTF-8`;
  const msa = `MSA|${ackCode}|${messageControlId}|${textMessage}`;

  return `${msh}${CR}${msa}${CR}`;
}

function cleanBarcodeString(raw) {
  if (!raw) return '';
  const firstToken = String(raw).split('^')[0].trim();
  const match = firstToken.match(/^(202\d{6,8}|\d{6,14}|[A-Za-z0-9_-]+)/);
  return match ? match[1] : firstToken;
}

// SMART CLINICAL ALIAS DICTIONARY (Maps Maglumi assay codes to LIMS parameter names)
const ASSAY_ALIASES = [
  { maglumi: ['FT3', 'FT3 II'], lims: ['FT3', 'FT3 II', 'FREE T3', 'FREE TRIIODOTHYRONINE'] },
  { maglumi: ['FT4', 'FT4 II'], lims: ['FT4', 'FT4 II', 'FREE T4', 'FREE THYROXINE'] },
  { maglumi: ['TT3', 'TT3 II'], lims: ['TT3', 'TT3 II', 'TOTAL T3', 'T3'] },
  { maglumi: ['TT4', 'TT4 II'], lims: ['TT4', 'TT4 II', 'TOTAL T4', 'T4'] },
  { maglumi: ['TSH', 'TSH II'], lims: ['TSH', 'TSH II', 'THYROID STIMULATING HORMONE'] },
  { maglumi: ['PSA', 'TPSA'],   lims: ['PSA', 'TOTAL PSA'] },
  { maglumi: ['FPSA'],         lims: ['FPSA', 'FREE PSA'] },
  { maglumi: ['VB12'],         lims: ['VB12', 'VITAMIN B12', 'B12'] },
  { maglumi: ['VD', '25-OH VD II'], lims: ['VD', 'VITAMIN D', '25-OH VITAMIN D'] },
  { maglumi: ['FERR', 'FERRITIN II'], lims: ['FERR', 'FERRITIN'] },
  { maglumi: ['HCG', 'T-B HCG II'], lims: ['HCG', 'BETA HCG', 'B-HCG', 'TOTAL HCG'] },
  { maglumi: ['A-CCP'],        lims: ['A-CCP', 'ANTI-CCP', 'ANTI CCP', 'CCP'] },
  { maglumi: ['PRL', 'PRL II'], lims: ['PRL', 'PROLACTIN'] },
  { maglumi: ['FSH', 'FSH II'], lims: ['FSH'] },
  { maglumi: ['LH', 'LH II'],   lims: ['LH'] },
  { maglumi: ['E2', 'ESTRADIOL'], lims: ['E2', 'ESTRADIOL'] },
  { maglumi: ['TESTO', 'TEST II'], lims: ['TESTO', 'TESTOSTERONE'] },
  { maglumi: ['cTnI', 'cTnI II'],  lims: ['CTNI', 'TROPONIN I', 'TROPONIN'] },
  { maglumi: ['HBsAg Quant'],      lims: ['HBSAG', 'HBSAG QUANT'] }
];

function resolveAssayToMaglumiCode(text) {
  const up = String(text || '').trim().toUpperCase();
  for (const alias of ASSAY_ALIASES) {
    if (alias.lims.some(l => up === l || up.includes(l))) {
      return alias.maglumi;
    }
  }
  return [text.trim()];
}

function extractTubeBarcode(hl7Segments = []) {
  const spmSeg = hl7Segments.find(s => s.startsWith('SPM'));
  if (spmSeg) {
    const parts = spmSeg.split('|');
    const val = cleanBarcodeString(parts[2]);
    if (val) return val;
  }

  const obrSeg = hl7Segments.find(s => s.startsWith('OBR'));
  if (obrSeg) {
    const parts = obrSeg.split('|');
    const val = cleanBarcodeString(parts[2] || parts[3]);
    if (val && val !== '1' && val !== '0') return val;
  }

  const pidSeg = hl7Segments.find(s => s.startsWith('PID'));
  if (pidSeg) {
    const parts = pidSeg.split('|');
    const val = cleanBarcodeString(parts[3] || parts[2]);
    if (val) return val;
  }

  return '';
}

// 1. HOST QUERY: EXPANDS PROFILES INTO INDIVIDUAL ASSAYS
async function handleHl7Query(qSegment, mshSegment, socket, allSegments) {
  stats.queries++;
  const localNow = getLocalHl7Timestamp();
  const mshParts = (mshSegment || '').split('|');
  const qpdParts = (qSegment || '').split('|');

  const incomingControlId = mshParts[9] || '1';
  const sendingApp = mshParts[4] || 'Lis';
  const receivingApp = mshParts[2] || 'Maglumi X3';

  const rawBarcodeField = (qpdParts[3] || qpdParts[8] || '').trim();
  const sampleBarcode = cleanBarcodeString(rawBarcodeField);

  let rackPos = 'NA001^1';
  if (rawBarcodeField.includes('^')) {
    const tokens = rawBarcodeField.split('^').filter(Boolean);
    if (tokens.length >= 3) rackPos = `${tokens[1]}^${tokens[2]}`;
    else if (tokens.length >= 2) rackPos = tokens[1];
  }

  stats.activeSample = sampleBarcode;

  console.log(`
${C.yellow}╭─── INCOMING HOST QUERY (TSREQ) ──────────────────────────────────────╮${C.reset}
${C.yellow}│${C.reset}  Tube Barcode  : ${C.white}${C.bold}${sampleBarcode}${C.reset}
${C.yellow}│${C.reset}  Rack/Position : ${C.gray}${rackPos}${C.reset}
${C.yellow}╰──────────────────────────────────────────────────────────────────────╯${C.reset}
`);

  // Check cache first
  let order = getCachedOrder(sampleBarcode);
  if (!order) {
    let { data: dbOrder } = await supabase
      .from('orders')
      .select(`*, patient:patients(*), order_tests(*, test:tests(*, test_parameters(*)))`)
      .eq('barcode', sampleBarcode)
      .maybeSingle();

    if (!dbOrder) {
      const { data: fallbackOrder } = await supabase
        .from('orders')
        .select(`*, patient:patients(*), order_tests(*, test:tests(*, test_parameters(*)))`)
        .or(`barcode.ilike.%${sampleBarcode}%,patient_id.eq.${sampleBarcode},id.eq.${sampleBarcode}`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      dbOrder = fallbackOrder;
    }

    order = dbOrder;
    if (order) cacheOrder(sampleBarcode, order);
  }

  if (!order) {
    log('[NO-ORDER]', `${C.red}Barcode ${sampleBarcode} not found in database${C.reset}`, C.red);
    socket.write(wrapMllp(makeHl7Ack(mshSegment, 'AE', `Barcode ${sampleBarcode} Not Found`)));
    return;
  }

  // PROFILE EXPANSION ENGINE:
  // If the ordered test is a profile (e.g. Thyroid Profile), unpack each of its child parameters (TSH, FT3, FT4)!
  const assayList = [];

  (order.order_tests || []).forEach(ot => {
    const test = ot.test || {};
    const params = test.test_parameters || test.parameters || [];

    if (params.length > 1) {
      // It's a profile panel! Unpack each parameter into an individual Maglumi assay:
      params.forEach(p => {
        const codes = resolveAssayToMaglumiCode(p.name);
        codes.forEach(c => {
          if (!assayList.includes(c)) assayList.push(c);
        });
      });
    } else {
      // It's an individual single test:
      const codes = resolveAssayToMaglumiCode(test.code || test.name || '');
      codes.forEach(c => {
        if (!assayList.includes(c)) assayList.push(c);
      });
    }
  });

  if (assayList.length === 0) {
    log('[NO-TESTS]', `No Maglumi assays prescribed for ${sampleBarcode}`, C.yellow);
    socket.write(wrapMllp(makeHl7Ack(mshSegment, 'AA', 'No Tests Prescribed')));
    return;
  }

  const patient = order.patient || {};
  const gender = (patient.gender || '').toUpperCase().startsWith('F') ? 'Female' : 'Male';
  const patientName = (patient.name || 'Patient').replace(/[|^\\]/g, '');
  const patientId = String(patient.id || sampleBarcode);

  // OFFICIAL SNIBE MAGLUMI X3 SPECIFICATION (Page B-19 Section 1.3.5.1):
  const respMsh = `MSH|^~\\&|${sendingApp}||${receivingApp}||${localNow}||OML^O33|${incomingControlId}|P|2.5|||NE|NE||UTF-8`;
  const respPid = `PID|1||${patientId}||${patientName}|||${gender}||||||||||||||||||||||||||||||^Years Old`;
  const respSpm = `SPM|1|${sampleBarcode}^^|||||||||P`;
  const respOrc = `ORC|NW||||||N`;

  // Build OBR line for each assay in the profile:
  const obrSegments = assayList.map((testCode, idx) => 
    `OBR|${idx + 1}|||${testCode}^`
  ).join(CR);

  const fullResponse = `${respMsh}${CR}${respPid}${CR}${respSpm}${CR}${respOrc}${CR}${obrSegments}${CR}`;
  socket.write(wrapMllp(fullResponse));

  console.log(`
${C.green}╭─── WORKLIST DISPATCHED TO MAGLUMI (OML^O33) ─────────────────────────╮${C.reset}
${C.green}│${C.reset}  Patient Name : ${C.white}${patientName} (${patientId})${C.reset}
${C.green}│${C.reset}  Auto-Selected: ${C.cyan}${C.bold}${assayList.join(', ')}${C.reset}
${C.green}│${C.reset}  Profile Tests: ${C.green}✓ All child assays in profile unpacked & dispatched!${C.reset}
${C.green}╰──────────────────────────────────────────────────────────────────────╯${C.reset}
`);
}

// 2. RECEIVE RESULTS: SMART ALIAS MATCHING BACK TO PROFILE PARAMETERS
async function handleHl7Results(hl7Segments, mshSegment, socket) {
  socket.write(wrapMllp(makeHl7Ack(mshSegment, 'AA', 'Results Accepted')));

  const sampleBarcode = extractTubeBarcode(hl7Segments) || (stats.activeSample !== '—' ? stats.activeSample : 'UNKNOWN');
  stats.activeSample = sampleBarcode;

  const parsedResults = [];

  for (const seg of hl7Segments) {
    const parts = seg.split('|');
    const segType = parts[0]?.trim();

    if (segType === 'OBX') {
      const testIdentifier = parts[3] || '';
      const subParts = testIdentifier.split('^').filter(Boolean);
      const testCode = subParts[0] || testIdentifier.trim();
      const testName = subParts[1] || testCode;
      
      const resultValue = (parts[5] || '').trim();
      const unit = (parts[6] || '').trim();
      const refRange = (parts[7] || '').trim();

      if (testCode && resultValue !== '') {
        parsedResults.push({ testCode, testName, resultValue, unit, refRange });
      }
    }
  }

  for (const res of parsedResults) {
    stats.results++;

    console.log(`
${C.magenta}╭─── MAGLUMI X3 TEST RESULT RECEIVED (OUL^R22) ────────────────────────╮${C.reset}
${C.magenta}│${C.reset}  ${C.white}Tube Barcode${C.reset} : ${C.yellow}${C.bold}${sampleBarcode}${C.reset}
${C.magenta}│${C.reset}  ${C.white}Assay / Test${C.reset} : ${C.cyan}${C.bold}${res.testName} (${res.testCode})${C.reset}
${C.magenta}│${C.reset}  ${C.white}Result Value${C.reset} : ${C.green}${C.bold}${res.resultValue}${C.reset}
${C.magenta}│${C.reset}  ${C.white}Unit${C.reset}         : ${C.blue}${C.bold}${res.unit || '—'}${C.reset}
${C.magenta}│${C.reset}  ${C.white}Ref. Range${C.reset}   : ${C.gray}${res.refRange || 'Standard'}${C.reset}
${C.magenta}╰──────────────────────────────────────────────────────────────────────╯${C.reset}
`);

    // Save to Cloud Supabase
    try {
      let { data: order } = await supabase
        .from('orders')
        .select(`id, qc_status, is_locked, order_tests(*, test:tests(*, test_parameters(*)))`)
        .eq('barcode', sampleBarcode)
        .maybeSingle();

      if (!order) {
        const { data: patientOrder } = await supabase
          .from('orders')
          .select(`id, qc_status, is_locked, order_tests(*, test:tests(*, test_parameters(*)))`)
          .eq('patient_id', sampleBarcode)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        order = patientOrder;
      }

      if (!order) {
        log('[NOT-SAVED]', `${C.yellow}Order ${sampleBarcode} not in Supabase${C.reset}`);
        continue;
      }

      if (order.is_locked === true || order.qc_status === 'Verified') {
        console.log(`  ${C.yellow}⚠ Order ${order.id} is VERIFIED & LOCKED! Machine result discarded.${C.reset}`);
        continue;
      }

      // FIND EXACT PARAMETER MATCH (Even inside Multi-Parameter Profiles!)
      let targetParamId = null;
      const cleanMachineCode = res.testCode.toUpperCase().replace(/\s+/g, '');

      // Check all parameters inside the ordered tests
      for (const ot of (order.order_tests || [])) {
        const params = ot.test?.test_parameters || ot.test?.parameters || [];
        for (const p of params) {
          const pName = (p.name || '').toUpperCase().replace(/\s+/g, '');
          
          // Match by name or alias (e.g. 'FT3' matches 'Free T3', 'TSH' matches 'TSH')
          if (
            pName === cleanMachineCode ||
            pName.includes(cleanMachineCode) ||
            cleanMachineCode.includes(pName) ||
            (cleanMachineCode.includes('FT3') && pName.includes('FREET3')) ||
            (cleanMachineCode.includes('FT4') && pName.includes('FREET4')) ||
            (cleanMachineCode.includes('TT3') && pName.includes('TOTALT3')) ||
            (cleanMachineCode.includes('TT4') && pName.includes('TOTALT4'))
          ) {
            targetParamId = p.id;
            break;
          }
        }
        if (targetParamId) break;
      }

      // Fallback: direct search in test_parameters table
      if (!targetParamId) {
        const { data: param } = await supabase
          .from('test_parameters')
          .select('id')
          .or(`name.ilike.%${res.testCode}%,name.ilike.%${res.testName}%`)
          .limit(1)
          .maybeSingle();
        targetParamId = param?.id;
      }

      if (!targetParamId) {
        log('[UNMAPPED]', `${C.yellow}Assay '${res.testCode}' not mapped in order parameters${C.reset}`);
        continue;
      }

      await supabase.from('results').upsert({
        order_id: order.id,
        parameter_id: targetParamId,
        result_value: String(res.resultValue),
        status_flag: 'AUTOMATED',
        analyzer_source: 'MAGLUMI_X3'
      }, { onConflict: 'order_id,parameter_id' });

      log('[SAVED]', `${C.green}Synced to Supabase: ${res.testCode} = ${res.resultValue} ${res.unit} (Order: ${order.id})${C.reset}`);
    } catch (dbErr) {
      log('[DB-ERR]', `${C.red}${dbErr.message}${C.reset}`);
    }
  }
}

// 3. TCP Server with Keep-Alive
const server = net.createServer((socket) => {
  stats.clients++;
  socket.setKeepAlive(true, 10000);
  log('[LINK]', `${C.green}Maglumi X3 connected (${socket.remoteAddress})${C.reset}`);

  let rawBuffer = '';

  socket.on('data', async (chunk) => {
    const chunkStr = chunk.toString('ascii');
    rawBuffer += chunkStr;

    while (rawBuffer.includes(FS) || rawBuffer.includes(CR)) {
      let hl7Message = '';
      if (rawBuffer.includes(FS)) {
        const startIndex = rawBuffer.indexOf(VT);
        const endIndex = rawBuffer.indexOf(FS);

        if (startIndex !== -1 && startIndex < endIndex) {
          hl7Message = rawBuffer.substring(startIndex + 1, endIndex);
        } else {
          hl7Message = rawBuffer.substring(0, endIndex);
        }

        rawBuffer = rawBuffer.substring(endIndex + 1);
        if (rawBuffer.startsWith(CR)) rawBuffer = rawBuffer.substring(1);
        if (rawBuffer.startsWith(LF)) rawBuffer = rawBuffer.substring(1);
      } else {
        const lineEnd = rawBuffer.indexOf(CR);
        if (lineEnd === -1) break;
        hl7Message = rawBuffer.substring(0, lineEnd);
        rawBuffer = rawBuffer.substring(lineEnd + 1);
      }

      const segments = hl7Message.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
      if (segments.length === 0) continue;

      const mshSegment = segments.find(s => s.startsWith('MSH')) || segments[0];
      const mshParts = mshSegment.split('|');
      const messageType = mshParts[8] || '';

      try {
        if (messageType.includes('TSREQ') || messageType.includes('QRY') || segments.some(s => s.startsWith('QPD'))) {
          const qSeg = segments.find(s => s.startsWith('QPD')) || '';
          await handleHl7Query(qSeg, mshSegment, socket, segments);
        } else if (messageType.includes('OUL') || messageType.includes('ORU') || segments.some(s => s.startsWith('OBX'))) {
          await handleHl7Results(segments, mshSegment, socket);
        } else {
          socket.write(wrapMllp(makeHl7Ack(mshSegment, 'AA', 'Heartbeat OK')));
        }
      } catch (handlerErr) {
        log('[ERROR]', `${C.red}${handlerErr.message}${C.reset}`);
      }
    }
  });

  socket.on('close', () => {
    stats.clients = Math.max(0, stats.clients - 1);
    rawBuffer = '';
    log('[UNLINK]', `${C.yellow}Maglumi X3 disconnected${C.reset}`);
  });

  socket.on('error', (err) => {
    log('[ERROR]', `${C.red}Socket error: ${err.message}${C.reset}`);
  });
});

const port = parseInt(process.env.MAGLUMI_PORT || '5003', 10);
server.listen(port, '0.0.0.0', () => {
  log('[INIT]', `Listening on TCP Port ${port}...`);
});