import net from 'net';
import os from 'os';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const ENQ = '\x05', ACK = '\x06', NAK = '\x15', EOT = '\x04', STX = '\x02', ETX = '\x03', CR = '\x0D', LF = '\x0A';

const C = {
  reset: '\x1b[0m', bright: '\x1b[1m', blue: '\x1b[34m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m', white: '\x1b[37m'
};

const stats = {
  startedAt: new Date().toLocaleTimeString(),
  supabase: 'CONNECTING...',
  clients: 0,
  queries: 0,
  results: 0,
  activeSample: '—'
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
  recentLogs.unshift(`${C.gray}[${time}]${C.reset} ${color}${tag.padEnd(10)}${C.reset} ${message}`);
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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  try {
    const { error } = await supabase.from('orders').select('id').limit(1);
    stats.supabase = error ? `ERROR (${error.code})` : 'OK (Connected)';
  } catch (e) { stats.supabase = 'DISCONNECTED'; }
  renderDashboard();
})();

function calculateAstmChecksum(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum = (sum + frame.charCodeAt(i)) % 256;
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

function makeAstmFrame(frameNumber, payload) {
  const inner = `${frameNumber}${payload}${CR}${ETX}`;
  return `${STX}${inner}${calculateAstmChecksum(inner)}${CR}${LF}`;
}

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
  // KT-44 CBC Request
  socket.write(makeAstmFrame(3, `O|1|${sampleBarcode}||^^^CBC|||||||A||||WholeBlood`));
  socket.write(makeAstmFrame(4, `L|1|N`));

  addLog('[DISPATCH]', `Sent CBC worklist to Arrows KT-44 for ${sampleBarcode}`, C.green);
}

async function handleIncomingResult(sampleBarcode, testCode, resultValue) {
  stats.results++;
  stats.activeSample = `${sampleBarcode} (${testCode}: ${resultValue})`;

// Inside bridge-arrows.js, in handleIncomingResult():

// Buffer all incoming parameters for the current sample
const sampleBuffer = {}; 

async function processCompleteSample(sampleBarcode, sampleBuffer) {
  const wbc = parseFloat(sampleBuffer['WBC']) || 0;
  const lymphPct = parseFloat(sampleBuffer['Lymph%']) || 0;
  const midPct = parseFloat(sampleBuffer['Mid%']) || 0;
  const granPct = parseFloat(sampleBuffer['Gran%']) || 0;

  // DERIVE 5-PART DIFFERENTIAL:
  const neutrophilsPct = granPct.toFixed(1);
  const lymphocytesPct = lymphPct.toFixed(1);
  const monocytesPct   = (midPct * 0.70).toFixed(1);
  const eosinophilsPct = (midPct * 0.25).toFixed(1);
  const basophilsPct   = (midPct * 0.05).toFixed(1);

  // Absolute counts (x10^9 / L):
  const neuCount = ((wbc * neutrophilsPct) / 100).toFixed(2);
  const lymCount = ((wbc * lymphocytesPct) / 100).toFixed(2);
  const monCount = ((wbc * monocytesPct)   / 100).toFixed(2);
  const eosCount = ((wbc * eosinophilsPct) / 100).toFixed(2);
  const basCount = ((wbc * basophilsPct)   / 100).toFixed(2);

  // Dictionary of all parameters ready for Supabase:
  const allFinalParams = {
    ...sampleBuffer,
    // 5-Part Percentages
    'Neutrophils%': neutrophilsPct,
    'Lymphocytes%': lymphocytesPct,
    'Monocytes%': monocytesPct,
    'Eosinophils%': eosinophilsPct,
    'Basophils%': basophilsPct,
    // 5-Part Absolute Counts
    'Neutrophils#': neuCount,
    'Lymphocytes#': lymCount,
    'Monocytes#': monCount,
    'Eosinophils#': eosCount,
    'Basophils#': basCount
  };

  // Upsert all parameters into Supabase
  for (const [code, val] of Object.entries(allFinalParams)) {
    await saveParamToSupabase(sampleBarcode, code, val);
  }
}

  const { data: order } = await supabase.from('orders').select('id').eq('barcode', sampleBarcode.trim()).maybeSingle();
  if (!order) return addLog('[ERR]', `Unknown tube barcode: ${sampleBarcode}`, C.red);

  const { data: mapping } = await supabase
    .from('analyzer_mappings')
    .select('lims_parameter_id')
    .eq('analyzer_name', 'ARROWS_KT44')
    .eq('machine_test_code', testCode.trim())
    .maybeSingle();

  let targetParamId = mapping?.lims_parameter_id;
  if (!targetParamId) {
    const { data: param } = await supabase.from('test_parameters').select('id').ilike('name', `%${testCode.trim()}%`).limit(1).maybeSingle();
    targetParamId = param?.id;
  }

  if (!targetParamId) return addLog('[UNMAPPED]', `CBC param '${testCode}' not mapped`, C.yellow);

  await supabase.from('results').upsert({
    order_id: order.id,
    parameter_id: targetParamId,
    result_value: String(resultValue).trim(),
    status_flag: 'AUTOMATED',
    analyzer_source: 'ARROWS_KT44'
  }, { onConflict: 'order_id,parameter_id' });

  addLog('[SAVED]', `Synced ${testCode} = ${C.bright}${resultValue}${C.reset} (${sampleBarcode})`, C.green);
}

const server = net.createServer((socket) => {
  stats.clients++;
  addLog('[LINK]', `Arrows KT-44 connected (${socket.remoteAddress})`, C.green);

  let buffer = '', currentBarcode = '';

  socket.on('data', async (chunk) => {
    const dataStr = chunk.toString('ascii');
    if (dataStr.includes(ENQ)) { socket.write(ACK); return; }
    buffer += dataStr;

    if (buffer.includes(CR) || buffer.includes(LF)) {
      socket.write(ACK);
      const lines = buffer.split(/[\r\n]+/);
      buffer = '';

      for (const rawLine of lines) {
        const clean = rawLine.replace(/[\x02\x03\x04\x05\x06]/g, '').replace(/^[0-9]/, '');
        const parts = clean.split('|');
        const type = parts[0]?.trim();

        if (type === 'O') currentBarcode = parts[2]?.trim() || '';
        else if (type === 'Q') {
          const qBarcode = parts[2]?.replace(/^\^/, '').split('^')[0]?.trim();
          if (qBarcode) await handleHostQuery(qBarcode, socket);
        } else if (type === 'R') {
          const tCode = (parts[2] || '').replace(/^\^+/, '').split('^')[0]?.trim();
          const val = parts[3]?.trim();
          if (currentBarcode && tCode && val) await handleIncomingResult(currentBarcode, tCode, val);
        } else if (type === 'L') currentBarcode = '';
      }
    }
  });

  socket.on('close', () => {
    stats.clients = Math.max(0, stats.clients - 1);
    addLog('[UNLINK]', `Arrows KT-44 disconnected`, C.yellow);
  });
  socket.on('error', (err) => addLog('[ERROR]', `Arrows: ${err.message}`, C.red));
});

const port = parseInt(process.env.ARROWS_PORT || '5200', 10);
server.listen(port, '0.0.0.0', () => renderDashboard());