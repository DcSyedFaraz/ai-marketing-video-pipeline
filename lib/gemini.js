// ── Claude AI Scene Planner ───────────────────────────────────────────────────
// Uses Claude claude-sonnet-4-6 to break a story into scenes with image + video prompts.
// Only used for Step 1 of the Story pipeline (planning).
// Accepts optional hero and background reference images — Claude sees them
// and decides per-scene whether Nano Bana 2 should use them as referenceImages.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import path from 'path';
import sharp from 'sharp';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude's 5 MB limit

/** Snap a value to the nearest allowed duration. */
function snapToAllowed(val, allowed) {
  if (!allowed || allowed.length === 0) return val;
  return allowed.reduce((best, d) => Math.abs(d - val) < Math.abs(best - val) ? d : best, allowed[0]);
}

/** Get mime type from file extension. */
function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

/** Detect actual mime type from buffer magic bytes. */
function detectMime(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  return 'image/jpeg'; // fallback
}

/**
 * Ensure image buffer is under Claude's 5 MB limit.
 * Returns { buffer, mime } — mime is always detected from actual buffer content.
 */
async function ensureUnder5MB(inputBuffer, label) {
  if (inputBuffer.length <= MAX_IMAGE_BYTES) {
    const mime = detectMime(inputBuffer);
    return { buffer: inputBuffer, mime };
  }

  console.log(`[Claude] ${label} is ${(inputBuffer.length / 1024 / 1024).toFixed(1)} MB — compressing to fit under 5 MB...`);

  // Step 1: Try JPEG quality reduction (100 → 80 → 60 → 40)
  for (const quality of [80, 60, 40]) {
    const compressed = await sharp(inputBuffer).jpeg({ quality }).toBuffer();
    if (compressed.length <= MAX_IMAGE_BYTES) {
      console.log(`[Claude] ${label} compressed to ${(compressed.length / 1024 / 1024).toFixed(1)} MB at quality ${quality}`);
      return { buffer: compressed, mime: 'image/jpeg' };
    }
  }

  // Step 2: Scale down dimensions progressively (75% → 50% → 35% → 25%)
  const meta = await sharp(inputBuffer).metadata();
  for (const scale of [0.75, 0.5, 0.35, 0.25]) {
    const w = Math.round((meta.width || 1920) * scale);
    const compressed = await sharp(inputBuffer).resize({ width: w }).jpeg({ quality: 60 }).toBuffer();
    if (compressed.length <= MAX_IMAGE_BYTES) {
      console.log(`[Claude] ${label} resized to ${w}px wide — ${(compressed.length / 1024 / 1024).toFixed(1)} MB`);
      return { buffer: compressed, mime: 'image/jpeg' };
    }
  }

  // Last resort: smallest possible
  const fallback = await sharp(inputBuffer).resize({ width: 512 }).jpeg({ quality: 40 }).toBuffer();
  console.warn(`[Claude] ${label} fallback to 512px — ${(fallback.length / 1024 / 1024).toFixed(1)} MB`);
  return { buffer: fallback, mime: 'image/jpeg' };
}

/**
 * Plan scenes from a story using Claude claude-sonnet-4-6.
 * @param {string}   storyText        — The story/script to decompose
 * @param {number}   sceneCount       — Desired number of scenes
 * @param {string}   gameContext      — Game/brand context
 * @param {string}   voiceDesc        — Voice description (optional — Claude generates one if empty)
 * @param {string}   heroDesc         — Hero character text description
 * @param {object}   images           — { heroImagePath, backgroundImagePath } (optional file paths)
 * @param {number[]} allowedDurations — exact allowed durations from the selected video model (e.g. [4,6,8])
 * @returns {Promise<{scenes: Array, voiceOverCharacteristics: string}>}
 */
