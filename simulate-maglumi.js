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
console.log('================================================================');
console.log(`Connecting to Apex LIS Bridge on ${HOST}:${PORT}...`);

const client = new net.Socket();

client.connect(PORT, HOST, () => {
  console.log('>>> CONNECTED to LIS Bridge! Machine is now Online.');
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

      // Parse auto-selected assays
      const assays = [];
      lines.forEach(l => {
        if (l.startsWith('OBR')) {
          const parts = l.split('|');
          const testField = parts[4] || '';
          const code = testField.split('^')[0] || testField;
          if (code) assays.push(code);
        } else if (l.startsWith('DSP') && parseInt(l.split('|')[1]) >= 8) {
          const testCode = l.split('|')[3];
          if (testCode) assays.push(testCode);
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
  console.log('1. Test Query Worklist (Auto-select assays for a Barcode)');
  console.log('2. Send Test Result to LIS (Simulate completed FT3 II test)');
  console.log('3. Send Custom Test Result');
  console.log('4. Exit');
  console.log('----------------------------------------------------------------');
  rl.question('Select an option (1-4): ', (ans) => {
    if (ans === '1') {
      rl.question('Enter tube barcode (default: 202600091): ', (bc) => {
        const barcode = bc.trim() || '202600091';
        sendTestQuery(barcode);
      });
    } else if (ans === '2') {
      rl.question('Enter tube barcode (default: 202600091): ', (bc) => {
        const barcode = bc.trim() || '202600091';
        sendTestResult(barcode, 'FT3 II', '3.42', 'pg/mL', '1.8 - 4.2');
      });
    } else if (ans === '3') {
      rl.question('Barcode: ', (bc) => {
        rl.question('Test Code (e.g. TSH II, FT4 II): ', (code) => {
          rl.question('Result Value (e.g. 2.45): ', (val) => {
            rl.question('Unit (e.g. uIU/mL): ', (unit) => {
              sendTestResult(bc.trim(), code.trim(), val.trim(), unit.trim(), 'Normal');
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

// 1. Send the exact TSREQ query that Maglumi X3 transmits
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

// 2. Send the exact ORU^R01 result that Maglumi X3 transmits
function sendTestResult(barcode, testCode, value, unit, refRange) {
  const now = timestamp();
  const result = [
    `MSH|^~\\&|Maglumi X3|Snibe|Lis|ApexLIS|${now}||ORU^R01|${Date.now()}|P|2.3.1`,
    `PID|1||P-9686||Al amin||19990101|M`,
    `OBR|1|${barcode}|${barcode}||^^^${testCode}|||${now}`,
    `OBX|1|NM|${testCode}^${testCode}||${value}|${unit}|${refRange}|N|||F`
  ].join(CR);

  console.log(`\n>>> [SENDING RESULT TO LIS: ${testCode} = ${value} ${unit} (Tube: ${barcode})]...`);
  client.write(wrapMllp(result));
}