import net from 'net';
import readline from 'readline';

const VT = '\x0B';
const FS = '\x1C';
const CR = '\x0D';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const PORT = 5003;
const HOST = '127.0.0.1';

function wrapMllp(hl7Text) {
  return `${VT}${hl7Text}${FS}${CR}`;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

console.log('================================================================');
console.log('       VIRTUAL SNIBE MAGLUMI X3 ANALYZER (SIMULATOR)           ');
console.log('           Multi-Assay Profile & OUL^R22 Transmission          ');
console.log('================================================================');
console.log(`Connecting to Apex LIS Bridge on ${HOST}:${PORT}...`);

const client = new net.Socket();

client.connect(PORT, HOST, () => {
  console.log('>>> CONNECTED to LIS Bridge! Virtual Maglumi X3 Online.');
  showMenu();
});

let buffer = '';
client.on('data', (chunk) => {
  buffer += chunk.toString('ascii');
  while (buffer.includes(FS)) {
    const start = buffer.indexOf(VT);
    const end = buffer.indexOf(FS);
    if (end !== -1) {
      const msg = start !== -1 && start < end ? buffer.substring(start + 1, end) : buffer.substring(0, end);
      buffer = buffer.substring(end + 1);

      console.log('\n<<< [MAGLUMI RECEIVED FROM LIS]:');
      const lines = msg.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
      lines.forEach(line => console.log('   ' + line));

      // Parse auto-selected assays from official OML^O33 or OBR
      const assays = [];
      lines.forEach(l => {
        if (l.startsWith('OBR')) {
          const parts = l.split('|');
          const testField = parts[4] || '';
          const code = testField.split('^')[0] || testField;
          if (code && !assays.includes(code)) assays.push(code);
        }
      });

      if (assays.length > 0) {
        console.log(`\n*** SUCCESS! Maglumi auto-selected ${assays.length} assay(s): [ ${assays.join(', ')} ] ***\n`);
      }

      showMenu();
    }
  }
});

client.on('error', (err) => {
  console.log(`Connection error: ${err.message}`);
  console.log('Make sure Start-Maglumi-X3.bat is running first!');
  process.exit(1);
});

client.on('close', () => {
  console.log('Connection closed by LIS Bridge.');
  process.exit(0);
});

function showMenu() {
  console.log('----------------------------------------------------------------');
  console.log('1. Query Worklist (Auto-Select Assays for a Barcode)');
  console.log('2. Send Complete Thyroid Profile Results (TSH + FT3 + FT4)');
  console.log('3. Send Complete Fertility Profile Results (FSH + LH + PRL)');
  console.log('4. Send Single Custom Test Result');
  console.log('5. Exit');
  console.log('----------------------------------------------------------------');
  rl.question('Select an option (1-5): ', (ans) => {
    if (ans === '1') {
      rl.question('Enter tube barcode (e.g. 202600090): ', (bc) => {
        const barcode = bc.trim() || '202600090';
        sendTestQuery(barcode);
      });
    } else if (ans === '2') {
      rl.question('Enter tube barcode (e.g. 202600090): ', (bc) => {
        const barcode = bc.trim() || '202600090';
        sendProfileResults(barcode, [
          { code: 'TSH', name: 'TSH', value: '1.85', unit: 'uIU/mL', range: '0.40 - 4.20' },
          { code: 'FT3', name: 'FT3 II', value: '3.20', unit: 'pg/mL', range: '2.00 - 4.40' },
          { code: 'FT4', name: 'FT4 II', value: '1.25', unit: 'ng/dL', range: '0.93 - 1.70' }
        ]);
      });
    } else if (ans === '3') {
      rl.question('Enter tube barcode: ', (bc) => {
        const barcode = bc.trim() || '202600090';
        sendProfileResults(barcode, [
          { code: 'FSH', name: 'FSH II', value: '6.40', unit: 'mIU/mL', range: '1.50 - 12.4' },
          { code: 'LH', name: 'LH II', value: '4.80', unit: 'mIU/mL', range: '1.70 - 8.60' },
          { code: 'PRL', name: 'PRL II', value: '14.2', unit: 'ng/mL', range: '4.80 - 23.3' }
        ]);
      });
    } else if (ans === '4') {
      rl.question('Barcode: ', (bc) => {
        rl.question('Test Code (e.g. FT3 II, TSH II): ', (code) => {
          rl.question('Result Value (e.g. 2.45): ', (val) => {
            rl.question('Unit (e.g. uIU/mL): ', (unit) => {
              sendProfileResults(bc.trim(), [
                { code: code.trim(), name: code.trim(), value: val.trim(), unit: unit.trim(), range: 'Normal' }
              ]);
            });
          });
        });
      });
    } else {
      client.destroy();
      process.exit(0);
    }
  });
}

// 1. Send the exact TSREQ query that Maglumi X3 transmits (Page B-19 Section 1.3.5.2)
function sendTestQuery(barcode) {
  const now = timestamp();
  const query = [
    `MSH|^~\\&|Maglumi X3||Lis||${now}||TSREQ|1|P|2.5|||NE|NE||UTF-8`,
    `QPD|TSREQ||${barcode}^^NA001^1|0`,
    `RCP|I||R`
  ].join(CR);

  console.log(`\n>>> [SENDING TSREQ QUERY TO LIS FOR BARCODE ${barcode}]...`);
  client.write(wrapMllp(query));
}

// 2. Send multi-assay profile results using official Snibe OUL^R22 (Page B-20 Section 1.3.5.3)
function sendProfileResults(barcode, assays = []) {
  const now = timestamp();

  const msh = `MSH|^~\\&|Maglumi X3||Lis||${now}||OUL^R22|${Date.now()}|P|2.5|||NE|NE||UTF-8`;
  const spm = `SPM|1|${barcode}^^^NA001^1||0|||||||P||||||||`;
  const orc = `ORC|NW||||||0||${now}|||`;

  // Build sequential OBR and OBX segments for all assays in the profile
  const testSegments = [];
  assays.forEach((a, idx) => {
    testSegments.push(`OBR|${idx + 1}|||${a.code}`);
    testSegments.push(`OBX|1||${a.code}||${a.value}|${a.unit}|${a.range}|N|||F|||${now}||||Module1^Maglumi|${now}|0|0`);
  });

  const fullOul = [msh, spm, orc, ...testSegments, 'NTE|1'].join(CR);

  console.log(`\n>>> [SENDING PROFILE RESULTS VIA OUL^R22 (${assays.length} assays) FOR TUBE ${barcode}]...`);
  assays.forEach(a => console.log(`    - ${a.name} = ${a.value} ${a.unit}`));

  client.write(wrapMllp(fullOul));
}