export async function planScenes(storyText, sceneCount, gameContext, voiceDesc, heroDesc, images = {}, allowedDurations = []) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env');

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const heroImagePaths = Array.isArray(images.heroImagePath)
    ? images.heroImagePath.filter(Boolean)
    : (images.heroImagePath ? [images.heroImagePath] : []);
  const heroCount = heroImagePaths.length;
  const hasHeroImage = heroCount > 0;
  const hasMultipleHeroes = heroCount > 1;
  const hasBgImage = !!images.backgroundImagePath;

  const voiceInstruction = voiceDesc
    ? `The user provided this voice-over style — use it exactly: "${voiceDesc}"`
    : `The user did NOT provide a voice description. You MUST generate a "voiceOverCharacteristics" field using this EXACT format with all 5 elements:

"He/She says in the voice of a [AGE] [GENDER], [TIMBRE], [TONE], [PACING]"

The 5 essential elements:
1. AGE — approximate age range (young, middle-aged, elderly, teenage, mature)
2. GENDER — voice register (man, woman, boy, girl)
3. TIMBRE — physical quality of the voice (deep gentle voice, warm measured voice, sharp clear voice, bright voice, gravelly voice, smooth voice)
4. TONE — emotional quality/attitude (confident tone, urgent whisper, commanding tone, intense tone, matter-of-fact tone)
5. PACING — how fast or slow they speak (slow thoughtful pacing, deliberate pacing, moderate pacing, faster pacing, measured pacing)

Example: "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing"
The voice must sound like it belongs in a AAA game trailer — confident, commanding, exciting, selling the game.`;

  const heroRefText = hasMultipleHeroes
    ? `- ${heroCount} HERO reference images have been provided (see attached). Each image represents a DISTINCT character. Study every hero carefully — note each character's exact appearance, outfit, colors, proportions, art style. The story features MULTIPLE characters and scenes may include any combination of them.`
    : (hasHeroImage
      ? '- A single HERO reference image has been provided (see attached). Study it carefully — note the character\'s exact appearance, outfit, colors, proportions, art style. The ENTIRE story revolves around this ONE hero. CRITICAL IMAGE RULE: image prompts must contain ONLY this hero character and NOTHING ELSE. Absolutely NO teammates, partners, allies, silhouettes, shadowed figures, or background characters of any kind — even if the story mentions a teammate. A teammate\'s presence may only be implied through environmental cues (dust trails, energy residue, off-screen sound cues in the video prompt), but ZERO additional human/character figures may appear in any image frame.'
      : '');

  const imageRefInstruction = (hasHeroImage || hasBgImage)
    ? `
REFERENCE IMAGES:
${heroRefText}
${hasBgImage ? '- A BACKGROUND reference image has been provided (see attached). Study it carefully — note the environment style, colors, atmosphere, art direction.' : ''}

For EACH scene, you must decide whether the AI image generator should use the reference images to maintain visual consistency. Set "useHeroRef" and/or "useBgRef" to true when:
- The scene features the hero character prominently → useHeroRef: true
- The scene's environment should match the background style → useBgRef: true
- The CTA/final scene should typically use BOTH references
Set them to false when the scene intentionally shows something different (e.g. a villain's lair with no hero visible).`
    : `
REFERENCE IMAGES: None provided. Set "useHeroRef" and "useBgRef" to false for all scenes.`;

  const systemPrompt = `You are a professional video storyboard planner for a mobile game marketing team.
Your job: take a story/script and break it into exactly ${sceneCount} scenes, each with a detailed image prompt and video prompt.

CONTEXT:
- Game/Brand: ${gameContext || 'A mobile game'}
- Hero Character: ${heroDesc || 'A stylized game character'}

VOICE-OVER:
${voiceInstruction}
${imageRefInstruction}

RULES FOR IMAGE PROMPTS:
- Each imagePrompt must be a highly detailed text-to-image prompt for Nano Bana 2 (google:4@3)
- Images will be generated at 3072×5504 (portrait 9:16)
${hasMultipleHeroes
  ? '- When useHeroRef is true, describe the hero(es) in the scene matching their respective reference images exactly (same outfit, colors, style, proportions for each character)'
  : (hasHeroImage ? '- When useHeroRef is true, describe the hero matching the reference image exactly (same outfit, colors, style, proportions)' : '- Include the hero character description in the image prompt')}
${hasBgImage ? '- When useBgRef is true, describe the environment matching the background reference (same art style, palette, atmosphere)' : ''}
- Include game art style, lighting, composition, mood
- CRITICAL VARIETY: Each scene image MUST use a DIFFERENT camera angle — cycle through: extreme close-up (face/hands detail), low-angle hero shot (looking up), high-angle bird's eye, wide establishing shot, over-the-shoulder POV, dramatic Dutch angle, profile silhouette, macro detail shot. NEVER repeat the same angle in consecutive scenes.
- Be specific about camera angle, framing, background elements

IMPORTANT — IMAGE GENERATION FLOW (sequential video pipeline):
Videos are generated SEQUENTIALLY. Each video's first frame is extracted from the PREVIOUS video's actual last frame using FFmpeg. This creates pixel-perfect seamless transitions. Image prompts serve as END frames for each scene's video.

- SCENE 1 (first scene): You MUST provide TWO image prompts:
  1. "imagePrompt" — the OPENING frame (frame A). This is where the entire video ad begins. Make it a strong, attention-grabbing shot.
  2. "imageBPrompt" — the END frame (frame B). Scene 1's video animates from frame A → frame B. This determines what the first scene ends on, and its actual last video frame will be extracted and used as the first frame of scene 2.
- MIDDLE SCENES (scenes 2 to ${sceneCount - 1}): Provide only ONE "imagePrompt" each — this is the END frame the video animates toward. The first frame comes automatically from the previous video's last frame (extracted via FFmpeg). So each middle scene's imagePrompt should describe what this scene ENDS on.
- LAST SCENE (scene ${sceneCount}): Provide ONLY "ctaImagePrompt" — NO "imagePrompt". The first frame comes from the 2nd-to-last video's extracted last frame. The video animates from that extracted frame into the CTA frame.
  "ctaImagePrompt" — the CTA (call-to-action) frame: "Download Now" button, app store badges, game logo prominently displayed, stylized game art background. This is the END frame the last scene's video transitions INTO.

RULES FOR VIDEO PROMPTS:
- Each videoPrompt will be used with a video generation model (Veo 3.1 or similar)
- SEQUENTIAL FRAME PIPELINE: Scene 1 uses its imagePrompt (frame A) as first frame and imageBPrompt (frame B) as last frame. Scenes 2+ use the ACTUAL last frame extracted from the previous video as their first frame, and their own imagePrompt as the last frame. Last scene uses extracted frame → CTA image. This means each scene's video should describe motion FROM the previous scene's visual ending INTO this scene's target image.
- CRITICAL VOICE FORMAT: EVERY videoPrompt MUST start with the voice-over in this EXACT format:
  He/She says in the voice of a [AGE] [GENDER], [TIMBRE], [TONE], [PACING]: "dialogue here"
  The 5 voice elements (AGE, GENDER, TIMBRE, TONE, PACING) must be IDENTICAL across ALL scenes — copy-paste the same string every time. Only the dialogue inside the quotes changes per scene.
- DIALOGUE RULES (the text inside the quotes):
  * Must be a sales pitch — hype the game, create urgency, make the viewer want to download NOW
  * Use power words: "dominate", "unstoppable", "epic", "legendary", "claim your throne", "rise to glory"
  * MUST FIT the scene's duration: ~2-3 words per second. A 4s scene = max 10 words. A 6s scene = max 16 words. An 8s scene = max 22 words. NEVER exceed this — incomplete sentences sound terrible.
  * Build a narrative arc across scenes: hook → excitement → climax → CTA. Each scene's dialogue flows naturally to the next.
  * Last scene (CTA): must end with a clear call-to-action like "Download now and claim your destiny!" or "Play free today!"
- FAST PACING (CRITICAL): Every video clip MUST feel like a high-octane TikTok game ad — never slow, never cinematic, never lingering. Use only rapid, aggressive camera movements: snap zoom, whip pan, fast dolly punch-in, explosive push-in, speed-ramped tracking shot. If a camera movement takes more than 1 second to complete, it is TOO SLOW — replace it with something faster. NO slow pans, NO cinematic eases, NO peaceful drone shots, NO slow reveals. Every frame must demand the viewer's attention. Think: blink-and-you-miss-it energy.
- SMOOTH TRANSITIONS: Each scene's video should end with a natural visual transition — camera pushes through a portal/doorway, motion blur into the next shot, particle effect wipe, dramatic zoom that dissolves into the next scene. This ensures scenes flow together seamlessly when concatenated.
- VARIED CAMERA MOVEMENT: Each scene MUST use a DIFFERENT camera technique — never repeat the same movement in consecutive scenes. Cycle through: fast dolly zoom, orbital camera sweep, crane shot rising/descending, whip pan left/right, tracking shot alongside character, snap zoom from wide to close-up, dramatic pullback reveal.
- After the voice line, include: camera movement, scene action, sound effects, audio/mood
- Keep video prompts under 600 characters

CHARACTER RULES (apply to BOTH imagePrompt and videoPrompt):
${hasMultipleHeroes
  ? `- ${heroCount} distinct hero characters are defined — scenes may feature one, some, or all of them as the story demands
