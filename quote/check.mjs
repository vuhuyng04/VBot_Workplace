// Runs the exact validator embedded in vbot-capstone.html (/*VALIDATOR-START*/…/*VALIDATOR-END*/)
// against a quote XLSX. Usage: node check.mjs out/G03_baogia.xlsx
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const html = fs.readFileSync(path.join(here, '..', 'vbot-capstone.html'), 'utf8');
const m = html.match(/\/\*VALIDATOR-START\*\/([\s\S]*?)\/\*VALIDATOR-END\*\//);
if (!m) throw new Error('validator block not found in vbot-capstone.html');
const api = new Function(m[1] + '\nreturn {workbookToInput, validateQuote, REQUIRED_COMPONENTS};')();

const file = process.argv[2];
const wb = XLSX.read(fs.readFileSync(file), {type: 'buffer', cellNF: true});
const inp = api.workbookToInput(XLSX, wb);
const res = api.validateQuote(inp.rows, inp.evidenceIds);
const s = res.summary;
console.log(res.ok ? 'ĐẠT' : 'CHƯA ĐẠT', '·', res.errors.length, 'lỗi ·', res.warnings.length, 'cảnh báo');
if (s) console.log(`TOTAL ${s.total} · ${s.perDau.toFixed(2)} USD/DAU · ${s.rows} dòng · component bắt buộc ${api.REQUIRED_COMPONENTS.length - s.missingComponents.length}/${api.REQUIRED_COMPONENTS.length}`);
for (const e of res.errors) console.log(`  LỖI  dòng ${e.line || '-'} ${e.col}: ${e.msg}`);
for (const w of res.warnings) console.log(`  CẢNH BÁO dòng ${w.line || '-'} ${w.col}: ${w.msg}`);
process.exit(res.ok ? 0 : 1);
