// ── ElevenLabs Audio Generation Routes ───────────────────────────────────────
// GET  /api/elevenlabs/voices          — List filtered voices
// POST /api/elevenlabs/generate-script — Generate script via Claude
// POST /api/elevenlabs/tts             — Generate audio via ElevenLabs TTS

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

const router = Router();

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const EL_BASE = 'https://api.elevenlabs.io/v1';

// ─── Load marketing angles once at startup ────────────────────────────────────
let MARKETING_ANGLES_DATA = null;
try {
  const maPath = path.resolve('public', 'marketing_angles.json');
  if (existsSync(maPath)) {
    MARKETING_ANGLES_DATA = JSON.parse(readFileSync(maPath, 'utf8'));
    console.log(`[ElevenLabs] Loaded ${MARKETING_ANGLES_DATA.marketing_angles?.length ?? 0} marketing angles`);
  } else {
    console.log('[ElevenLabs] No marketing_angles.json found — angle enrichment disabled');
  }
} catch (e) {
  console.warn(`[ElevenLabs] Failed to load marketing_angles.json: ${e.message}`);
}

// ── Pacing → words per minute ─────────────────────────────────────────────────
const PACING_WPM = { slow: 100, natural: 130, fast: 160 };

// ── Energy level → tone instruction ──────────────────────────────────────────
const ENERGY_TONE = {
  calm:     'Keep the tone warm and grounded — like a trusted friend sharing advice. Relaxed but never flat or lifeless.',
  moderate: 'Keep the tone upbeat and lively — naturally enthusiastic, like someone genuinely excited to share something. Not over-the-top, but clearly energised and engaged. Avoid dull, flat, or monotone phrasing.',
  high:     'Keep the tone high-energy and exciting — urgent, punchy, and electrifying. Drive real excitement and momentum in every line.',
};

// ── Content type tone rules ───────────────────────────────────────────────────
const CONTENT_RULES = {
  game:        'Write in energetic, punchy sentences. Use second-person perspective ("You\'re one move away..."). Build competitive excitement and urgency. Short, impactful lines.',
  podcast:     'Write in a conversational, first-person style. Start with "Hey" or a relatable opener. Natural flow with personal tone, as if talking to a close friend.',
  ad:          'Structure: attention-grabbing hook → clear value proposition → strong call to action. Max 2 sentences per section. Be direct and persuasive.',
  educational: 'Be clear, friendly, and structured. Use signpost phrases ("First...", "Here\'s the thing...", "The key takeaway..."). Make complex ideas feel simple.',
  story:       'Write in present tense with vivid action verbs. Build a narrative arc. Draw the listener in with specific sensory details.',
};

