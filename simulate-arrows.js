// ============================================================
// VIRTUAL ARROWS KT-44 HEMATOLOGY ANALYZER (SIMULATOR)
// Talks ASTM E1394 to the LIS bridge on TCP 5200
// ============================================================

import net from 'net';
import readline from 'readline';

const ENQ = '\x05', ACK = '\x06', NAK = '\x15', EOT = '\x04';
const STX = '\x02', ETX = '\x03', CR = '\x0D', LF = '\x0A';

const PORT = 5200;
const HOST = '127.0.0.1';

// ============================================================
// ASTM frame helpers (mirror the bridge)
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
// Pretty console
// ============================================================
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  blue: '\x1b[94m', green: '\x1b[92m', yellow: '\x1b[93m',
  red: '\x1b[91m', cyan: '\x1b[96m', magenta: '\x1b[95m',
  gray: '\x1b[90m', white: '\x1b[97m',
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// ============================================================
// Connect to the bridge
// ============================================================
const client = new net.Socket();
let rxBuffer = '';
let currentBarcode = '';

console.log(`${C.magenta}${C.bold}
╔══════════════════════════════════════════════════════════════════════╗
║         VIRTUAL ARROWS KT-44 HEMATOLOGY ANALYZER (SIMULATOR)         ║
║              ASTM E1394 over TCP — Port 5200                          ║
╚══════════════════════════════════════════════════════════════════════╝${C.reset}
`);

console.log(`Connecting to Apex LIS Bridge at ${C.yellow}${HOST}:${PORT}${C.reset}...`);

client.connect(PORT, HOST, () => {
  console.log(`${C.green}>>> CONNECTED. Virtual KT-44 online.${C.reset}\n`);
  showMenu();
});

client.on('error', (err) => {
  console.log(`${C.red}Connection error: ${err.message}${C.reset}`);
  console.log(`Make sure the Arrows KT-44 bridge is running (KT44 LIS Bridge.lnk).`);
  process.exit(1);
});

client.on('close', () => {
  console.log(`${C.yellow}Bridge closed the connection.${C.reset}`);
  process.exit(0);
});

// ============================================================
// Incoming data — extract ASTM records and print them
// ============================================================
client.on('data', (chunk) => {
  rxBuffer += chunk.toString('ascii');

  // Ignore bare ACK bytes
  rxBuffer = rxBuffer.replace(/[\x05\x06\x15\x04]/g, '');

  const { records, remaining } = extractRecords(rxBuffer);
  rxBuffer = remaining;

  if (records.length === 0) return;

  console.log(`\n${C.blue}<<< FROM LIS BRIDGE:${C.reset}`);
  for (const rec of records) {
    const type = rec.split('|')[0];
    const label =
      type === 'H' ? 'HEADER' :
      type === 'P' ? 'PATIENT' :
      type === 'O' ? 'ORDER' :
      type === 'L' ? 'TERMINATOR' : type;
    console.log(`   ${C.cyan}${label.padEnd(12)}${C.reset} ${rec}`);
  }

  // If it was a worklist reply (contains an O record), show summary
  const hasO = records.some(r => r.startsWith('O'));
  if (hasO) {
    console.log(`\n${C.green}*** Worklist received. Bridge acknowledged our barcode. ***${C.reset}`);
    console.log(`    (Next: pick menu option 2 to send back CBC results.)\n`);
  }

  setTimeout(showMenu, 100);
});

// ============================================================
// ASTM frame extractor (handles multiple frames per TCP packet)
// ============================================================
function extractRecords(buffer) {
  const records = [];
  let pos = 0;
  while (true) {
    const stxIdx = buffer.indexOf(STX, pos);
    if (stxIdx === -1) break;
    const etxIdx = buffer.indexOf(ETX, stxIdx);
    if (etxIdx === -1) break;

    let payload = buffer.substring(stxIdx + 1, etxIdx).replace(/\r$/, '');
    payload = payload.replace(/^\d+/, ''); // strip leading frame number

    if (payload.trim()) records.push(payload);

    // Skip past ETX + 2-char checksum + CR + LF
    pos = etxIdx + 3;
    while (pos < buffer.length && (buffer[pos] === CR || buffer[pos] === LF)) pos++;
  }
  return { records, remaining: buffer.substring(pos) };
}

