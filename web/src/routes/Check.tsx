import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LANGUAGES, type LangCode, type SpeechRun } from '@suvidha/shared';
import { api } from '../lib/api';
import { isRecognitionSupported } from '../lib/asr';
import { SpeechQueue, isSpeechSupported, loadVoices, pickVoice, unlockAudio } from '../lib/tts';
import { Badge, Button, Card, RunText, Shell } from '../components/ui';

/**
 * Pre-flight check.
 *
 * Run this in the room, on the machine that will teach, before the class
 * arrives. Everything it tests is a property of the browser and the operating
 * system rather than of this application, which means none of it can be
 * verified from a server, a test suite, or another computer - and all of it can
 * silently be missing.
 *
 * The one that catches people out is voices. Speech synthesis reports success
 * for a language it has no voice for and simply produces nothing, so a lecture
 * can appear to be working perfectly while every student hears silence. Better
 * to find out now.
 */

type State = 'checking' | 'ok' | 'warn' | 'fail';

interface Row {
  label: string;
  state: State;
  detail: string;
  fix?: string;
}

export default function Check() {
  const [rows, setRows] = useState<Row[]>([]);
  const [voiceRows, setVoiceRows] = useState<Row[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [micState, setMicState] = useState<Row | null>(null);

  const run = useCallback(async () => {
    const out: Row[] = [];

    // 1. Server
    try {
      const health = await api.health();
      const translation = health.services.find((s) => s.name === 'translation');
      out.push({
        label: 'Server',
        state: translation?.enabled ? 'ok' : 'warn',
        detail: translation?.enabled
          ? translation.detail
          : 'Reachable, but translation is in passthrough mode',
        fix: translation?.enabled ? undefined : 'Set FEATHERLESS_API_KEY and restart the server.',
      });
    } catch {
      out.push({
        label: 'Server',
        state: 'fail',
        detail: 'Cannot reach the server',
        fix: 'Is it running? Check the address in the browser bar.',
      });
    }

    // 2. Recognition - the professor's half
    out.push(
      isRecognitionSupported()
        ? { label: 'Speech recognition', state: 'ok', detail: 'Available in this browser' }
        : {
            label: 'Speech recognition',
            state: 'fail',
            detail: 'This browser cannot capture speech',
            fix: 'Teach from Chrome or Edge. Students can listen in any browser.',
          },
    );

    // 3. Secure context - recognition silently refuses without it
    const secure = window.isSecureContext;
    out.push({
      label: 'Secure context',
      state: secure ? 'ok' : 'fail',
      detail: secure ? `${location.protocol}//` : 'Page is not served over HTTPS or localhost',
      fix: secure ? undefined : 'Microphone access requires HTTPS. Use the deployed URL.',
    });

    // 4. Synthesis - the students' half
    if (!isSpeechSupported()) {
      out.push({
        label: 'Speech synthesis',
        state: 'fail',
        detail: 'This browser cannot speak',
        fix: 'Students should use Chrome, Edge or Safari.',
      });
      setRows(out);
      return;
    }

    setRows(out);

    // 5. Per-language voices. The important one.
    await loadVoices();
    const langs: LangCode[] = ['en', 'hi', 'bn', 'fr'];
    setVoiceRows(
      langs.map((code) => {
        const spec = LANGUAGES[code];
        const voice = pickVoice(code);
        if (!voice) {
          return {
            label: `${spec.nativeName} (${spec.name})`,
            state: 'fail',
            detail: 'No voice installed — students will see subtitles but hear nothing',
            fix:
              'Windows: Settings → Time & language → Language & region → Add a language, ' +
              'and tick "Speech" when choosing features. Then restart the browser.',
          };
        }
        const exact = spec.ttsLocales.some(
          (l) => voice.lang.replace('_', '-').toLowerCase() === l.toLowerCase(),
        );
        return {
          label: `${spec.nativeName} (${spec.name})`,
          state: exact ? 'ok' : 'warn',
          detail: `${voice.name} [${voice.lang}]${voice.localService ? '' : ' · network voice'}`,
          fix: exact ? undefined : 'A close locale, not the preferred one. Usually fine.',
        };
      }),
    );
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  /**
   * Speaks a real mixed-language sentence.
   *
   * Not a generic "test" phrase: this is the actual output shape the product
   * produces, with the explanation in Hindi and the terms in English, spoken by
   * two different voices. If this sounds right, the feature works.
   */
  const demo = () => {
    unlockAudio();
    setSpeaking(true);
    const runs: SpeechRun[] = [
      { lang: 'hi', text: 'तो इस ', isTerm: false },
      { lang: 'en', text: 'matrix', isTerm: true },
      { lang: 'hi', text: ' का ', isTerm: false },
      { lang: 'en', text: 'eigenvalue', isTerm: true },
      { lang: 'hi', text: ' हमें बताता है कि ', isTerm: false },
      { lang: 'en', text: 'eigenvector', isTerm: true },
      { lang: 'hi', text: ' कितना खिंचता है।', isTerm: false },
    ];
    const queue = new SpeechQueue({ onEnd: () => setSpeaking(false) });
    queue.enqueue({ id: 'demo', runs });
  };

  const testMic = async () => {
    setMicState({ label: 'Microphone', state: 'checking', detail: 'Requesting permission…' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const label = stream.getAudioTracks()[0]?.label || 'default input';
      stream.getTracks().forEach((t) => t.stop());
      setMicState({ label: 'Microphone', state: 'ok', detail: label });
    } catch (err) {
      setMicState({
        label: 'Microphone',
        state: 'fail',
        detail: err instanceof Error ? err.message : 'Permission denied',
        fix: 'Allow microphone access for this site, then run the check again.',
      });
    }
  };

  const voicesMissing = voiceRows.filter((r) => r.state === 'fail');

  return (
    <Shell
      title="Pre-flight check"
      subtitle="Run this on the teaching machine before the class arrives"
      right={
        <Link to="/" className="text-sm text-ink-300 underline hover:text-ink-100">
          Home
        </Link>
      }
    >
      <Card className="mb-5 p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink-200">This browser and machine</h2>
        <div className="space-y-2">
          {rows.map((r) => (
            <StatusRow key={r.label} row={r} />
          ))}
          {micState && <StatusRow row={micState} />}
        </div>
        {!micState && (
          <Button size="sm" className="mt-3" onClick={testMic}>
            Test the microphone
          </Button>
        )}
      </Card>

      <Card className="mb-5 p-5">
        <h2 className="mb-1 text-sm font-semibold text-ink-200">Voices</h2>
        <p className="mb-3 text-xs text-ink-400">
          Synthesis reports success for a language it has no voice for and then produces
          nothing, so a lecture can look like it is working while students hear silence.
        </p>
        <div className="space-y-2">
          {voiceRows.length === 0 && <p className="text-sm text-ink-500">Loading voices…</p>}
          {voiceRows.map((r) => (
            <StatusRow key={r.label} row={r} />
          ))}
        </div>

        {voicesMissing.length > 0 && (
          <div className="mt-4 rounded-lg border border-live-500/40 bg-live-500/5 p-3">
            <p className="text-sm font-medium text-live-500">
              {voicesMissing.length} language
              {voicesMissing.length === 1 ? '' : 's'} will have no audio
            </p>
            <p className="mt-1.5 text-xs text-ink-300">
              Subtitles and term highlighting still work, and the student is told plainly. To
              get audio on Windows: <strong>Settings → Time &amp; language → Language &amp;
              region → Add a language</strong>, tick <strong>Speech</strong> in the optional
              features, then restart the browser. Chrome also supplies network voices for many
              languages when it is online and signed in.
            </p>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 text-sm font-semibold text-ink-200">Hear the real thing</h2>
        <p className="mb-3 text-xs text-ink-400">
          The actual output shape: explanation in Hindi, terms in English, two voices in one
          sentence. If this sounds right, the feature works.
        </p>
        <p className="mb-4 text-lg" lang="hi" data-lang="hi">
          <RunText
            runs={[
              { lang: 'hi', text: 'तो इस ', isTerm: false },
              { lang: 'en', text: 'matrix', isTerm: true },
              { lang: 'hi', text: ' का ', isTerm: false },
              { lang: 'en', text: 'eigenvalue', isTerm: true },
              { lang: 'hi', text: ' हमें बताता है कि ', isTerm: false },
              { lang: 'en', text: 'eigenvector', isTerm: true },
              { lang: 'hi', text: ' कितना खिंचता है।', isTerm: false },
            ]}
          />
        </p>
        <Button variant="primary" onClick={demo} disabled={speaking}>
          {speaking ? 'Speaking…' : '▶ Play'}
        </Button>
      </Card>
    </Shell>
  );
}

function StatusRow({ row }: { row: Row }) {
  const tone = { checking: 'neutral', ok: 'ok', warn: 'warn', fail: 'live' } as const;
  const mark = { checking: '…', ok: '✓', warn: '!', fail: '✕' }[row.state];

  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
      <Badge tone={tone[row.state]}>{mark}</Badge>
      <span className="min-w-0 flex-1">
        <span className="text-sm font-medium text-ink-100">{row.label}</span>
        <span className="ml-2 text-sm text-ink-400">{row.detail}</span>
        {row.fix && <span className="mt-0.5 block text-xs text-brand-400">{row.fix}</span>}
      </span>
    </div>
  );
}