- Each hero's design is individually LOCKED — do NOT alter any hero's outfit, colors, proportions, or style
- NO characters beyond the provided heroes — NO random soldiers, civilians, or bystanders`
  : `- ONLY the defined hero character may appear in image prompts — ZERO other visible characters, even as blurry background figures, partial silhouettes, or "barely visible" shapes
- If the story mentions a teammate or ally: their action is described ONLY in the videoPrompt as off-screen or implied — they NEVER appear in any imagePrompt
- Hero design is LOCKED — do NOT alter outfit, colors, proportions, or style in any way`}
- NO real humans — all characters must be clearly stylized game characters
- NO lip sync or mouth movement on heroes unless explicitly requested by the user
- Hero scenes use background voiceover only — the hero does NOT speak on camera

MODERATION SAFETY RULES (apply to BOTH imagePrompt and videoPrompt):
- FORBIDDEN words and concepts: kill, destroy, crush, eliminate, annihilate, slaughter, gore, blood, death, military, army, soldiers, troops, warfare, explosions, bombs, missiles, firearms, guns
- NO military imagery of any kind — no uniforms, no weapons, no battlefield scenes
- NO realistic explosions or fire — stylized arcane magical effects only (sparkles, energy bursts, glows, particle effects)
- USE these approved alternatives instead: outplay, outwit, win fast, skill-based victory, master the challenge, dominate the leaderboard, rise to the top, claim glory
- Visual conflict must be stylized and fantasy-based — glowing spells, arcane energy, magical duels — never realistic violence

RULES FOR DURATION:
- The video model ONLY accepts these exact durations: ${(allowedDurations.length ? allowedDurations : [5, 8]).join(', ')} seconds
- CRITICAL: You MUST pick from ONLY these values. Any other duration will be rejected by the video model.
- Action scenes: pick a longer allowed value, dialogue/narration: pick a mid allowed value, CTA scene: pick the shortest allowed value (${(allowedDurations.length ? allowedDurations[0] : 5)}s)

OUTPUT FORMAT:
Return ONLY a valid JSON object (no markdown, no code fences, no explanation):
{
  "voiceOverCharacteristics": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing",
  "scenes": [
    {
      "sceneNumber": 1,
      "imagePrompt": "opening frame A — attention-grabbing first shot of the hero...",
      "imageBPrompt": "end frame B — what scene 1 video ends on, different angle/composition...",
      "videoPrompt": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing: \\"A legend is about to be reborn.\\" Fast dolly zoom into hero's face, epic orchestral swell, particles of light swirl around the character.",
      "duration": 6,
      "useHeroRef": true,
      "useBgRef": false
    },
    {
      "sceneNumber": 2,
      "imagePrompt": "end frame — what scene 2 video ends on (first frame auto-extracted from scene 1 video)...",
      "videoPrompt": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing: \\"Power beyond imagination.\\" Whip pan across battlefield, dramatic camera push...",
      "duration": 6,
      "useHeroRef": true,
      "useBgRef": false
    },
    {
      "sceneNumber": ${sceneCount},
      "ctaImagePrompt": "CTA frame: Download Now button, app store badges, game logo, stylized background...",
      "videoPrompt": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing: \\"Download now and claim your destiny!\\" Fast push-in to CTA reveal, epic orchestral hit, energy particles converge on Download button.",
      "duration": ${(allowedDurations.length ? allowedDurations[0] : 4)},
      "useHeroRef": true,
      "useBgRef": false
    }
  ]
}
IMPORTANT: Scene 1 MUST have both "imagePrompt" (frame A) and "imageBPrompt" (frame B). Middle scenes (2 to N-1) have only "imagePrompt" (their end frame). The LAST scene has ONLY "ctaImagePrompt" — NO "imagePrompt".
IMPORTANT: The voice characteristics part BEFORE the colon and quotes must be IDENTICAL in every videoPrompt — only the dialogue inside the quotes changes.`;

  // Build Claude message content — text first, then optional images
  const userContent = [];

  userContent.push({
    type: 'text',
    text: `Break this story into exactly ${sceneCount} scenes:\n\n${storyText}`,
  });

  for (let hi = 0; hi < heroImagePaths.length; hi++) {
    const heroPath = heroImagePaths[hi];
    const heroLabel = hasMultipleHeroes ? `Hero #${hi + 1}` : 'Hero';
    try {
      const rawBuffer = readFileSync(heroPath);
      const { buffer: finalBuffer, mime } = await ensureUnder5MB(rawBuffer, `${heroLabel} image`);
      userContent.push({
        type: 'text',
        text: hasMultipleHeroes
          ? `HERO #${hi + 1} REFERENCE IMAGE (this is a DISTINCT character — study their appearance, outfit, colors, proportions, art style):`
          : 'HERO REFERENCE IMAGE (study this character carefully — outfit, colors, proportions, art style):',
      });
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data: finalBuffer.toString('base64') },
      });
      console.log(`[Claude] Attached ${heroLabel} image: ${heroPath} (${(finalBuffer.length / 1024).toFixed(0)} KB sent, ${mime})`);
    } catch (e) {
      console.warn(`[Claude] Failed to read ${heroLabel} image: ${e.message}`);
    }
  }

  if (hasBgImage) {
    try {
      const rawBuffer = readFileSync(images.backgroundImagePath);
      const { buffer: finalBuffer, mime } = await ensureUnder5MB(rawBuffer, 'Background image');
      userContent.push({
        type: 'text',
        text: 'BACKGROUND REFERENCE IMAGE (study this environment carefully — art style, colors, atmosphere, art direction):',
      });
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data: finalBuffer.toString('base64') },
      });
      console.log(`[Claude] Attached background image: ${images.backgroundImagePath} (${(finalBuffer.length / 1024).toFixed(0)} KB sent, ${mime})`);
    } catch (e) {
      console.warn(`[Claude] Failed to read background image: ${e.message}`);
    }
  }

  console.log(`[Claude] Planning ${sceneCount} scenes with claude-sonnet-4-6... (voice: ${voiceDesc ? 'user-provided' : 'auto-generate'}, heroImg: ${hasHeroImage}, bgImg: ${hasBgImage})`);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    temperature: 1, // claude-sonnet-4-6 only supports temperature=1
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const responseText = message.content[0]?.text?.trim() || '';
  console.log(`[Claude] Raw response length: ${responseText.length} chars`);

  // Parse JSON — handle potential markdown code fences
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    const jsonMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[1].trim());
    } else {
      const objMatch = responseText.match(/\{[\s\S]*\}/);
      if (objMatch) {
        parsed = JSON.parse(objMatch[0]);
      } else {
        throw new Error(`Claude returned invalid JSON: ${responseText.slice(0, 200)}...`);
      }
    }
  }

  // Handle both formats: { scenes: [...] } or just [...]
  let scenesArr;
  let voiceOver;

  if (Array.isArray(parsed)) {
    scenesArr = parsed;
    voiceOver = voiceDesc || 'Neutral narrator voice';
  } else if (parsed.scenes && Array.isArray(parsed.scenes)) {
    scenesArr = parsed.scenes;
    voiceOver = parsed.voiceOverCharacteristics || voiceDesc || 'Neutral narrator voice';
  } else {
    throw new Error('Claude returned unexpected format — expected { scenes: [...] }');
  }

  if (scenesArr.length === 0) {
    throw new Error('Claude returned empty scenes array');
  }

  // Validate each scene — include reference image flags + imageBPrompt for scene 1, ctaImagePrompt for last scene
  const scenes = scenesArr.map((s, i) => {
    const isFirstScene = (i === 0);
    const isLastScene = (i === scenesArr.length - 1);

    const scene = {
      sceneNumber: s.sceneNumber || (i + 1),
      imagePrompt: isLastScene ? '' : (s.imagePrompt || ''),
      videoPrompt: s.videoPrompt || '',
      duration: snapToAllowed(s.duration || 6, allowedDurations),
      useHeroRef: hasHeroImage ? (s.useHeroRef ?? true) : false,
      useBgRef: hasBgImage ? (s.useBgRef ?? false) : false,
    };
    // First scene gets imageBPrompt (frame B / end frame)
    if (isFirstScene && s.imageBPrompt) {
      scene.imageBPrompt = s.imageBPrompt;
    }
    // Last scene gets ctaImagePrompt only (no imagePrompt)
    if (isLastScene && s.ctaImagePrompt) {
      scene.ctaImagePrompt = s.ctaImagePrompt;
    }
    return scene;
  });

  console.log(`[Claude] ✅ Planned ${scenes.length} scenes`);
  console.log(`[Claude] Voice-over: ${voiceOver}`);
  for (const s of scenes) {
    const refs = [s.useHeroRef && 'hero', s.useBgRef && 'bg'].filter(Boolean).join('+') || 'none';
    const imgLabel = s.imageBPrompt ? `imgA: ${s.imagePrompt.slice(0, 30)}... | imgB: ${s.imageBPrompt.slice(0, 30)}...` : (s.ctaImagePrompt ? `cta: ${s.ctaImagePrompt.slice(0, 50)}...` : `img: ${s.imagePrompt.slice(0, 50)}...`);
    console.log(`  Scene ${s.sceneNumber}: ${s.duration}s | refs: ${refs} | ${imgLabel}`);
  }

  return { scenes, voiceOverCharacteristics: voiceOver };
}
