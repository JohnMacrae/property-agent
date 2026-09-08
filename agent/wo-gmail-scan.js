#!/usr/bin/env node
// Deterministic work-order Gmail capture (no LLM) — searches Gmail for
// Rentopia work-order emails, parses the "Supplier Instructed" PDF, resolves
// the property shortcode, and writes an inbox item. Replaces mail-reader's
// work_order_processor.py (a separate Python container that HTTP-POSTed back
// into property-agent's own /inbox) with an in-process Node port, following
// the same shape as invoice-run.js: a deterministic run() the scheduler
// calls directly and reports on.
//
//   node wo-gmail-scan.js [--days 7] [--dry-run]

const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const gmail = require('./gmail');
const store = require('./store');
const wo = require('./wo');
const woScanNoise = require('./wo-scan-noise');

const WORK_ORDERS_DIR = process.env.WORK_ORDERS_DIR || '/output/work_orders';

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// dd/mm/yyyy -> yyyy-mm-dd, '' on no match (mirrors Python's parse_date)
function parseDate(dmy) {
  const m = String(dmy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// Email "Date" header, e.g. "Mon, 25 Aug 2026 07:18:57 +0100" -> yyyy-mm-dd.
// Mirrors Python's strptime on the first 16 chars ("%a, %d %b %Y").
function dateFromEmailHeader(dateHeader) {
  const m = String(dateHeader || '').match(/^\w+,\s*(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  if (!m) return '';
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return '';
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function orderNumberFromSubject(subject) {
  const m = String(subject || '').match(/Work Order[:\s]*(WO\d+)/i);
  return m ? m[1].toUpperCase() : '';
}

function pickPdfAttachment(attachments) {
  const pdfs = (attachments || []).filter((a) => (a.filename || '').toLowerCase().endsWith('.pdf'));
  if (!pdfs.length) return null;
  const preferred = pdfs.find((a) => a.filename.toLowerCase().includes('supplier instructed'));
  return preferred || pdfs[0];
}

function woPdfPath(orderNumber) {
  const safe = String(orderNumber || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!safe.startsWith('WO')) return null;
  return path.join(WORK_ORDERS_DIR, `${safe}.pdf`);
}

function saveWoPdf(orderNumber, buf) {
  const dest = woPdfPath(orderNumber);
  if (!dest) return false;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    return true;
  } catch {
    return false;
  }
}

// Line-prefix state machine, ported from work_order_processor.py's parse_pdf().
function parsePdfText(text) {
  const lines = String(text || '')
    .replace(/ /g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const result = {
    order_number: '', date: '', priority: '',
    property_lines: [], problem: '', description: '',
  };

  let inProperty = false;
  let inDescription = false;
  const propertyLines = [];
  const descLines = [];
  const postcodeEnd = /^CO\d|^CM\d|^IP\d|^[A-Z]{1,2}\d{1,2}[A-Z]?\s+\d[A-Z]{2}$/;

  for (const line of lines) {
    if (line.startsWith('Order Number')) {
      result.order_number = line.replace(/^Order Number/, '').trim();
      inProperty = false;
    } else if (/^Date\s+\d{2}\/\d{2}\/\d{4}/.test(line)) {
      const m = line.match(/\d{2}\/\d{2}\/\d{4}/);
      result.date = m ? m[0] : '';
      inProperty = false;
    } else if (line.startsWith('Priority')) {
      result.priority = line.replace(/^Priority/, '').trim();
      inProperty = false;
    } else if (line.startsWith('Property')) {
      inProperty = true;
      const val = line.replace(/^Property/, '').trim();
      if (val) propertyLines.push(val);
    } else if (line.startsWith('Contact for Access') || line.startsWith('Works Manager')) {
      inProperty = false;
    } else if (inProperty && !['Contact', 'Works', 'Billing'].some((k) => line.startsWith(k))) {
      propertyLines.push(line);
      if (postcodeEnd.test(line)) inProperty = false;
    } else if (line.startsWith('Problem reported')) {
      result.problem = line.replace(/^Problem reported/, '').trim();
      inProperty = false;
    } else if (line.startsWith('Description')) {
      inDescription = true;
      inProperty = false;
    } else if (inDescription) {
      if (line.startsWith('Please carry out') || line.startsWith('Works Manager')) {
        inDescription = false;
      } else {
        descLines.push(line);
      }
    }
  }

  result.property_lines = propertyLines;
  result.description = descLines.join(' ').trim() || result.problem;
  return result;
}

async function parsePdf(buf) {
  const parser = new PDFParse({ data: buf });
  const data = await parser.getText();
  return parsePdfText(data.text || '');
}

const QUERY_TEMPLATES = (searchDate) => [
  `subject:"work order" from:rentopia after:${searchDate}`,
  `subject:"work request" from:rentopia after:${searchDate}`,
  `from:rentopia after:${searchDate}`,
  `subject:"work order" after:${searchDate}`,
  `subject:"works order" after:${searchDate}`,
  `subject:"work request" after:${searchDate}`,
  `subject:"maintenance request" after:${searchDate}`,
  `"work order" has:attachment after:${searchDate}`,
];

async function run(opts = {}) {
  const days = opts.days != null ? Number(opts.days) : 7;
  const dryRun = !!opts.dryRun;
  const jjp = wo.loadJjp();

  const searchDateObj = new Date(Date.now() - days * 86400000);
  const searchDate = searchDateObj.toISOString().slice(0, 10).replace(/-/g, '/');
  const queries = QUERY_TEMPLATES(searchDate);

  const seen = new Set();
  const captured = [];
  const skipped = [];
  const newUrgent = [];
  let pdfsSaved = 0;

  for (const q of queries) {
    let msgs;
    try {
      msgs = await gmail.searchMessages(q, 50);
    } catch (e) {
      skipped.push({ reason: 'search_failed', query: q, error: e.message });
      continue;
    }

    for (const m of msgs) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);

      let detail;
      try {
        detail = await gmail.readMessage(m.id);
      } catch (e) {
        skipped.push({ reason: 'read_failed', id: m.id, error: e.message });
        continue;
      }

      const fromAddr = (detail.from || '').toLowerCase();
      const forwarded = fromAddr.includes('jramacrae@gmail.com') || fromAddr.includes('kk4oyj@gmail.com');

      const att = pickPdfAttachment(detail.attachments);
      if (!att) continue;

      let raw = null;
      let parsed;
      try {
        raw = await gmail.getAttachment(detail.id, att.attachment_id);
        parsed = await parsePdf(raw);
      } catch (e) {
        parsed = {
          order_number: '', date: '', priority: '', property_lines: [],
          problem: detail.subject || '', description: '',
        };
      }

      let orderNumber = parsed.order_number || orderNumberFromSubject(detail.subject);
      if (!orderNumber) {
        if (forwarded) {
          skipped.push({ reason: 'forwarded_no_wo', subject: detail.subject });
          continue;
        }
        orderNumber = `email-${m.id.slice(0, 8)}`;
      } else {
        orderNumber = orderNumber.toUpperCase();
      }

      if (raw && !dryRun && saveWoPdf(orderNumber, raw)) pdfsSaved++;

      let workDate = parseDate(parsed.date);
      if (!workDate) workDate = dateFromEmailHeader(detail.date) || todayStr();

      const shortcode = wo.resolveShortcode(parsed.property_lines, jjp);
      if (!shortcode) {
        // A real WO number (from the PDF or subject) or a parsed address line means
        // this is genuinely a work order whose address just didn't match a known
        // property — worth a human glance. A bare `email-*` fallback with no address
        // at all is just some other rentopia.uk PDF the broad search query swept up.
        const propertyRelated = /^WO\d+/i.test(orderNumber) || (parsed.property_lines || []).length > 0;
        skipped.push({
          reason: 'no_shortcode',
          property_lines: parsed.property_lines,
          order_number: orderNumber,
          subject: detail.subject || '',
          message_id: m.id,
          propertyRelated,
        });
        continue;
      }

      const priorityRaw = (parsed.priority || '').toLowerCase();
      const status = /emergency|urgent/.test(priorityRaw) ? 'urgent' : 'open';

      const noteText = (parsed.problem || parsed.description || 'No description').replace(/"/g, "'").slice(0, 200);
      const note = `${orderNumber}: ${noteText}`;

      let isDuplicate = false;
      if (!dryRun) {
        const record = await store.addInboxItem({
          property: shortcode,
          type: 'maintenance',
          status,
          note,
          date: workDate,
          order_number: orderNumber,
          source: 'wo-gmail-scan',
          priority: parsed.priority || '',
          problem: parsed.problem || '',
          description: parsed.description || '',
          address: (parsed.property_lines || []).join('\n'),
        });
        isDuplicate = !!record.duplicate;
        captured.push({ order_number: orderNumber, shortcode, status, duplicate: isDuplicate });
      } else {
        captured.push({ order_number: orderNumber, shortcode, status, dry_run: true });
      }

      // Only a genuinely new capture should re-trigger a property-check —
      // a repeat scan re-finding an already-known urgent WO (dedup'd by
      // order_number) must not fire the same alert/session every cycle.
      if (status === 'urgent' && !isDuplicate) newUrgent.push(`${orderNumber} at ${shortcode}`);
    }
  }

  // Noise (no WO number, no address at all) re-appears on every scan until
  // it ages out of the --days search window. Report each such email once —
  // see wo-scan-noise.js. Dry runs must not mark anything as seen, or a
  // later real run would silently swallow it.
  const noiseThisRun = skipped
    .filter((s) => s.reason === 'no_shortcode' && !s.propertyRelated)
    .map((s) => ({ message_id: s.message_id, subject: s.subject }));
  const otherNoiseNew = dryRun ? noiseThisRun : woScanNoise.filterUnseenAndMark(noiseThisRun);

  return {
    ok: true,
    dryRun,
    days,
    scanned: seen.size,
    captured,
    skipped,
    otherNoiseNew,
    pdfsSaved,
    newUrgent,
    urgentReason: newUrgent.length ? `Urgent work orders: ${newUrgent.join(', ')}` : null,
  };
}

function formatTelegramReport(result) {
  const lines = [];
  const real = result.captured.filter((c) => !c.duplicate);
  if (real.length) {
    lines.push(`Work orders captured (${real.length}):`);
    for (const c of real.slice(0, 20)) {
      lines.push(`• ${c.order_number} → ${c.shortcode}${c.status === 'urgent' ? ' 🔴' : ''}`);
    }
    if (real.length > 20) lines.push(`• …+${real.length - 20} more`);
  }
  const noShortcode = result.skipped.filter((s) => s.reason === 'no_shortcode');
  const propertyRelated = noShortcode.filter((s) => s.propertyRelated);
  if (propertyRelated.length) {
    lines.push(`⚠️ ${propertyRelated.length} WO(s) — no shortcode resolved, check manually:`);
    for (const s of propertyRelated.slice(0, 10)) {
      const addr = (s.property_lines || []).join(', ');
      lines.push(`• ${s.order_number}${addr ? ` — ${addr}` : ` — "${s.subject}"`}`);
    }
    if (propertyRelated.length > 10) lines.push(`• …+${propertyRelated.length - 10} more`);
  }
  const otherNoise = result.otherNoiseNew || [];
  if (otherNoise.length) {
    lines.push(`${otherNoise.length} other rentopia.uk PDF(s) ignored — not work orders:`);
    for (const n of otherNoise.slice(0, 10)) {
      const subject = (n.subject || '(no subject)').replace(/\s*\[ref:[^\]]*\]\s*$/i, '');
      lines.push(`• "${subject}"`);
    }
    if (otherNoise.length > 10) lines.push(`• …+${otherNoise.length - 10} more`);
  }
  if (!lines.length) return null;
  return lines.join('\n');
}

module.exports = { run, formatTelegramReport, parsePdfText, resolveShortcode: wo.resolveShortcode };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  run({
    days: args.days != null ? Number(args.days) : undefined,
    dryRun: !!args['dry-run'],
  })
    .then(async (result) => {
      console.log(JSON.stringify(result, null, 2));
      await require('./db').closePool().catch(() => {});
    })
    .catch(async (e) => {
      console.error(JSON.stringify({ ok: false, error: e.message }));
      await require('./db').closePool().catch(() => {});
      process.exit(1);
    });
}
