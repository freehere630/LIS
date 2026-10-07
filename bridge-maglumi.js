import net from 'net';
import os from 'os';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

// MLLP Framing Bytes
const VT = '\x0B'; // 0x0B
const FS = '\x1C'; // 0x1C
const CR = '\x0D'; // 0x0D
const LF = '\x0A';

// App-Like Modern Color Palette
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
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

function renderAppHeader() {
  console.log(`
${C.magenta}${C.bold}╔══════════════════════════════════════════════════════════════════════════════════════╗
║               APEX LIS BRIDGE — SNIBE MAGLUMI X3 (CLIA / IMMUNOASSAY)                ║
║                 Bidirectional HL7 v2.5 TSREQ/TSRES Interface Console                 ║
╚══════════════════════════════════════════════════════════════════════════════════╝${C.reset}

${C.cyan}╭─── SYSTEM TELEMETRY ─────────────────────────────────────────────────────────────────╮${C.reset}
${C.cyan}│${C.reset}  ${C.white}Local Server IP :${C.reset} ${C.yellow}${C.bold}${getLocalIp()}${C.reset} (Port: ${C.yellow}${process.env.MAGLUMI_PORT || 5003}${C.reset})
${C.cyan}│${C.reset}  ${C.white}Protocol Stream :${C.reset} ${C.green}HL7 v2.5 MLLP (<VT>...<FS><CR>)${C.reset}
${C.cyan}│${C.reset}  ${C.white}Maglumi Link    :${C.reset} ${stats.clients > 0 ? `${C.green}${C.bold}● CONNECTED & ONLINE${C.reset}` : `${C.yellow}○ LISTENING (Awaiting Analyzer)${C.reset}`}
${C.cyan}│${C.reset}  ${C.white}Supabase Cloud  :${C.reset} ${stats.supabase.includes('OK') ? `${C.green}${C.bold}● LIVE CLOUD ACTIVE${C.reset}` : `${C.yellow}● ${stats.supabase}${C.reset}`}
${C.cyan}╰──────────────────────────────────────────────────────────────────────────────────────╯${C.reset}
`);
}

renderAppHeader();

// Connect to Supabase Cloud
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

// Generate Standard HL7 Acknowledgement (ACK)
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

// Clean barcode helper
function cleanBarcodeString(raw) {
  if (!raw) return '';
  const firstToken = String(raw).split('^')[0].trim();
  const match = firstToken.match(/^(202\d{6,8}|\d{6,14}|[A-Za-z0-9_-]+)/);
  return match ? match[1] : firstToken;
}

// Extract true tube barcode prioritizing OBR over PID
function extractTubeBarcode(hl7Segments = []) {
  const obrSeg = hl7Segments.find(s => s.startsWith('OBR'));
  if (obrSeg) {
    const parts = obrSeg.split('|');
    const val = cleanBarcodeString(parts[2] || parts[3]);
    if (val && val !== '1' && val !== '0') return val;
  }

  const orcSeg = hl7Segments.find(s => s.startsWith('ORC'));
  if (orcSeg) {
    const parts = orcSeg.split('|');
    const val = cleanBarcodeString(parts[2] || parts[3]);
    if (val && val !== '1' && val !== '0') return val;
  }

  const pidSeg = hl7Segments.find(s => s.startsWith('PID'));
  if (pidSeg) {
    const parts = pidSeg.split('|');
    const val = cleanBarcodeString(parts[3] || parts[2] || parts[4]);
    if (val) return val;
  }

  return '';
}

