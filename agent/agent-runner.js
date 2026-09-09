#!/usr/bin/env node
// Tool-loop runner — OpenRouter or Ollama (OpenAI-compatible API).
//
//   node agent-runner.js --trigger <type> --prompt "..." [--system-file path]
//
// Prints step logs to stdout. Ends with a line:
//   ===AGENT_RESULT===
//   {"ok":true,"reply":"...","usage":{...},"model":"..."}

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pending = require('./pending');
const freeagent = require('./freeagent');
const { WO_RE, DEFAULT_FROM } = require('./wo-colour');

const AGENT_DIR = process.env.AGENT_DIR || path.dirname(__filename);
const LLM_BACKEND = (process.env.LLM_BACKEND || 'openrouter').toLowerCase();
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://shack.beetal-carp.ts.net:11434').replace(/\/$/, '');
const OPENROUTER_URL = process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions';
const AGENT_MODEL = process.env.AGENT_MODEL || (
  LLM_BACKEND === 'ollama' ? 'qwen3' : 'google/gemini-2.5-flash'
);
// Tried in order after AGENT_MODEL if a request fails (model pulled, key limit,
// backend unreachable, etc). Each entry is "model" (same backend as AGENT_MODEL)
// or "backend:model" (e.g. "openrouter:google/gemini-2.5-flash") to fall over to
// a different backend entirely.
const AGENT_MODEL_FALLBACKS = (process.env.AGENT_MODEL_FALLBACK || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((entry) => {
    const m = entry.match(/^(ollama|openrouter):(.+)$/);
    return m ? { backend: m[1], model: m[2] } : { backend: LLM_BACKEND, model: entry };
  })
  .filter((c) => !(c.backend === LLM_BACKEND && c.model === AGENT_MODEL));
let activeBackend = LLM_BACKEND;
let activeModel = AGENT_MODEL;
const MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS || '16', 10);
const TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS || '180000', 10);

