import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import cors from 'cors';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  LANGUAGE_LIST,
  isLangCode,
  type ClientMessage,
  type ServerMessage,
} from '@suvidha/shared';
import { config, describeConfig, repoRoot } from './config.js';
import { GLOSSARY_PACKS, mergePacks } from './data/glossary-packs.js';
import { buildGlossaryFromSource } from './pipeline/auto-glossary.js';
import { proposeVisualFor, renderVisual, requestVisual } from './pipeline/visualize.js';
import { createRoom, getRoom, listRooms, parseLang, type Listener, type Room } from './rooms.js';
import { listRecordings, loadRecording, saveRecording } from './store.js';
import { buildMatcher } from './pipeline/glossary.js';
import { translateUtterance } from './pipeline/translate.js';
import { gateStatus, tryListModels } from './providers/featherless.js';

const app = express();

/**
 * CORS.
 *
 * With ALLOWED_ORIGINS unset the server reflects whichever origin asks. That is
 * the right default for local development and for a hackathon demo, where the
 * frontend's preview URL changes on every push and pinning it would mean
 * redeploying the server to fix the frontend. Set it in production.
 */
app.use(
  cors({
    origin:
      config.allowedOrigins.length > 0
        ? config.allowedOrigins
        : true,
    credentials: false,
  }),
);
app.use(express.json({ limit: '2mb' }));

/* ------------------------------------------------------------------ *
 * REST
 * ------------------------------------------------------------------ */

app.get('/api/health', (_req, res) => {
  // `gate` is included because "the demo felt slow" is otherwise unfalsifiable:
  // it distinguishes a saturated request budget from a slow network.
  res.json({ ok: true, services: describeConfig(), gate: gateStatus() });
});

/** Confirms the Featherless key works, for the setup screen. */
app.get('/api/models', async (_req, res) => {
  const models = await tryListModels();
  res.json({ count: models.length, sample: models.slice(0, 40) });
});

app.get('/api/languages', (_req, res) => {
  res.json(LANGUAGE_LIST);
});

app.get('/api/packs', (_req, res) => {
  res.json(
    GLOSSARY_PACKS.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      termCount: p.terms.length,
    })),
  );
});

/** Starts a lecture and returns the code students join with. */
app.post('/api/lectures', (req, res) => {
  const { title, course, instructor, instructionLang, packIds, extraTerms } = req.body ?? {};

  const glossary = mergePacks(Array.isArray(packIds) ? packIds : []);

  // Terms the professor typed in by hand outrank the packs.
  if (Array.isArray(extraTerms)) {
    for (const raw of extraTerms) {
      const term = String(raw ?? '').trim();
      if (!term) continue;
      glossary.unshift({
        id: `manual-${glossary.length}-${term.slice(0, 12)}`,
        term,
        aliases: [],
        source: 'manual',
      });
    }
  }

  const room = createRoom(
    {
      title: String(title ?? 'Untitled lecture'),
      course: String(course ?? ''),
      instructor: String(instructor ?? ''),
      instructionLang: parseLang(instructionLang, 'en'),
    },
    glossary,
  );

  res.json({ lecture: room.meta, glossary: room.glossary });
});

app.get('/api/lectures', (_req, res) => {
  res.json(listRooms());
});

app.get('/api/lectures/:id', (req, res) => {
  const room = getRoom(req.params.id.toUpperCase());
  if (!room) {
    res.status(404).json({ error: 'No live lecture with that code' });
    return;
  }
  res.json({ lecture: room.meta, glossary: room.glossary, listeners: room.listenerCount });
});

app.get('/api/recordings', async (_req, res) => {
  res.json(await listRecordings());
});

app.get('/api/recordings/:id', async (req, res) => {
  const rec = await loadRecording(req.params.id);
  if (!rec) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }
  res.json(rec);
});

/**
 * Translates an archived lecture into a language it was never rendered in.
 *
 * Live translation only runs for languages someone is actually listening to,
 * because rendering into an empty room costs latency for the students who are
 * present. The consequence is that a recording is missing every language nobody
 * chose that day - and the student who most needs the recording is often
 * exactly the one who was not in the room.
 *
 * Because the archive stores text rather than audio, that is fixable after the
 * fact: the transcript can be rendered into any language on demand, and the
 * result is written back so the next person to ask gets it instantly.
 *
 * Batched, because an hour-long lecture is several hundred utterances and no
 * single HTTP request should carry that. The client walks through the batches
 * and shows progress.
 */