// ============================================================
// CBC test values — realistic sample data
// ============================================================
const DEFAULT_CBC = [
  { code: 'WBC',     value: '6.5',  unit: '10^3/uL' },
  { code: 'RBC',     value: '4.85', unit: '10^6/uL' },
  { code: 'HGB',     value: '13.8', unit: 'g/dL'    },
  { code: 'HCT',     value: '41.2', unit: '%'       },
  { code: 'MCV',     value: '85.0', unit: 'fL'      },
  { code: 'MCH',     value: '28.4', unit: 'pg'      },
  { code: 'MCHC',    value: '33.5', unit: 'g/dL'    },
  { code: 'RDW-CV',  value: '13.2', unit: '%'       },
  { code: 'RDW-SD',  value: '42.1', unit: 'fL'      },
  { code: 'PLT',     value: '245',  unit: '10^3/uL' },
  { code: 'MPV',     value: '9.8',  unit: 'fL'      },
  { code: 'PDW',     value: '14.5', unit: '%'       },
  { code: 'Gran%',   value: '58.0', unit: '%'       },
  { code: 'Lymph%',  value: '33.0', unit: '%'       },
  { code: 'Mid%',    value: '9.0',  unit: '%'       },
];

// ============================================================
// Menu
// ============================================================
function showMenu() {
  console.log(`${C.magenta}────────────────────────────────────────────────────────────────────${C.reset}`);
  console.log(`  ${C.bold}Virtual KT-44 Menu${C.reset}`);
  console.log(`${C.magenta}────────────────────────────────────────────────────────────────────${C.reset}`);
  console.log(`  ${C.yellow}1${C.reset}. Send host query (ask for worklist for a barcode)`);
  console.log(`  ${C.yellow}2${C.reset}. Send full CBC result set (with default values)`);
  console.log(`  ${C.yellow}3${C.reset}. Send full CBC result set (custom values per param)`);
  console.log(`  ${C.yellow}4${C.reset}. Send ONE custom R record (debug)`);
  console.log(`  ${C.yellow}5${C.reset}. Full realistic flow (query → wait → results)`);
  console.log(`  ${C.yellow}6${C.reset}. Exit`);
  console.log(`${C.magenta}────────────────────────────────────────────────────────────────────${C.reset}`);
  rl.question(`Select (1-6): `, handleMenuChoice);
}

function handleMenuChoice(ans) {
  switch (ans.trim()) {
    case '1':
      rl.question(`Enter tube barcode: `, (bc) => {
        currentBarcode = (bc || '').trim() || '2026000151';
        sendHostQuery(currentBarcode);
        setTimeout(showMenu, 500);
      });
      break;

    case '2':
      rl.question(`Enter tube barcode: `, (bc) => {
        currentBarcode = (bc || '').trim() || '2026000151';
        sendCbcResults(currentBarcode, DEFAULT_CBC);
        setTimeout(showMenu, 500);
      });
      break;

    case '3': {
      rl.question(`Enter tube barcode: `, (bc) => {
        currentBarcode = (bc || '').trim() || '2026000151';
        collectCustomCbc([]);
      });
      break;
    }

    case '4':
      rl.question(`Barcode: `, (bc) => {
        const b = (bc || '').trim() || currentBarcode || '2026000151';
        rl.question(`Test code (e.g. WBC, Gran%, Lymph%, Mid%): `, (code) => {
          rl.question(`Value: `, (val) => {
            sendSingleResult(b, code.trim(), val.trim());
            setTimeout(showMenu, 500);
          });
        });
      });
      break;

    case '5':
      rl.question(`Enter tube barcode: `, (bc) => {
        currentBarcode = (bc || '').trim() || '2026000151';
        runFullRealisticFlow(currentBarcode);
      });
      break;

    case '6':
      console.log(`${C.gray}Disconnecting...${C.reset}`);
      client.destroy();
      process.exit(0);
      break;

    default:
      console.log(`${C.red}Invalid option.${C.reset}`);
      showMenu();
  }
}