// ── GET /api/elevenlabs/voices ────────────────────────────────────────────────
router.get('/api/elevenlabs/voices', async (req, res) => {
  if (!ELEVENLABS_KEY) {
    return res.status(400).json({ voices: [], error: 'ElevenLabs API key is not configured. Add ELEVENLABS_API_KEY to your .env file.' });
  }

  try {
    const response = await fetch(`${EL_BASE}/voices`, {
      headers: { 'xi-api-key': ELEVENLABS_KEY },
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn(`[ElevenLabs] Voices API error ${response.status}: ${text}`);
      return res.status(response.status).json({ voices: [], error: `ElevenLabs API error ${response.status}` });
    }

    const data = await response.json();
    const allVoices = data.voices || [];

    // Keep all non-cloned voices that have a preview URL (guarantees working previews)
    const filtered = allVoices.filter(v => v.category !== 'cloned' && v.preview_url);

    const voices = filtered.map(v => ({
      voiceId:    v.voice_id,
      name:       v.name,
      gender:     (v.labels?.gender      || '').toLowerCase() || 'unknown',
      age:        (v.labels?.age         || '').toLowerCase().replace(/\s+/g, '_') || 'unknown',
      description:(v.labels?.description || v.labels?.accent || '').toLowerCase(),
      useCase:    (v.labels?.use_case    || '').toLowerCase().replace(/\s+/g, '_'),
      previewUrl: v.preview_url,
    }));

    console.log(`[ElevenLabs] Returning ${voices.length} voices from API`);
    res.json({ voices, source: 'api' });

  } catch (err) {
    console.error(`[ElevenLabs] Voices fetch error: ${err.message}`);
    res.status(500).json({ voices: [], error: `Failed to fetch voices: ${err.message}` });
  }
});

// ── POST /api/elevenlabs/generate-script ──────────────────────────────────────
router.post('/api/elevenlabs/generate-script', async (req, res) => {
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on this server.' });
  }

  const contentType = (req.body.contentType || 'podcast').toLowerCase();
  const topic       = (req.body.topic || '').trim().slice(0, 500);
  const duration    = Math.min(Math.max(parseInt(req.body.duration) || 30, 10), 120);
  const pacing      = (req.body.pacing || 'natural').toLowerCase();
  const energy      = (req.body.energy || 'moderate').toLowerCase();
  const apiVersion  = (req.body.apiVersion || 'v2').toLowerCase(); // 'v2' or 'v3'
  const angleIdRaw  = req.body.angleId;
  const angleId     = angleIdRaw != null ? Number(angleIdRaw) : null;

  // Resolve angle object if provided
  const angle = (angleId !== null && MARKETING_ANGLES_DATA)
    ? (MARKETING_ANGLES_DATA.marketing_angles?.find(a => a.id === angleId) ?? null)
    : null;

  if (!topic && angle === null) {
    return res.status(400).json({ error: 'Topic/description is required, or select a marketing angle.' });
  }

  const wpm       = PACING_WPM[pacing] || 130;
  const wordBudget = Math.round((duration / 60) * wpm);
  const contentRule = CONTENT_RULES[contentType] || CONTENT_RULES.podcast;
  const energyRule  = ENERGY_TONE[energy] || ENERGY_TONE.moderate;

  // ── Game context (always injected when data is available) ────────────────────
  let gameContext = '';
  if (MARKETING_ANGLES_DATA?.game) {
    const g = MARKETING_ANGLES_DATA.game;
    const tiers = Array.isArray(g.ranked_tiers) ? g.ranked_tiers.join(' → ') : '';
    const platforms = Array.isArray(g.platforms) ? g.platforms.join(', ') : '';
    gameContext = `
GAME CONTEXT:
Game: ${g.title || ''}
Genre: ${g.genre || ''}
Format: ${g.format || ''}
Match Duration: ~${g.match_duration_minutes ?? '?'} minutes
${tiers ? `Ranked Tiers: ${tiers}` : ''}
${platforms ? `Platforms: ${platforms}` : ''}
`.trim();
  }

  // ── Marketing angle context (only when angle selected) ───────────────────────
  let angleContext = '';
  if (angle) {
    const emotionalList = Array.isArray(angle.emotional_territory)
      ? angle.emotional_territory.join(', ')
      : String(angle.emotional_territory || '');
    const creativeList = Array.isArray(angle.creative_directions)
      ? angle.creative_directions.map((d, i) => `${i + 1}. ${d}`).join('\n')
      : '';
    const messagingList = Array.isArray(angle.messaging_examples)
      ? angle.messaging_examples.map(m => `- "${m}"`).join('\n')
      : '';
    const formatStyle = angle.format?.style || '';

    angleContext = `
MARKETING ANGLE: ${angle.name}
CORE MESSAGE: ${angle.core_message}
EMOTIONAL TERRITORY: ${emotionalList}
VISUAL/STYLE REFERENCE (for tone only — this is audio): ${formatStyle}

CREATIVE DIRECTIONS (choose one as the narrative spine):
${creativeList}

APPROVED MESSAGING EXAMPLES (use as inspiration, not verbatim):
${messagingList}

The script must embody the emotional territory above. Every line should serve the core message.`;
  }

  const v3TagsSection = apiVersion === 'v3' ? `
V3 EXPRESSION TAGS (use sparingly — max 2-3 per script):
CRITICAL RESTRICTION: Only use tags that affect HOW words are spoken (delivery tone).
NEVER use non-verbal sound tags — they produce sounds that break lip-sync on avatar models.

ALLOWED (speech delivery tags only):
- [dramatic pause] — brief silence before a key point or CTA
- [excited] — higher energy on the following sentence
- [calm] — softer, slower delivery for the following sentence
- [angry] — sharper, more forceful delivery for the following sentence

FORBIDDEN (these produce non-verbal sounds that break lip-sync, never use them):
- [laughs], [chuckles], [giggles], [sighs], [exhales], [gasps], [inhales], [crying]

Place tag inline before the sentence it affects.
Example: "You've been grinding for weeks. [excited] This is the moment everything changes."
` : `
Do NOT include any expression tags, brackets, stage directions, or markup of any kind.
`;

  const systemPrompt = `You write concise, natural-sounding audio scripts for AI avatar videos. The audio will drive a lip-sync avatar, so the script must consist entirely of spoken words — no stage directions, no markup (unless v3 tags are explicitly allowed), no sound effects.

CONTENT TYPE: ${contentType.toUpperCase()}
${contentRule}

ENERGY & TONE:
${energyRule}
${gameContext ? `\n${gameContext}\n` : ''}${angleContext ? `\n${angleContext}\n` : ''}
UNIVERSAL RULES:
- No filler words: um, uh, well, so, basically, literally, actually, right
- No speaker labels, no asterisks, no parenthetical directions
- Sentences 8–15 words for natural breath grouping
- Start with a strong hook: a bold question, vivid statement, or surprising fact
- Punctuation handles pauses — don't add extra ellipses or dashes unless natural
- Word budget: exactly ${wordBudget} words (±5 words allowed)
- Count your words before returning. If over budget, trim. If under by more than 5, add.
- CRITICAL: The script must feel alive and engaging. Avoid passive, flat, or overly formal phrasing. Word choices should carry natural energy — use active verbs, punchy sentences, and phrases a real enthusiastic person would say out loud.
${v3TagsSection}
OUTPUT FORMAT:
Return ONLY the script text. No JSON, no labels, no quotes, no preamble.`;

  let userPrompt;
  if (angle) {
    const topicAddendum = topic ? ` Additional context from creator: ${topic}` : '';
    userPrompt = `Write a ${duration}-second ${contentType} script for the "${angle.name}" marketing angle.${topicAddendum}`;
  } else {
    userPrompt = topic
      ? `Write a ${duration}-second ${contentType} script about: ${topic}`
      : `Write a ${duration}-second ${contentType} script. Make it engaging and natural.`;
  }

  const angleLabel = angle ? `angle:"${angle.name}"` : 'no-angle';
  console.log(`[ElevenLabs] Generating script — type:${contentType} ${angleLabel} duration:${duration}s pacing:${pacing} energy:${energy} v:${apiVersion} budget:${wordBudget}w`);

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      temperature: 1,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    let script = message.content[0]?.text?.trim() || '';

    // Strip any accidental JSON wrapping or code fences
    if (script.startsWith('```')) {
      script = script.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    }
    if (script.startsWith('"') && script.endsWith('"')) {
      script = script.slice(1, -1);
    }

    const wordCount = script.split(/\s+/).filter(Boolean).length;
    const estimatedDuration = Math.round((wordCount / wpm) * 60);

    console.log(`[ElevenLabs] Script generated: ${wordCount} words (~${estimatedDuration}s)`);
    res.json({ script, wordCount, estimatedDuration });

  } catch (err) {
    console.error(`[ElevenLabs] Script generation error: ${err.message}`);
    res.status(500).json({ error: `Script generation failed: ${err.message}` });
  }
});