app.post('/api/recordings/:id/translate', async (req, res) => {
  const lang = parseLang(req.body?.lang, 'hi');
  const from = Number.isFinite(Number(req.body?.from)) ? Number(req.body.from) : 0;
  const count = Math.min(40, Math.max(1, Number(req.body?.count) || 25));

  const rec = await loadRecording(req.params.id);
  if (!rec) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }

  if (lang === rec.instructionLang) {
    res.json({ translated: 0, total: rec.utterances.length, done: true, lang });
    return;
  }

  const matcher = buildMatcher(rec.glossary);
  const slice = rec.utterances.slice(from, from + count);

  const results = await Promise.all(
    slice.map(async (utterance) => {
      const existing = rec.translations[utterance.id]?.find((t) => t.lang === lang);
      if (existing) return existing;
      return translateUtterance({
        utteranceId: utterance.id,
        text: utterance.text,
        from: rec.instructionLang,
        to: lang,
        matcher,
      });
    }),
  );

  for (const tr of results) {
    const list = rec.translations[tr.utteranceId] ?? [];
    const at = list.findIndex((t) => t.lang === tr.lang);
    if (at >= 0) list[at] = tr;
    else list.push(tr);
    rec.translations[tr.utteranceId] = list;
  }

  await saveRecording(rec);

  const next = from + slice.length;
  res.json({
    translated: next,
    total: rec.utterances.length,
    done: next >= rec.utterances.length,
    lang,
    // Returned so the client can render this batch immediately rather than
    // waiting for the whole lecture to finish.
    batch: results,
  });
});

/** Builds a glossary from a syllabus URL or pasted course text. */
app.post('/api/glossary/build', async (req, res) => {
  const { url, text, subject } = req.body ?? {};
  try {
    const terms = await buildGlossaryFromSource({
      url: typeof url === 'string' ? url : undefined,
      text: typeof text === 'string' ? text : undefined,
      subject: typeof subject === 'string' ? subject : undefined,
    });
    res.json({ terms });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Glossary build failed' });
  }
});

/** Replaces a live room's glossary, mid-lecture. */
app.put('/api/lectures/:id/glossary', (req, res) => {
  const room = getRoom(req.params.id.toUpperCase());
  if (!room) {
    res.status(404).json({ error: 'No live lecture with that code' });
    return;
  }
  const terms = Array.isArray(req.body?.terms) ? req.body.terms : [];
  room.updateGlossary(terms);
  res.json({ ok: true, count: terms.length });
});

/** Renders a visualisation on demand, outside the live loop. */
app.post('/api/visualize', async (req, res) => {
  const { prompt, lectureId } = req.body ?? {};
  try {
    const viz = await requestVisual(String(prompt ?? ''), String(lectureId ?? 'adhoc'));
    res.json(viz);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Visualisation failed' });
  }
});

/* ------------------------------------------------------------------ *
 * Static frontend (single-host deployment)
 * ------------------------------------------------------------------ */

/**
 * Serves `web/dist` when it has been built.
 *
 * This makes a one-host deployment possible: `npm run build` then `npm start`,
 * and the professor console, the student view and the WebSocket all live behind
 * a single origin with no CORS and no VITE_SERVER_URL to configure. It is the
 * simplest thing that works, and it is the fallback if a split deployment
 * misbehaves the night before a demo.
 *
 * Mounted after the API routes so nothing here can shadow `/api`.
 */
const webDist = join(repoRoot, 'web', 'dist');
const shouldServeStatic =
  config.serveStatic === 'true' || (config.serveStatic === 'auto' && existsSync(webDist));

if (shouldServeStatic) {
  app.use(express.static(webDist));

  // The frontend is a single-page app: every route it owns has to resolve to
  // index.html, or a student who reloads on /listen/ABC123 gets a 404.
  app.get(/^\/(?!api\/|ws$).*/, (_req, res) => {
    res.sendFile(join(webDist, 'index.html'));
  });
}

/* ------------------------------------------------------------------ *
 * WebSocket
 * ------------------------------------------------------------------ */

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

interface Session {
  role: 'professor' | 'student' | null;
  room: Room | null;
  listener: Listener | null;
  /** Wall-clock start, so utterance timestamps are lecture-relative. */
  joinedAt: number;
}