// ============================================================
// Session helpers
// ============================================================
function beginSession(barcode) {
  // ASTM: ENQ → (wait for ACK) → H header → (wait for ACK) → records
  client.write(ENQ);
  setTimeout(() => {
    client.write(makeAstmFrame(1, `H|\\^&|||ArrowsKT44|||||||P|1`));
  }, 60);
  setTimeout(() => {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    client.write(makeAstmFrame(2, `P|1||P-SIM||Simulated Patient||35|M|||${ts}`));
  }, 120);
}

function endSession() {
  setTimeout(() => {
    client.write(makeAstmFrame(999, `L|1|N`));
    setTimeout(() => client.write(EOT), 80);
  }, 120);
}

// ============================================================
// Action: Host query
// ============================================================
function sendHostQuery(barcode) {
  console.log(`\n${C.yellow}>>> Sending host query for barcode ${C.bold}${barcode}${C.reset}`);
  beginSession(barcode);
  setTimeout(() => {
    client.write(makeAstmFrame(3, `Q|1|^${barcode}||ALL||||||||X`));
  }, 200);
}

// ============================================================
// Action: Send CBC results
// ============================================================
function sendCbcResults(barcode, params) {
  console.log(`\n${C.yellow}>>> Sending CBC results for barcode ${C.bold}${barcode}${C.reset}`);
  console.log(`    ${params.length} parameters to transmit\n`);

  beginSession(barcode);

  setTimeout(() => {
    // Order record first — tells the bridge which barcode we're reporting for
    client.write(makeAstmFrame(3, `O|1|${barcode}||^^^CBC|||||||F||||WholeBlood`));
  }, 180);

  // Then each parameter as its own R record
  let frameNum = 4;
  params.forEach((p, idx) => {
    setTimeout(() => {
      const rRec = `R|${idx + 1}|^^^${p.code}|${p.value}|${p.unit || ''}|Normal|N||F|||${new Date().toISOString()}`;
      client.write(makeAstmFrame(frameNum++, rRec));
      console.log(`    ${C.gray}→ R|^^^${p.code} = ${p.value}${C.reset}`);
    }, 250 + idx * 60);
  });

  // Terminator — this triggers flushSample() on the bridge
  setTimeout(() => {
    console.log(`\n${C.gray}>>> Sending terminator (L)...${C.reset}`);
    endSession();
    console.log(`${C.green}    Expect [FLUSH] line on the bridge console shortly.${C.reset}\n`);
  }, 250 + params.length * 60 + 100);
}

// ============================================================
// Action: custom CBC values (menu option 3)
// ============================================================
function collectCustomCbc(entered) {
  const remaining = DEFAULT_CBC.slice(entered.length);
  if (remaining.length === 0) {
    sendCbcResults(currentBarcode, entered);
    return;
  }
  const next = remaining[0];
  const def = next.value;
  rl.question(`  ${next.code} (default ${def}): `, (val) => {
    const v = (val || '').trim() || def;
    const updated = [...entered, { ...next, value: v }];
    collectCustomCbc(updated);
  });
}

// ============================================================
// Action: single R record (debug)
// ============================================================
function sendSingleResult(barcode, code, val) {
  console.log(`\n${C.yellow}>>> Sending single R for ${code} = ${val} on ${barcode}${C.reset}`);
  beginSession(barcode);
  setTimeout(() => {
    client.write(makeAstmFrame(3, `O|1|${barcode}||^^^CBC|||||||F||||WholeBlood`));
  }, 180);
  setTimeout(() => {
    const rRec = `R|1|^^^${code}|${val}|||N||F`;
    client.write(makeAstmFrame(4, rRec));
  }, 260);
  endSession();
}

// ============================================================
// Action: full realistic flow (query → pause → results)
// ============================================================
function runFullRealisticFlow(barcode) {
  console.log(`\n${C.magenta}${C.bold}=== REALISTIC FLOW: ${barcode} ===${C.reset}\n`);
  console.log(`${C.gray}Step 1/3: Sending host query...${C.reset}`);
  sendHostQuery(barcode);

  // Wait 3 seconds for the bridge's reply to arrive, then send results
  setTimeout(() => {
    console.log(`\n${C.gray}Step 2/3: Analyzer accepted worklist, running sample...${C.reset}`);
  }, 1500);

  setTimeout(() => {
    console.log(`\n${C.gray}Step 3/3: Transmitting results...${C.reset}`);
    sendCbcResults(barcode, DEFAULT_CBC);
  }, 3000);
}