// ── POST /api/elevenlabs/tts ──────────────────────────────────────────────────
router.post('/api/elevenlabs/tts', async (req, res) => {
  if (!ELEVENLABS_KEY) {
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY is not configured on this server.' });
  }

  const script         = (req.body.script || '').trim();
  const voiceId        = (req.body.voiceId || '').trim();
  const apiVersion     = (req.body.apiVersion || 'v2').toLowerCase();
  const stability      = Math.min(Math.max(parseFloat(req.body.stability      ?? 0.5),  0), 1);
  const similarityBoost= Math.min(Math.max(parseFloat(req.body.similarityBoost?? 0.75), 0), 1);
  const style          = Math.min(Math.max(parseFloat(req.body.style          ?? 0.3),  0), 1);

  if (!script) return res.status(400).json({ error: 'Script text is required.' });
  if (!voiceId) return res.status(400).json({ error: 'Voice ID is required.' });

  const modelId = apiVersion === 'v3' ? 'eleven_v3' : 'eleven_multilingual_v2';

  const body = {
    text: script,
    model_id: modelId,
    voice_settings: {
      stability,
      similarity_boost: similarityBoost,
      ...(apiVersion === 'v3' ? { style, use_speaker_boost: true } : {}),
    },
  };

  console.log(`\n[ElevenLabs] TTS ─────────────────────────────────`);
  console.log(`[ElevenLabs]  Voice   : ${voiceId}`);
  console.log(`[ElevenLabs]  Model   : ${modelId}`);
  console.log(`[ElevenLabs]  Script  : ${script.slice(0, 80)}${script.length > 80 ? '…' : ''}`);
  console.log(`[ElevenLabs]  Settings: stability=${stability} similarityBoost=${similarityBoost}${apiVersion === 'v3' ? ` style=${style}` : ''}`);

  try {
    const response = await fetch(`${EL_BASE}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      let detail = text;
      try { detail = JSON.parse(text)?.detail?.message || text; } catch {}
      console.error(`[ElevenLabs] TTS API error ${response.status}: ${detail}`);
      return res.status(response.status).json({ error: `ElevenLabs TTS error: ${detail}` });
    }

    // Save audio to uploads/
    const arrayBuf = await response.arrayBuffer();
    const audioBuf = Buffer.from(arrayBuf);
    const filename = `el_${Date.now()}-${randomUUID().slice(0, 8)}.mp3`;
    const outPath  = path.join('uploads', filename);
    await writeFile(outPath, audioBuf);

    console.log(`[ElevenLabs] ✅ Audio saved: ${outPath} (${(audioBuf.length / 1024).toFixed(1)} KB)`);
    res.json({ audioPath: `/uploads/${filename}`, filename });

  } catch (err) {
    console.error(`[ElevenLabs] TTS error: ${err.message}`);
    res.status(500).json({ error: `TTS generation failed: ${err.message}` });
  }
});

export default router;