const ALLOWED_READ = new Set([
  path.join(AGENT_DIR, 'JJP_Property_List.md'),
  path.join(AGENT_DIR, 'property-aliases.json'),
  path.join(AGENT_DIR, 'rates.json'),
  path.join(AGENT_DIR, 'properties.txt'),
  '/agent/JJP_Property_List.md',
  '/agent/property-aliases.json',
  '/agent/rates.json',
  '/agent/properties.txt',
]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function log(msg) {
  console.log(`[runner ${new Date().toISOString()}] ${msg}`);
}

function runCmd(bin, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('node', [bin, ...args], {
      env: process.env,
      cwd: AGENT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms`, stdout, stderr });
    }, timeoutMs);
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          // Prefer last JSON object line
          const lines = trimmed.split('\n').filter(Boolean);
          parsed = JSON.parse(lines[lines.length - 1]);
        } catch {
          try { parsed = JSON.parse(trimmed); } catch { /* leave null */ }
        }
      }
      if (code === 0 && parsed) {
        resolve(parsed);
      } else if (parsed) {
        resolve(parsed);
      } else {
        resolve({
          ok: code === 0,
          exitCode: code,
          stdout: trimmed.slice(0, 4000),
          stderr: stderr.trim().slice(0, 2000),
          error: code === 0 ? null : `exit ${code}`,
        });
      }
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
  });
}

// gcal_create_event dedup guard (BUG-020): a session must not create a second
// Maintenance event for a WO number that already has one — see NEXT.md
// 2026-09-09, where three fresh duplicates got created for already-complete
// WOs. Cache is per-process (one session per agent-runner.js run), lazily
// loaded once per calendar and topped up with events this session creates,
// so a session that creates two events for the same WO in one run also
// catches itself.
const woEventCache = new Map(); // calendar -> array of {summary, description}

async function loadWoEventCache(calendar) {
  if (woEventCache.has(calendar)) return woEventCache.get(calendar);
  const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const result = await runCmd(path.join(AGENT_DIR, 'gcal.js'), [
    'list-events',
    '--calendar', calendar,
    '--from', `${DEFAULT_FROM}T00:00:00Z`,
    '--to', `${to}T23:59:59Z`,
    '--limit', '500',
  ]);
  const events = result.ok && Array.isArray(result.events) ? result.events : [];
  woEventCache.set(calendar, events);
  return events;
}

function findExistingWoEvent(events, woNumber) {
  return events.find((e) => `${e.summary || ''} ${e.description || ''}`.toUpperCase().includes(woNumber));
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'telegram_send',
      description: 'Send a Telegram message to John',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'maintenance_upcoming',
      description: 'List open/upcoming maintenance tasks',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number' },
          property: { type: 'string', description: 'Shortcode e.g. 24HC' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'maintenance_search',
      description: 'Search maintenance tasks and logs',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          property: { type: 'string' },
        },
        required: ['q'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'maintenance_add',
      description: 'Add a maintenance task',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          category: { type: 'string' },
          priority: { type: 'string' },
          property: { type: 'string' },
          notes: { type: 'string' },
          frequency_days: { type: 'number' },
          next_due: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'maintenance_log',
      description: 'Log completion of a maintenance task (closes it if no frequency)',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          notes: { type: 'string' },
          performed_by: { type: 'string' },
          cost: { type: 'number' },
          next_action: { type: 'string' },
          completed_at: { type: 'string' },
        },
        required: ['task_id', 'notes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'store_list_inbox',
      description: 'List open inbox items',
      parameters: { type: 'object', properties: { all: { type: 'boolean' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'store_complete',
      description: 'Mark an inbox item complete',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          actioned: { type: 'string' },
        },
        required: ['id', 'actioned'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'store_note',
      description: 'Write a note to the local store',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          property: { type: 'string' },
          type: { type: 'string' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'store_invoice_check',
      description: 'Check if a calendar event was already invoiced',
      parameters: {
        type: 'object',
        properties: { event_id: { type: 'string' } },
        required: ['event_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'store_invoice_mark',
      description: 'Mark a calendar event as invoiced',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string' },
          acronym: { type: 'string' },
          hours: { type: 'number' },
        },
        required: ['event_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'docs_search',
      description: 'Semantic/text search property documents',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          property: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['q'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'docs_list',
      description: 'List documents for a property',
      parameters: {
        type: 'object',
        properties: {
          property: { type: 'string' },
          type: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'docs_get',
      description: 'Get a document by id',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gcal_list_calendars',
      description: 'List Google calendars',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gcal_list_events',
      description: 'List events on a calendar between from/to ISO timestamps',
      parameters: {
        type: 'object',
        properties: {
          calendar: { type: 'string', description: 'Maintenance | Property | calendar id' },
          from: { type: 'string' },
          to: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['calendar', 'from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gcal_create_event',
      description: 'Create an all-day event on Maintenance (or other) calendar',
      parameters: {
        type: 'object',
        properties: {
          calendar: { type: 'string' },
          summary: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          description: { type: 'string' },
        },
        required: ['calendar', 'summary', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gcal_update_event',
      description: 'Update event description/summary',
      parameters: {
        type: 'object',
        properties: {
          calendar: { type: 'string' },
          event_id: { type: 'string' },
          description: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['calendar', 'event_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'freeagent_create_invoice',
      description: 'Create a FreeAgent draft invoice',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          dated_on: { type: 'string' },
          address: { type: 'string' },
          contact: { type: 'string' },
        },
        required: ['description', 'dated_on'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read an allowlisted property data file',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'JJP_Property_List.md | property-aliases.json | rates.json | properties.txt (or /agent/… path)',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wo_lookup',
      description:
        'Look up tenant name and mobile from work-order PDF store (Contact for Access). Use for “number for X”, “tenant phone”, “who lives at”, name+phone questions.',
      parameters: {
        type: 'object',
        properties: {
          property: { type: 'string', description: 'Shortcode e.g. 24HC' },
          rescan: { type: 'boolean', description: 'Re-scan PDFs before lookup' },
        },
        required: ['property'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wo_scan',
      description: 'Scan /output/work_orders PDFs and refresh tenant contact cache',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'key_lookup',
      description:
        'Look up the physical key code (and lockbox code if on file) for a property from the Key book. Use for “key for X”, “keycode for X”, “lockbox for X”.',
      parameters: {
        type: 'object',
        properties: {
          property: { type: 'string', description: 'Shortcode e.g. 48BC' },
        },
        required: ['property'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pending_get',
      description: 'Get the active pending confirmation (if any)',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pending_set',
      description: 'Set a pending confirmation when the command is ambiguous',
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string' },
          property: { type: 'string' },
          question: { type: 'string' },
          candidates: {
            type: 'array',
            items: { type: 'object' },
          },
          ttl_minutes: { type: 'number' },
        },
        required: ['intent', 'question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pending_clear',
      description: 'Clear pending confirmation after success or new command',
      parameters: { type: 'object', properties: {} },
    },
  },
];

async function executeTool(name, args, context = {}) {
  const a = args || {};
  switch (name) {
    case 'telegram_send': {
      // Morning WO/outstanding counts are sent by the scheduler (deterministic).
      // The model previously ignored "no morning Telegram" and alarmed on the
      // stale maintenance_tasks ledger — refuse rather than trust the prompt.
      if (context.trigger === 'morning') {
        return {
          ok: false,
          error:
            'telegram_send is disabled for morning sessions. ' +
            'WO outstanding is already sent by the scheduler; email-only if non-WO maintenance needs attention.',
        };
      }
      const sendResult = await runCmd(path.join(AGENT_DIR, 'telegram.js'), ['send', a.text || '']);
      // Deterministic fallback: the model doesn't reliably pair a clarifying
      // question with pending_set, so if this message looks like a question
      // and nothing already covers it, store it ourselves. A later explicit
      // pending_set (richer intent/property/candidates) still overrides this.
      if (sendResult && sendResult.ok && (a.text || '').includes('?')) {
        const current = pending.getPending();
        if (!current || current.question !== a.text) {
          try {
            pending.setPending({
              intent: 'telegram_question',
              question: a.text,
              ttlMinutes: 1440,
            });
          } catch (e) {
            // non-fatal — don't fail the send over bookkeeping
          }
        }
      }
      return sendResult;
    }
    case 'maintenance_upcoming': {
      const argv = ['upcoming'];
      if (a.days != null) argv.push('--days', String(a.days));
      if (a.property) argv.push('--property', a.property);
      return runCmd(path.join(AGENT_DIR, 'maintenance.js'), argv);
    }
    case 'maintenance_search': {
      const argv = ['search', '--q', a.q || ''];
      if (a.property) argv.push('--property', a.property);
      return runCmd(path.join(AGENT_DIR, 'maintenance.js'), argv);
    }
    case 'maintenance_add': {
      const argv = ['add', '--name', a.name || ''];
      if (a.category) argv.push('--category', a.category);
      if (a.priority) argv.push('--priority', a.priority);
      if (a.property) argv.push('--property', a.property);
      if (a.notes) argv.push('--notes', a.notes);
      if (a.frequency_days != null) argv.push('--frequency-days', String(a.frequency_days));
      if (a.next_due) argv.push('--next-due', a.next_due);
      return runCmd(path.join(AGENT_DIR, 'maintenance.js'), argv);
    }
    case 'maintenance_log': {
      const argv = ['log', '--task-id', a.task_id || '', '--notes', a.notes || ''];
      if (a.performed_by) argv.push('--performed-by', a.performed_by);
      if (a.cost != null) argv.push('--cost', String(a.cost));
      if (a.next_action) argv.push('--next-action', a.next_action);
      if (a.completed_at) argv.push('--completed-at', a.completed_at);
      return runCmd(path.join(AGENT_DIR, 'maintenance.js'), argv);
    }
    case 'store_list_inbox': {
      const argv = ['list-inbox'];
      if (a.all) argv.push('--all');
      return runCmd(path.join(AGENT_DIR, 'store.js'), argv);
    }
    case 'store_complete':
      return runCmd(path.join(AGENT_DIR, 'store.js'), [
        'complete', '--id', a.id || '', '--actioned', a.actioned || '',
      ]);
    case 'store_note': {
      const argv = ['note', '--text', a.text || ''];
      if (a.property) argv.push('--property', a.property);
      if (a.type) argv.push('--type', a.type);
      return runCmd(path.join(AGENT_DIR, 'store.js'), argv);
    }
    case 'store_invoice_check':
      return runCmd(path.join(AGENT_DIR, 'store.js'), [
        'invoice-check', '--event-id', a.event_id || '',
      ]);
    case 'store_invoice_mark': {
      const argv = ['invoice-mark', '--event-id', a.event_id || ''];
      if (a.acronym) argv.push('--acronym', a.acronym);
      if (a.hours != null) argv.push('--hours', String(a.hours));
      return runCmd(path.join(AGENT_DIR, 'store.js'), argv);
    }
    case 'docs_search': {
      const argv = ['search', '--q', a.q || ''];
      if (a.property) argv.push('--property', a.property);
      if (a.limit != null) argv.push('--limit', String(a.limit));
      return runCmd(path.join(AGENT_DIR, 'docs.js'), argv);
    }
    case 'docs_list': {
      const argv = ['list'];
      if (a.property) argv.push('--property', a.property);
      if (a.type) argv.push('--type', a.type);
      return runCmd(path.join(AGENT_DIR, 'docs.js'), argv);
    }
    case 'docs_get':
      return runCmd(path.join(AGENT_DIR, 'docs.js'), ['get', '--id', a.id || '']);
    case 'gcal_list_calendars':
      return runCmd(path.join(AGENT_DIR, 'gcal.js'), ['list-calendars']);
    case 'gcal_list_events': {
      const argv = [
        'list-events',
        '--calendar', a.calendar || 'Maintenance',
        '--from', a.from || '',
        '--to', a.to || '',
      ];
      if (a.limit != null) argv.push('--limit', String(a.limit));
      return runCmd(path.join(AGENT_DIR, 'gcal.js'), argv);
    }
    case 'gcal_create_event': {
      const calendar = a.calendar || 'Maintenance';
      const woMatch = `${a.summary || ''} ${a.description || ''}`.match(WO_RE);
      if (woMatch) {
        const woNumber = woMatch[0].toUpperCase();
        const events = await loadWoEventCache(calendar);
        const existing = findExistingWoEvent(events, woNumber);
        if (existing) {
          return {
            ok: false,
            error: `${woNumber} already has a calendar event on ${calendar} `
              + `(id ${existing.id}, "${existing.summary}") — not creating a duplicate. `
              + `If this is genuinely a new job, use a different WO number or update the existing event instead.`,
          };
        }
      }
      const argv = [
        'create-event',
        '--calendar', calendar,
        '--summary', a.summary || '',
        '--date', a.date || '',
      ];
      if (a.description) argv.push('--description', a.description);
      const result = await runCmd(path.join(AGENT_DIR, 'gcal.js'), argv);
      if (woMatch && result.ok && result.event) {
        woEventCache.get(calendar).push(result.event);
      }
      return result;
    }
    case 'gcal_update_event': {
      const argv = [
        'update-event',
        '--calendar', a.calendar || 'Maintenance',
        '--event-id', a.event_id || '',
      ];
      // Guard against the model writing a completion note whose hours don't
      // parse (prose instead of a clean "Complete Nhr" line) — see NEXT.md
      // 2026-09-04. Appends a normalized line when needed; no-op otherwise.
      if (a.description != null) {
        argv.push('--description', freeagent.ensureCompletionHoursLine(a.description));
      }
      if (a.summary) argv.push('--summary', a.summary);
      return runCmd(path.join(AGENT_DIR, 'gcal.js'), argv);
    }
    case 'freeagent_create_invoice': {
      const argv = [
        'create-invoice',
        '--description', a.description || '',
        '--dated-on', a.dated_on || '',
      ];
      if (a.address) argv.push('--address', a.address);
      if (a.contact) argv.push('--contact', a.contact);
      return runCmd(path.join(AGENT_DIR, 'freeagent.js'), argv);
    }
    case 'read_file': {
      let p = a.path || '';
      if (!p.includes('/')) p = path.join(AGENT_DIR, p);
      const resolved = path.resolve(p);
      const allowed = [...ALLOWED_READ].some((x) => path.resolve(x) === resolved);
      if (!allowed) {
        return { ok: false, error: `path not allowlisted: ${a.path}` };
      }
      if (!fs.existsSync(resolved)) {
        return { ok: false, error: `file not found: ${resolved}` };
      }
      const content = fs.readFileSync(resolved, 'utf8');
      return { ok: true, path: resolved, content: content.slice(0, 120_000) };
    }
    case 'wo_lookup': {
      const argv = ['lookup', '--property', a.property || ''];
      if (a.rescan) argv.push('--rescan');
      return runCmd(path.join(AGENT_DIR, 'wo.js'), argv);
    }
    case 'wo_scan':
      return runCmd(path.join(AGENT_DIR, 'wo.js'), ['scan']);
    case 'key_lookup':
      return runCmd(path.join(AGENT_DIR, 'keys.js'), ['lookup', '--property', a.property || '']);
    case 'pending_get':
      return { ok: true, pending: pending.getPending() };
    case 'pending_set':
      return {
        ok: true,
        pending: pending.setPending({
          intent: a.intent,
          property: a.property || null,
          question: a.question,
          candidates: a.candidates || [],
          ttlMinutes: a.ttl_minutes,
        }),
      };
    case 'pending_clear':
      return pending.clearPending();
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}

function extractToolCalls(message) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return message.tool_calls;
  }
  // Some providers put functionCall on content parts
  if (Array.isArray(message.content)) {
    const calls = [];
    for (const part of message.content) {
      if (part && (part.type === 'tool_use' || part.type === 'functionCall')) {
        calls.push({
          id: part.id || `call_${calls.length}`,
          type: 'function',
          function: {
            name: part.name || part.functionCall?.name,
            arguments: JSON.stringify(part.input || part.functionCall?.args || {}),
          },
        });
      }
    }
    if (calls.length) return calls;
  }
  return [];
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
      .map((p) => p.text || '')
      .join('\n')
      .trim();
  }
  return '';
}

function llmLabel(backend) {
  return backend === 'ollama' ? 'Ollama' : 'OpenRouter';
}

async function chatWithModel(messages, backend, model) {
  const payload = {
    model,
    messages,
    tools: TOOLS,
    tool_choice: 'auto',
    temperature: 0.2,
  };

  let url;
  let headers = { 'Content-Type': 'application/json' };

  if (backend === 'ollama') {
    url = `${OLLAMA_BASE_URL}/v1/chat/completions`;
  } else {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error('OPENROUTER_API_KEY is not set');
    url = OPENROUTER_URL;
    headers = {
      ...headers,
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://github.com/JohnMacrae/claude-nas-agent',
      'X-Title': 'property-agent',
    };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`${llmLabel(backend)} ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function chat(messages) {
  const candidates = [{ backend: LLM_BACKEND, model: AGENT_MODEL }, ...AGENT_MODEL_FALLBACKS];
  let lastErr;
  for (const { backend, model } of candidates) {
    try {
      const data = await chatWithModel(messages, backend, model);
      if (backend !== activeBackend || model !== activeModel) {
        log(`falling back to ${llmLabel(backend)} model ${model}`);
      }
      activeBackend = backend;
      activeModel = model;
      return data;
    } catch (e) {
      lastErr = e;
      log(`${llmLabel(backend)} model ${model} failed: ${e.message}`);
    }
  }
  throw lastErr;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const trigger = args.trigger || 'manual';
  const userPrompt = args.prompt;
  if (!userPrompt || userPrompt === true) {
    throw new Error('--prompt is required');
  }

  const systemFile = (args['system-file'] && args['system-file'] !== true)
    ? args['system-file']
    : path.join(AGENT_DIR, 'agent-system-prompt.md');
  let systemPrompt = '';
  try {
    systemPrompt = fs.readFileSync(systemFile, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read system prompt ${systemFile}: ${e.message}`);
  }

  const started = Date.now();
  const usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const fallbackNote = AGENT_MODEL_FALLBACKS.length
    ? ` fallbacks=${AGENT_MODEL_FALLBACKS.map((c) => `${c.backend}:${c.model}`).join(',')}`
    : '';
  log(`start trigger=${trigger} backend=${LLM_BACKEND} model=${AGENT_MODEL}${fallbackNote} max_steps=${MAX_STEPS}`);

  let finalReply = '';
  let step = 0;

  while (step < MAX_STEPS) {
    if (Date.now() - started > TIMEOUT_MS) {
      throw new Error(`wall-clock timeout ${TIMEOUT_MS}ms`);
    }
    step += 1;
    log(`step ${step} — calling ${llmLabel(activeBackend)}`);
    const data = await chat(messages);
    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error(`no choices: ${JSON.stringify(data)}`);

    if (data.usage) {
      usageTotals.prompt_tokens += data.usage.prompt_tokens || 0;
      usageTotals.completion_tokens += data.usage.completion_tokens || 0;
      usageTotals.total_tokens += data.usage.total_tokens || 0;
    }

    const msg = choice.message || {};
    const toolCalls = extractToolCalls(msg);

    if (toolCalls.length) {
      messages.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments || {}),
          },
        })),
      });

      for (const tc of toolCalls) {
        const name = tc.function.name;
        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}');
        } catch {
          parsedArgs = {};
        }
        log(`tool ${name} ${JSON.stringify(parsedArgs).slice(0, 200)}`);
        const result = await executeTool(name, parsedArgs, { trigger });
        const payload = typeof result === 'string' ? result : JSON.stringify(result);
        log(`tool ${name} → ${payload.slice(0, 300)}`);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name,
          content: payload.slice(0, 50_000),
        });
      }
      continue;
    }

    finalReply = messageText(msg);
    log(`final reply (${finalReply.length} chars)`);
    break;
  }

  if (step >= MAX_STEPS && !finalReply) {
    finalReply = 'Stopped after max tool steps without a final answer.';
  }

  const result = {
    ok: true,
    reply: finalReply,
    trigger,
    backend: activeBackend,
    model: activeModel,
    steps: step,
    usage: usageTotals,
    elapsed_ms: Date.now() - started,
  };
  console.log('===AGENT_RESULT===');
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  const result = { ok: false, error: e.message, reply: `Error: ${e.message}`, backend: activeBackend, model: activeModel };
  console.error(`[runner] ${e.message}`);
  console.log('===AGENT_RESULT===');
  console.log(JSON.stringify(result));
  process.exit(1);
});
