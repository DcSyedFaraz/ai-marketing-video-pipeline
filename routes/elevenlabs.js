// ── ElevenLabs Audio Generation Routes ───────────────────────────────────────
// GET  /api/elevenlabs/voices          — List filtered voices
// POST /api/elevenlabs/generate-script — Generate script via Claude
// POST /api/elevenlabs/tts             — Generate audio via ElevenLabs TTS

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

const router = Router();

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const EL_BASE = 'https://api.elevenlabs.io/v1';

// ── Fallback voice list (used when no API key or fetch fails) ─────────────────
// These are stable ElevenLabs premade voices with known IDs
const FALLBACK_VOICES = [
  { voiceId: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel',  gender: 'female', age: 'young',        description: 'calm, clear',       useCase: 'narration',     previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/21m00Tcm4TlvDq8ikWAM/df6788f9-5c96-470d-8312-aab3b3d8f50a.mp3' },
  { voiceId: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi',    gender: 'female', age: 'young',        description: 'strong, confident', useCase: 'narration',     previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/AZnzlk1XvdvUeBnXmlld/69c5c8f7-b4b3-490b-9d4d-e56c8cc2e4f5.mp3' },
  { voiceId: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',   gender: 'female', age: 'young',        description: 'soft, friendly',    useCase: 'narration',     previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/04a2e90b-6194-4c21-9f24-1908e0f2c95e.mp3' },
  { voiceId: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli',    gender: 'female', age: 'young',        description: 'emotional, lively', useCase: 'narration',     previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/MF3mGyEYCl7XYWbV9V6O/f9fd64c3-5d62-45cd-b0dc-ad722ee3284e.mp3' },
  { voiceId: 'LcfcDJNUP1GQjkzn1xUU', name: 'Emily',   gender: 'female', age: 'young',        description: 'calm, warm',        useCase: 'audiobook',     previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/LcfcDJNUP1GQjkzn1xUU/e4b994b7-9713-4238-bfef-d42e7b0d35fe.mp3' },
  { voiceId: 'ErXwobaYiN019PkySvjV', name: 'Antoni',  gender: 'male',   age: 'young',        description: 'well-rounded',      useCase: 'narration',     previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/ErXwobaYiN019PkySvjV/f4f20ea5-45bf-4c0a-b5d1-b5c1a0c09cc9.mp3' },
  { voiceId: 'GBv7mTt0atIp3Br8iCZE', name: 'Thomas',  gender: 'male',   age: 'young',        description: 'calm, meditative',  useCase: 'meditation',    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/GBv7mTt0atIp3Br8iCZE/98542988-5267-4148-9a9e-baa8c4cf2d02.mp3' },
  { voiceId: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam',   gender: 'male',   age: 'young',        description: 'energetic, social media', useCase: 'conversational', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/ac833b71-8f7c-4f99-bc84-a4b3e62f6e71.mp3' },
  { voiceId: 'SOYHLrjzK2X1ezoPC6cr', name: 'Harry',  gender: 'male',   age: 'young',        description: 'fierce, animated',  useCase: 'narration',     previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/SOYHLrjzK2X1ezoPC6cr/830f1d2b-2f3c-4b72-bf8a-e29b7deb3b6e.mp3' },
  { voiceId: 'bIHbv24MWmeRgasZH58o', name: 'Will',   gender: 'male',   age: 'young',        description: 'relaxed, conversational', useCase: 'conversational', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/bIHbv24MWmeRgasZH58o/e8e7b773-f891-4f8d-9c72-fec53df168e0.mp3' },
  { voiceId: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', gender: 'male',   age: 'young',        description: 'Australian, confident', useCase: 'conversational', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/IKne3meq5aSn9XLyUdCD/86a2b298-6253-4e89-9a22-e7f55e6d2c52.mp3' },
  { voiceId: '2EiwWnXFnvU5JabPnv8n', name: 'Clyde',   gender: 'male',   age: 'middle_aged',  description: 'war veteran, deep', useCase: 'narration',     previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/2EiwWnXFnvU5JabPnv8n/65d80f52-703f-4cae-a91d-75d4e200ed02.mp3' },
  { voiceId: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel',  gender: 'male',   age: 'middle_aged',  description: 'authoritative, news', useCase: 'news',         previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/onwK4e9ZLuTAKqWW03F9/7eee0236-1a72-4b86-b303-5dcadc007ba9.mp3' },
];

// ── Pacing → words per minute ─────────────────────────────────────────────────
const PACING_WPM = { slow: 100, natural: 130, fast: 160 };

// ── Energy level → tone instruction ──────────────────────────────────────────
const ENERGY_TONE = {
  calm:     'Keep the tone relaxed, grounded, and conversational — like a friend sharing advice.',
  moderate: 'Keep the tone confident and engaging — enthusiastic but not over the top.',
  high:     'Keep the tone energetic and exciting — drive urgency and excitement forward.',
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
    console.log('[ElevenLabs] No API key — returning fallback voice list');
    return res.json({ voices: FALLBACK_VOICES, source: 'fallback' });
  }

  try {
    const response = await fetch(`${EL_BASE}/voices`, {
      headers: { 'xi-api-key': ELEVENLABS_KEY },
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn(`[ElevenLabs] Voices API error ${response.status}: ${text}`);
      return res.json({ voices: FALLBACK_VOICES, source: 'fallback' });
    }

    const data = await response.json();
    const allVoices = data.voices || [];

    // Filter to relevant voices: young/middle-aged, conversational/podcast/gaming/narration use cases
    const ALLOWED_USE_CASES = new Set(['narration', 'gaming', 'podcast', 'entertainment', 'conversational', 'news', 'video_games']);
    const ALLOWED_AGES      = new Set(['young', 'middle_aged']);
    const ALLOWED_DESCS     = new Set(['energetic', 'natural', 'casual', 'confident', 'friendly', 'expressive', 'warm', 'clear', 'lively']);

    const filtered = allVoices.filter(v => {
      if (v.category === 'cloned') return false; // skip user-cloned voices
      const labels = v.labels || {};
      const useCase = (labels.use_case || '').toLowerCase();
      const age     = (labels.age     || '').toLowerCase().replace(/\s+/g, '_');
      const desc    = (labels.description || '').toLowerCase();
      return ALLOWED_USE_CASES.has(useCase) || ALLOWED_AGES.has(age) || ALLOWED_DESCS.has(desc);
    });

    // Map to clean shape
    const voices = filtered.slice(0, 40).map(v => ({
      voiceId:    v.voice_id,
      name:       v.name,
      gender:     (v.labels?.gender      || '').toLowerCase() || 'unknown',
      age:        (v.labels?.age         || '').toLowerCase().replace(/\s+/g, '_') || 'unknown',
      description:(v.labels?.description || v.labels?.accent || '').toLowerCase(),
      useCase:    (v.labels?.use_case    || '').toLowerCase().replace(/\s+/g, '_'),
      previewUrl: v.preview_url || null,
    }));

    console.log(`[ElevenLabs] Returning ${voices.length} filtered voices from API`);
    res.json({ voices, source: 'api' });

  } catch (err) {
    console.error(`[ElevenLabs] Voices fetch error: ${err.message}`);
    res.json({ voices: FALLBACK_VOICES, source: 'fallback' });
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

  if (!topic) {
    return res.status(400).json({ error: 'Topic/description is required.' });
  }

  const wpm       = PACING_WPM[pacing] || 130;
  const wordBudget = Math.round((duration / 60) * wpm);
  const contentRule = CONTENT_RULES[contentType] || CONTENT_RULES.podcast;
  const energyRule  = ENERGY_TONE[energy] || ENERGY_TONE.moderate;

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

UNIVERSAL RULES:
- No filler words: um, uh, well, so, basically, literally, actually, right
- No speaker labels, no asterisks, no parenthetical directions
- Sentences 8–15 words for natural breath grouping
- Start with a strong hook: a bold question, vivid statement, or surprising fact
- Punctuation handles pauses — don't add extra ellipses or dashes unless natural
- Word budget: exactly ${wordBudget} words (±5 words allowed)
- Count your words before returning. If over budget, trim. If under by more than 5, add.
${v3TagsSection}
OUTPUT FORMAT:
Return ONLY the script text. No JSON, no labels, no quotes, no preamble.`;

  const userPrompt = topic
    ? `Write a ${duration}-second ${contentType} script about: ${topic}`
    : `Write a ${duration}-second ${contentType} script. Make it engaging and natural.`;

  console.log(`[ElevenLabs] Generating script — type:${contentType} duration:${duration}s pacing:${pacing} energy:${energy} v:${apiVersion} budget:${wordBudget}w`);

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