// 1. BIDIRECTIONAL HOST QUERY: AUTO-DOWNLOAD TEST ASSAYS TO MAGLUMI X3
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
${C.yellow}╭─── INCOMING HOST QUERY ──────────────────────────────────────────────╮${C.reset}
${C.yellow}│${C.reset}  Tube Barcode  : ${C.white}${C.bold}${sampleBarcode}${C.reset}
${C.yellow}│${C.reset}  Rack/Position : ${C.gray}${rackPos}${C.reset}
${C.yellow}╰──────────────────────────────────────────────────────────────────────╯${C.reset}
`);

  // 1. Check in-memory cache first (0ms latency & 0 API requests)
  let order = getCachedOrder(sampleBarcode);
  if (!order) {
    // 2. Query Supabase and cache result
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
    socket.write(Buffer.from(wrapMllp(makeHl7Ack(mshSegment, 'AE', `Barcode ${sampleBarcode} Not Found`)), 'utf8'));
    return;
  }

  // Fetch analyzer mappings if any
  const { data: mappings } = await supabase.from('analyzer_mappings').select('*').eq('analyzer_name', 'MAGLUMI_X3');
  const mappingMap = new Map();
  (mappings || []).forEach(m => mappingMap.set(m.lims_test_id, m.machine_test_code));

  const assayList = [];
  (order.order_tests || []).forEach(ot => {
    const testId = ot.test_id || ot.test?.id;
    let codeToUse = '';
    if (mappingMap.has(testId)) codeToUse = mappingMap.get(testId);
    else if (ot.test?.code) codeToUse = ot.test.code;
    else if (ot.test?.name) codeToUse = ot.test.name;

    if (codeToUse) {
      const trimmed = codeToUse.trim();
      if (!assayList.includes(trimmed)) assayList.push(trimmed);
      if (trimmed.toUpperCase().includes('FT3') && !assayList.includes('FT3 II')) assayList.push('FT3 II');
      if (trimmed.toUpperCase().includes('FT4') && !assayList.includes('FT4 II')) assayList.push('FT4 II');
      if (trimmed.toUpperCase().includes('TT3') && !assayList.includes('TT3 II')) assayList.push('TT3 II');
    }
  });

  const patient = order.patient || {};
  const gender = (patient.gender || '').toUpperCase().startsWith('F') ? 'F' : 'M';
  const patientName = (patient.name || 'Patient').replace(/[|^\\]/g, '');
  const patientId = String(patient.id || sampleBarcode);

  // EXACT SNIBE MAGLUMI X3 HL7 v2.5 TSRES RESPONSE:
  const respMsh = `MSH|^~\\&|${sendingApp}||${receivingApp}||${localNow}||TSRES|${incomingControlId}|P|2.5|||NE|NE||UTF-8`;
  const respMsa = `MSA|AA|${incomingControlId}|Success`;
  const respQak = `QAK|TSREQ|OK|TSREQ`;
  const exactQpd = allSegments.find(s => s.startsWith('QPD')) || `QPD|TSREQ||${rawBarcodeField}|0`;
  const respPid = `PID|1||${patientId}||${patientName}|||${gender}`;
  const respOrc = `ORC|NW|${sampleBarcode}|${rawBarcodeField}|||||||`;

  // OBR segments matching exact button names on Maglumi screen
  const obrSegments = assayList.map((testCode, idx) => 
    `OBR|${idx + 1}|${sampleBarcode}|${rawBarcodeField}|${testCode}^${testCode}||||||A||||Serum`
  ).join(CR);

  const fullResponse = `${respMsh}${CR}${respMsa}${CR}${respQak}${CR}${exactQpd}${CR}${respPid}${CR}${respOrc}${CR}${obrSegments}${CR}`;
  socket.write(Buffer.from(wrapMllp(fullResponse), 'utf8'));

  console.log(`
${C.green}╭─── WORKLIST DISPATCHED TO MAGLUMI ───────────────────────────────────╮${C.reset}
${C.green}│${C.reset}  Patient Name : ${C.white}${patientName} (${patientId})${C.reset}
${C.green}│${C.reset}  Auto-Selected: ${C.cyan}${C.bold}${assayList.join(', ')}${C.reset}
${C.green}│${C.reset}  Status       : ${C.green}✓ Assigned to Rack ${rackPos}${C.reset}
${C.green}╰──────────────────────────────────────────────────────────────────────╯${C.reset}
`);
}

// 2. RECEIVE TEST RESULTS (ORU^R01)
async function handleHl7Results(hl7Segments, mshSegment, socket) {
  socket.write(Buffer.from(wrapMllp(makeHl7Ack(mshSegment, 'AA', 'Results Accepted')), 'utf8'));

  // Extract true tube barcode prioritizing OBR over PID
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

    // COLORFUL RESULT CARD
    console.log(`