function reply(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

wss.on('connection', (socket) => {
  const session: Session = { role: null, room: null, listener: null, joinedAt: Date.now() };

  socket.on('message', async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      reply(socket, { type: 'error', message: 'Malformed message' });
      return;
    }

    try {
      switch (msg.type) {
        case 'ping':
          reply(socket, { type: 'pong' });
          break;

        case 'prof:join': {
          const room = getRoom(msg.lectureId.toUpperCase());
          if (!room) {
            reply(socket, { type: 'error', message: 'No live lecture with that code' });
            return;
          }
          session.role = 'professor';
          session.room = room;
          room.attachProfessor(socket);
          break;
        }

        case 'student:join': {
          const room = getRoom(msg.lectureId.toUpperCase());
          if (!room) {
            reply(socket, { type: 'error', message: 'No live lecture with that code' });
            return;
          }
          if (room.isEnded) {
            reply(socket, { type: 'error', message: 'That lecture has ended' });
            return;
          }
          session.role = 'student';
          session.room = room;
          session.listener = room.addListener(socket, parseLang(msg.lang, 'hi'));
          break;
        }

        case 'student:set-lang': {
          if (!session.room || !session.listener) return;
          if (!isLangCode(msg.lang)) return;
          session.room.setListenerLang(session.listener, msg.lang);
          break;
        }

        case 'prof:utterance': {
          if (session.role !== 'professor' || !session.room) return;
          await session.room.handleSpeech(msg.text, msg.final, msg.t);
          break;
        }

        case 'prof:request-viz': {
          if (session.role !== 'professor' || !session.room) return;
          const viz = await requestVisual(msg.prompt, session.room.meta.id);
          session.room.proposeVisual(viz);
          break;
        }

        case 'prof:viz-decision': {
          if (session.role !== 'professor' || !session.room) return;
          const viz = session.room.findVisual(msg.vizId);
          if (!viz) return;
          if (!msg.approve) {
            session.room.proposeVisual({ ...viz, status: 'rejected' });
            return;
          }
          // Rendering happens at approval time rather than at proposal time, so
          // a rejected suggestion never costs a Wolfram call.
          const rendered = await renderVisual({ ...viz, status: 'approved' });
          session.room.publishVisual(rendered);
          break;
        }

        case 'prof:accept-terms': {
          if (session.role !== 'professor' || !session.room) return;
          session.room.acceptSuggestions(msg.terms);
          break;
        }

        case 'prof:dismiss-terms': {
          if (session.role !== 'professor' || !session.room) return;
          session.room.dismissSuggestions();
          break;
        }

        case 'prof:end': {
          if (session.role !== 'professor' || !session.room) return;
          await session.room.end();
          break;
        }
      }
    } catch (err) {
      console.error('[ws] handler failed:', err);
      reply(socket, {
        type: 'error',
        message: err instanceof Error ? err.message : 'Server error',
      });
    }
  });

  socket.on('close', () => {
    if (session.room && session.listener) session.room.removeListener(session.listener);
    if (session.room && session.role === 'professor') session.room.detachProfessor(socket);
  });

  socket.on('error', () => {
    /* Connection errors surface as 'close'; nothing extra to do. */
  });
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

server.listen(config.port, () => {
  console.log(`\n  Suvidha server  ·  http://localhost:${config.port}\n`);
  for (const s of describeConfig()) {
    console.log(`  ${s.enabled ? '✓' : '·'} ${s.name.padEnd(18)} ${s.detail}`);
  }
  console.log('');
});

// Background passes over live rooms. Both run on timers rather than
// per-utterance, and both stand down when the request budget is under
// pressure, so neither can ever sit in front of a translation a student is
// waiting to hear.

// Suggest a visual when recent speech looks plottable.
setInterval(() => {
  for (const meta of listRooms()) {
    const room = getRoom(meta.id);
    if (room) void proposeVisualFor(room);
  }
}, 20_000);

// Catch subject vocabulary the glossary is missing. Runs more often than the
// visual pass: an unprotected term is mistranslated in every sentence it
// appears in until it is added, so minutes matter.
setInterval(() => {
  for (const meta of listRooms()) {
    const room = getRoom(meta.id);
    if (room) void room.scoutForTerms();
  }
}, 12_000);