${C.magenta}╭─── MAGLUMI X3 TEST RESULT RECEIVED ──────────────────────────────────╮${C.reset}
${C.magenta}│${C.reset}  ${C.white}Tube Barcode${C.reset} : ${C.yellow}${C.bold}${sampleBarcode}${C.reset}
${C.magenta}│${C.reset}  ${C.white}Assay / Test${C.reset} : ${C.cyan}${C.bold}${res.testName} (${res.testCode})${C.reset}
${C.magenta}│${C.reset}  ${C.white}Result Value${C.reset} : ${C.green}${C.bold}${res.resultValue}${C.reset}
${C.magenta}│${C.reset}  ${C.white}Unit${C.reset}         : ${C.blue}${C.bold}${res.unit || '—'}${C.reset}
${C.magenta}│${C.reset}  ${C.white}Ref. Range${C.reset}   : ${C.gray}${res.refRange || 'Standard'}${C.reset}
${C.magenta}╰──────────────────────────────────────────────────────────────────────╯${C.reset}
`);

    try {
      let { data: order } = await supabase
        .from('orders')
        .select('id, qc_status, is_locked')
        .eq('barcode', sampleBarcode)
        .maybeSingle();

      if (!order) {
        const { data: patientOrder } = await supabase
          .from('orders')
          .select('id, qc_status, is_locked')
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

      // CLINICAL LOCK GUARD: Never overwrite verified & locked clinical reports!
      if (order.is_locked === true || order.qc_status === 'Verified') {
        console.log(`\n  ${C.yellow}${C.bold}⚠ [LOCKED] Order ${order.id} (${sampleBarcode}) is already VERIFIED & LOCKED!${C.reset}`);
        console.log(`  ${C.gray}Machine result ${res.testCode} = ${res.resultValue} discarded to protect signed report.${C.reset}\n`);
        log('[LOCKED]', `Order is verified/locked. Overwrite blocked (${sampleBarcode})`, C.yellow);
        continue;
      }

      // Check analyzer mappings
      const { data: mapping } = await supabase
        .from('analyzer_mappings')
        .select('lims_parameter_id')
        .eq('analyzer_name', 'MAGLUMI_X3')
        .eq('machine_test_code', res.testCode)
        .maybeSingle();

      let targetParamId = mapping?.lims_parameter_id;

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
        const { data: testItem } = await supabase
          .from('tests')
          .select('id')
          .or(`code.ilike.%${res.testCode}%,name.ilike.%${res.testCode}%`)
          .limit(1)
          .maybeSingle();
        targetParamId = testItem?.id;
      }

      if (!targetParamId) {
        log('[UNMAPPED]', `${C.yellow}Assay '${res.testCode}' not mapped in LIMS directory${C.reset}`);
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

// 3. TCP Server with Keep-Alive & Automatic Reconnection Protection
const server = net.createServer((socket) => {
  stats.clients++;
  socket.setKeepAlive(true, 10000); // Prevents socket freeze between tests!
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
        if (messageType.includes('TSREQ') || messageType.includes('QRY') || messageType.includes('QBP') || segments.some(s => s.startsWith('QPD') || s.startsWith('QRD'))) {
          const qSeg = segments.find(s => s.startsWith('QPD') || s.startsWith('QRD')) || '';
          await handleHl7Query(qSeg, mshSegment, socket, segments);
        } else if (messageType.includes('ORU') || segments.some(s => s.startsWith('OBX'))) {
          await handleHl7Results(segments, mshSegment, socket);
        } else {
          socket.write(Buffer.from(wrapMllp(makeHl7Ack(mshSegment, 'AA', 'Heartbeat OK')), 'utf8'));
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