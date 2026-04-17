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
// Claude's API checks the base64-encoded length (not raw bytes), so the effective
// raw-byte limit is 5 MB × (3/4) = 3.75 MB.
const MAX_IMAGE_BYTES = Math.floor(5 * 1024 * 1024 * 3 / 4); // ~3.93 MB raw → ≤5 MB base64

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
export async function ensureUnder5MB(inputBuffer, label) {
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
 * Claude decides the number of scenes and each scene's duration to fit within the target range.
 * @param {string}   storyText        — The story/script (Claude may enhance/rewrite for engagement)
 * @param {object}   durationRange    — { min, max } total video duration in seconds
 * @param {string}   gameContext      — Game/brand context
 * @param {string}   voiceDesc        — Voice description (optional — Claude generates one if empty)
 * @param {string}   heroDesc         — Hero character text description
 * @param {object}   images           — { heroImagePath, backgroundImagePath } (optional file paths)
 * @param {number[]} allowedDurations — exact allowed durations from the selected video model (e.g. [4,6,8])
 * @param {string}   pipelineMode     — 'standard' | 'fast-paced'
 * @param {object|null} heroesData    — parsed Blitz_of_Battle_Heroes.json content (optional)
 * @param {string[]}    namedHeroes  — hero names selected from catalog (no image uploaded)
 * @returns {Promise<{scenes: Array, voiceOverCharacteristics: string}>}
 */
export async function planScenes(storyText, durationRange, gameContext, voiceDesc, heroDesc, images = {}, allowedDurations = [], pipelineMode = 'standard', heroesData = null, namedHeroes = [], videoModel = '') {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env');

  const isFastPaced = (pipelineMode === 'fast-paced');
  const isSeedance = videoModel === 'bytedance:seedance@2.0';
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  // ── Build hero catalog section from Blitz_of_Battle_Heroes.json (if provided) ──
  let heroCatalogSection = '';
  if (heroesData && Array.isArray(heroesData.heroes) && heroesData.heroes.length > 0) {
    const heroLines = heroesData.heroes.map(h => {
      const abilitiesList = (h.abilities || [])
        .map(a => `    • ${a.name}: ${a.visual_effect}`)
        .join('\n');
      return `  ▸ ${h.name} (${h.class})
    Lore: ${h.lore_description}
    Visual: ${h.visual_description}
    Combat style: ${h.combat_style}
    Abilities:
${abilitiesList}`;
    }).join('\n\n');

    heroCatalogSection = `
GAME HERO CATALOG — "${heroesData.game || 'Blitz of Battle'}":
Art style: ${heroesData.visual_style || 'Mobile MOBA, stylized fantasy art'}
Image guidance: ${heroesData.usage_notes?.for_images || ''}
Video guidance: ${heroesData.usage_notes?.for_videos || ''}

Heroes available (${heroesData.heroes.length} total):
${heroLines}

CRITICAL HERO USAGE RULES:
- If the user has uploaded a hero reference image, that hero is the PRIMARY character — use their exact visual_description and incorporate their abilities into the action sequences.
- If no hero image was uploaded, identify the most relevant hero from this catalog based on the story/script content and use their description, lore, and abilities to write all image and video prompts.
- When describing hero abilities in image/video prompts, use the exact visual_effect descriptions from the catalog above (e.g. "purple shadow silhouette", "cyan energy orb with crackling lightning", "green vine wave through ground").
- The hero's combat style and signature abilities must be visible and central to the action in every scene — not generic fighting, but their specific powers and moves.
- The hero's personality and lore must inform the voiceover tone and narrative arc.
- ABSOLUTE RULE: You may ONLY use heroes that are explicitly listed in the "SPECIFICALLY SELECTED HEROES" section below. Do NOT substitute, replace, or add any other hero from the catalog. If a hero is not in that list, they do NOT exist for this video.`;
  }

  // ── Build named heroes section (heroes chosen from catalog, no reference image) ──
  let namedHeroesSection = '';
  if (namedHeroes && namedHeroes.length > 0) {
    const details = namedHeroes.map(name => {
      const h = heroesData?.heroes?.find(hero => hero.name === name);
      if (!h) return `  ▸ ${name} (details not found in catalog — describe as a stylized mobile game hero)`;
      const abilitiesList = (h.abilities || [])
        .map(a => `    • ${a.name}: ${a.visual_effect}`)
        .join('\n');
      return `  ▸ ${h.name} (${h.class})
    Lore: ${h.lore_description}
    Visual: ${h.visual_description}
    Combat: ${h.combat_style}
    Abilities:
${abilitiesList}`;
    }).join('\n\n');

    namedHeroesSection = `

SPECIFICALLY SELECTED HEROES FOR THIS VIDEO (${namedHeroes.length} hero${namedHeroes.length > 1 ? 's' : ''} chosen by the user):
${details}

ABSOLUTE CONSTRAINT: ONLY use the heroes listed above — [${namedHeroes.join(', ')}]. Do NOT use, mention, reference, or substitute ANY other hero from the catalog. If a hero name is not in this list, it MUST NOT appear in any prompt. This is non-negotiable.
When generating image prompts: if useHeroRef is true (reference images attached), do NOT repeat visual descriptions in the prompt — the image model reads appearance directly from the reference images. If useHeroRef is false (no reference), include the hero name and brief visual description so the image model knows who to draw.`;
  }

  const heroImagePaths = Array.isArray(images.heroImagePath)
    ? images.heroImagePath.filter(Boolean)
    : (images.heroImagePath ? [images.heroImagePath] : []);
  const heroCount = heroImagePaths.length;
  const hasHeroImage = heroCount > 0;

  // If named heroes have reference images attached, update the instruction
  if (namedHeroes?.length > 0 && hasHeroImage) {
    namedHeroesSection = namedHeroesSection.replace(
      'if useHeroRef is true (reference images attached), do NOT repeat visual descriptions in the prompt — the image model reads appearance directly from the reference images.',
      'Reference images are attached for these heroes. DO NOT describe their appearance in image prompts — the image model reads the character directly from the reference images. Only describe scene, camera angle, action, background, and mood.'
    );
  }
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
    ? `- ${heroCount} HERO reference images have been provided (see attached). Each image represents a DISTINCT character. The image generator will use these reference images directly — DO NOT describe the heroes' appearance, outfit, face, colors, proportions, or weapons in image prompts. Instead, for each scene only describe: camera angle/direction, background/environment, action or pose, mood, and lighting. Let the reference images do the visual work.`
    : (hasHeroImage
      ? '- A single HERO reference image has been provided (see attached). The image generator will use this reference image directly — DO NOT describe the hero\'s appearance, outfit, face, colors, hairstyle, or weapon in any image prompt. Only describe: camera angle/direction, background/environment, action or pose, mood, and lighting. The hero\'s look comes from the reference image, not from text. CRITICAL IMAGE RULE: image prompts must contain ONLY this hero character and NOTHING ELSE. Absolutely NO teammates, partners, allies, silhouettes, shadowed figures, or background characters of any kind — even if the story mentions a teammate.'
      : '');

  const imageRefInstruction = (hasHeroImage || hasBgImage)
    ? `
REFERENCE IMAGES:
${heroRefText}
${hasBgImage ? '- A BACKGROUND reference image has been provided (see attached). Study it carefully — note the environment style, colors, atmosphere, art direction.' : ''}
- A CTA DESIGN REFERENCE image is ALWAYS provided (reference.jpg — attached separately by the pipeline). This shows the game's official CTA screen: the exact game logo design, typography style, color palette, app store badge placement, and overall marketing layout. The ctaImagePrompt MUST instruct the image generator to match this reference exactly — same logo style, same badge design, same color scheme, same visual hierarchy.

For EACH scene, you must decide whether the AI image generator should use the reference images to maintain visual consistency. Set "useHeroRef" and/or "useBgRef" to true when:
- The scene features the hero character prominently → useHeroRef: true
- The scene's environment should match the background style → useBgRef: true
- The CTA/final scene should use BOTH hero ref and the CTA design reference (reference.jpg is always attached automatically)
Set them to false when the scene intentionally shows something different (e.g. a villain's lair with no hero visible).`
    : `
REFERENCE IMAGES:
- A CTA DESIGN REFERENCE image is ALWAYS provided (reference.jpg — attached separately by the pipeline). This shows the game's official CTA screen: the exact game logo design, typography style, color palette, app store badge placement, and overall marketing layout. The ctaImagePrompt MUST instruct the image generator to match this reference exactly.
Set "useHeroRef" and "useBgRef" to false for all non-CTA scenes.`;

  const durMin = durationRange.min || 15;
  const durMax = durationRange.max || 30;
  const allowedStr = (allowedDurations.length ? allowedDurations : [5, 8]).join(', ');
  const shortestDur = allowedDurations.length ? allowedDurations[0] : 5;
  const maxSceneCount = Math.floor(durMax / shortestDur);
  // Seedance single-scene mode: when total duration fits in one Seedance clip (<=15s),
  // plan as exactly 1 scene so we generate 1 image + 1 video instead of multiple.
  const seedanceSingleScene = isSeedance && durMax <= 15;

  // ── Mode-conditional image flow instructions ──
  const imageFlowInstructions = isFastPaced
    ? `IMPORTANT — IMAGE GENERATION FLOW (fast-paced parallel pipeline):
Videos are generated in PARALLEL — no frame extraction between scenes. Each scene uses its OWN opening frame image as the first frame, driven by the video prompt.

- ALL scenes (including scene 1): ONE "imagePrompt" — the OPENING frame of that scene (the frame the video starts from)
- LAST scene ONLY: ALSO provide "ctaImagePrompt" — the CTA closing shot. The last scene's video animates from imagePrompt (opening) → ctaImagePrompt (CTA).
- NO "imageBPrompt" for ANY scene.
- MANDATORY CAMERA VARIETY — STRICTLY DIFFERENT DIRECTION EACH SCENE: Every scene image MUST show the character from a genuinely different physical direction AND angle. "Different angle" means the camera is literally on a different side of the character — not just a different zoom from the same direction.
  Use this labeled rotation — pick one per scene in order, NEVER use the same label twice across the whole video:
  [FRONT] Wide front-facing shot — character faces camera directly, full body
  [BACK] Full back-view — camera behind character, hero facing away, full body visible from behind
  [LEFT-SIDE] Pure left-side profile — camera 90° to character's left, full body
  [RIGHT-SIDE] Pure right-side profile — camera 90° to character's right, full body
  [LOW-FRONT] Low-angle front shot — camera below looking up at full body
  [HIGH-ABOVE] Bird's-eye overhead — camera directly above looking down, full body
  [THREE-QUARTER-FRONT] Diagonal front — camera 45° in front-left or front-right, full body
  [THREE-QUARTER-BACK] Diagonal back — camera 45° behind-left or behind-right, full body
  [DUTCH-ANGLE] Tilted frame — camera rolled 20-30°, full body visible at dynamic angle
- START each imagePrompt with the label in brackets, e.g. "[BACK] Following the provided hero reference image exactly — ..."
- NEVER use the same label in two scenes. If there are more scenes than labels, cycle back but skip any recently used ones.
- CRITICAL: ALL shots MUST show the hero's FULL BODY — head to toe visible in frame. NO close-ups, NO cropped shots, NO face-only shots, NO partial body shots. Every image must frame the complete character with room around them.`
    : `IMPORTANT — IMAGE GENERATION FLOW (sequential video pipeline):
Videos are generated SEQUENTIALLY. Each video's first frame is extracted from the PREVIOUS video's actual last frame using FFmpeg. This creates pixel-perfect seamless transitions. Image prompts serve as END frames for each scene's video.

- SCENE 1 (first scene): You MUST provide TWO image prompts:
  1. "imagePrompt" — the OPENING frame (frame A). This is where the entire video ad begins. Make it a strong, attention-grabbing shot.
  2. "imageBPrompt" — the END frame (frame B). Scene 1's video animates from frame A → frame B.
- MIDDLE SCENES (scenes 2 to N-1): Provide only ONE "imagePrompt" each — this is the END frame the video animates toward. The first frame comes automatically from the previous video's extracted last frame.
- LAST SCENE (final scene): Provide ONLY "ctaImagePrompt" — NO "imagePrompt". The first frame comes from the previous video's extracted last frame. The video animates into the CTA frame.
  "ctaImagePrompt" — the CTA (call-to-action) frame. CRITICAL: The pipeline will attach reference.jpg as a style reference when generating this image. Your prompt MUST explicitly tell the image model to follow the reference image's exact design: reproduce the game logo in the same style/font/color as shown in the reference, use the same app store badge design and placement, match the color palette and overall layout. Then add the hero character (if useHeroRef) and a stylized game art background. Example structure: "Following the provided CTA reference design exactly — same game logo style, same app store badge design, same color palette — [hero description if applicable], [background], [any extra flair]. Portrait 9:16, stylized mobile game marketing art."`;

  // ── Mode-conditional output format example ──
  const outputFormatExample = isFastPaced
    ? `{
  "voiceOverCharacteristics": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing",
  "scenes": [
    {
      "sceneNumber": 1,
      "heroes": ["Cravius"],
      "imagePrompt": "[FRONT] opening frame of scene 1 — wide front-facing establishing shot of hero ready for battle, full body head to toe...",
      "videoPrompt": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing: \\"Dominate every match.\\" Explosive snap zoom...",
      "duration": ${allowedDurations[1] || allowedDurations[0] || 6},
      "useHeroRef": true,
      "useBgRef": false${isSeedance ? ',\n      "sequenceGroup": null' : ''}
    },
    {
      "sceneNumber": 2,
      "heroes": ["Balec"],
      "imagePrompt": "[BACK] opening frame of scene 2 — full back-view of hero, camera behind character, hero facing away mid-combat, complete character visible head to toe...",
      "videoPrompt": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing: \\"Rise to legendary.\\" Fast whip pan...",
      "duration": ${allowedDurations[0] || 4},
      "useHeroRef": true,
      "useBgRef": false${isSeedance ? ',\n      "sequenceGroup": null' : ''}
    },
    {
      "sceneNumber": "N (last)",
      "heroes": ["Cravius", "Balec", "Halyx", "Zaleth"],
      "imagePrompt": "[LOW-FRONT] opening frame of last scene — low-angle front shot looking up at full body of hero in heroic pose, high energy...",
      "ctaImagePrompt": "Following the provided CTA reference design exactly — same game logo style, font, and color as in the reference image, same app store badge design and placement — [hero in heroic pose if applicable], stylized game art background, Download Now button, portrait 9:16 mobile game marketing layout...",
      "videoPrompt": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing: \\"Download now!\\" Fast push-in to CTA reveal...",
      "duration": ${shortestDur},
      "useHeroRef": true,
      "useBgRef": false${isSeedance ? ',\n      "sequenceGroup": null' : ''}
    }
  ]
}
IMPORTANT: ALL scenes have "imagePrompt" (opening frame). LAST scene ALSO has "ctaImagePrompt". NO "imageBPrompt" in any scene.
IMPORTANT: EVERY scene imagePrompt MUST start with a direction label in brackets — [FRONT], [BACK], [LEFT-SIDE], [RIGHT-SIDE], [LOW-FRONT], [HIGH-ABOVE], [THREE-QUARTER-FRONT], [THREE-QUARTER-BACK], or [DUTCH-ANGLE]. No two scenes may share the same label.${isSeedance ? '\nIMPORTANT: Every scene MUST include "sequenceGroup" — either a group name string (for consecutive action scenes to merge) or null.' : ''}`
    : `{
  "voiceOverCharacteristics": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing",
  "scenes": [
    {
      "sceneNumber": 1,
      "heroes": ["Cravius"],
      "imagePrompt": "[FRONT] opening frame A — wide front-facing shot of hero, full body head to toe...",
      "imageBPrompt": "[THREE-QUARTER-FRONT] end frame B — 45° diagonal front of hero, full body head to toe...",
      "videoPrompt": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing: \\"A legend is about to be reborn.\\" Fast dolly zoom...",
      "duration": ${allowedDurations[1] || allowedDurations[0] || 6},
      "useHeroRef": true,
      "useBgRef": false${isSeedance ? ',\n      "sequenceGroup": null' : ''}
    },
    {
      "sceneNumber": 2,
      "heroes": ["Balec"],
      "imagePrompt": "[LEFT-SIDE] end frame — pure left-side profile of hero, full body head to toe...",
      "videoPrompt": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing: \\"Power beyond imagination.\\" Whip pan...",
      "duration": ${allowedDurations[0] || 4},
      "useHeroRef": true,
      "useBgRef": false${isSeedance ? ',\n      "sequenceGroup": "fight_sequence_1"' : ''}
    },
    {
      "sceneNumber": 3,
      "heroes": ["Balec"],
      "imagePrompt": "[RIGHT-SIDE] end frame — right-side profile of hero at climax of combat...",
      "videoPrompt": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing: \\"Unstoppable.\\" Explosive push-in...",
      "duration": ${allowedDurations[0] || 4},
      "useHeroRef": true,
      "useBgRef": false${isSeedance ? ',\n      "sequenceGroup": "fight_sequence_1"' : ''}
    },
    {
      "sceneNumber": "N (last)",
      "heroes": ["Cravius", "Balec", "Halyx", "Zaleth"],
      "ctaImagePrompt": "Following the provided CTA reference design exactly — same game logo style, font, and color as in the reference image, same app store badge design and placement — [hero in heroic pose if applicable], stylized game art background, Download Now button, portrait 9:16 mobile game marketing layout...",
      "videoPrompt": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing: \\"Download now!\\" Fast push-in to CTA reveal...",
      "duration": ${shortestDur},
      "useHeroRef": true,
      "useBgRef": false${isSeedance ? ',\n      "sequenceGroup": null' : ''}
    }
  ]
}
IMPORTANT: Scene 1 MUST have both "imagePrompt" (frame A) and "imageBPrompt" (frame B). Middle scenes have only "imagePrompt" (end frame). The LAST scene has ONLY "ctaImagePrompt" — NO "imagePrompt".
IMPORTANT: EVERY imagePrompt and imageBPrompt MUST start with a direction label in brackets — [FRONT], [BACK], [LEFT-SIDE], [RIGHT-SIDE], [LOW-FRONT], [HIGH-ABOVE], [THREE-QUARTER-FRONT], [THREE-QUARTER-BACK], or [DUTCH-ANGLE]. No two prompts may share the same label — every shot must be from a genuinely different physical direction.${isSeedance ? '\nIMPORTANT: Every scene MUST include "sequenceGroup" — either a group name string (for consecutive action scenes to merge) or null. CTA/last scene must always be null.' : ''}`;

  const systemPrompt = `You are an elite creative director for viral mobile game ads. You make TikTok-style video ads that stop thumbs and drive downloads.

YOUR MISSION: You will receive reference images (hero character, background environment).
FIRST — study these images carefully: understand the visual world, art style, character design, setting.
SECOND — decide on the marketing narrative: what PROMISE does this ad make to the viewer? What emotion/action does the voiceover sell? (e.g. "dominate in 3-minute fast matches", "rise to legendary status")
THIRD — write ALL scene descriptions so that EVERY visual directly illustrates that same promise. If the voiceover says "fast-paced 3-minute battles", every image prompt must show intense action that matches that speed and energy. The voiceover and visuals must tell the EXACT SAME story. The marketing message is the source of truth — visuals serve it, not the other way around.
You may enhance or rewrite the user's story/script to better serve this mission. Take the user's story/script as creative INSPIRATION — you are free to enhance, restructure, punch up dialogue, add dramatic beats, cut boring parts, or completely rewrite it to make the most engaging, fast-paced video ad possible. The user's script is a starting point, NOT a rigid blueprint. Your job is to make it SELL.

YOU DECIDE THE SCENE COUNT. The user wants a total video between ${durMin}–${durMax} seconds. Each scene must use one of these exact durations: ${allowedStr} seconds. Pick however many scenes you need (minimum 2) to fill the target range. The sum of all scene durations MUST be between ${durMin} and ${durMax} seconds. Prefer MORE shorter scenes over fewer longer ones — fast cuts = more engaging.

CONTEXT:
- Game/Brand: ${gameContext || 'A mobile game'}
- Hero Character: ${heroDesc || 'A stylized game character'}
${heroCatalogSection}${namedHeroesSection}

VOICE-OVER:
${voiceInstruction}
${imageRefInstruction}

RULES FOR IMAGE PROMPTS:
- Each imagePrompt must be a highly detailed text-to-image prompt for Nano Bana 2 (google:4@3)
- Images will be generated at 3072×5504 (portrait 9:16)
${hasMultipleHeroes
  ? '- When useHeroRef is true: the hero reference images are attached — DO NOT describe the heroes\' appearance, outfit, face, colors, or weapons in the prompt at all. The image model will read them from the reference images. Simply write "following the provided character reference images exactly" and then describe ONLY the scene: camera angle, background, action/pose, mood, lighting, composition. Never mention hero appearance details.'
  : (hasHeroImage ? '- When useHeroRef is true: the hero reference image is attached — DO NOT describe the hero\'s appearance, outfit, face, colors, hairstyle, or weapon in the prompt. The image model will read the character from the reference image. Simply write "following the provided hero reference image exactly" and then describe ONLY the scene: camera angle, background, action/pose, mood, lighting, composition. Never mention hero appearance details.' : '- Include the hero character description in the image prompt')}
${hasBgImage ? '- When useBgRef is true, describe the environment matching the background reference (same art style, palette, atmosphere)' : ''}
- Include game art style, lighting, composition, mood
${hasHeroImage
  ? '- CHARACTER APPEARANCE LOCK: DO NOT describe the character\'s face, outfit, colors, hair, or weapon in image prompts. These are locked to the reference image and must NOT be written in the prompt — doing so causes the AI to hallucinate and deviate from the reference. Only the camera angle, background, and action change between scenes.'
  : '- CHARACTER APPEARANCE LOCK: The character\'s physical appearance is FROZEN and must be identical across every scene. Same face, same hair, same outfit and clothing details, same weapon design and colors.'}
- CRITICAL VARIETY — GENUINELY DIFFERENT DIRECTION EVERY SCENE: Each image MUST show the character from a completely different physical direction — not just a different zoom or composition from the same side. Rotate through these labeled directions, using each only once per video:
  [FRONT] direct front-facing, full body | [BACK] full back-view, camera behind hero | [LEFT-SIDE] 90° left profile, full body | [RIGHT-SIDE] 90° right profile, full body | [LOW-FRONT] low-angle looking up at full body | [HIGH-ABOVE] bird's-eye overhead, full body from above | [THREE-QUARTER-FRONT] 45° diagonal front, full body | [THREE-QUARTER-BACK] 45° diagonal back, full body | [DUTCH-ANGLE] tilted frame, full body at dynamic angle
  START every imagePrompt with the direction label in brackets, e.g. "[LEFT-SIDE] Following the provided hero reference image exactly — [camera angle] [action/pose] [background] [mood/lighting]. Portrait 9:16, stylized mobile game art." — NO hero appearance description after the opening tag.
  NEVER use the same direction label in two consecutive scenes or across the whole video if possible.
- ABSOLUTE RULE — FULL BODY ALWAYS: Every single image MUST show the hero's complete body from head to toe, regardless of camera angle. NO close-ups of any kind. NO face-only shots. NO cropped hands or weapons. NO partial body. The hero must always be 100% fully visible in frame — front, back, or side view — with space around them. Think: character select screen — you always see the whole character.
- Be specific about camera angle, framing, background elements

${imageFlowInstructions}

RULES FOR VIDEO PROMPTS:
- Each videoPrompt will be used with a video generation model (Veo 3.1 or similar)
- CRITICAL VOICE FORMAT: EVERY videoPrompt MUST start with the voice-over in this EXACT format:
  He/She says in the voice of a [AGE] [GENDER], [TIMBRE], [TONE], [PACING]: "dialogue here"
  The 5 voice elements (AGE, GENDER, TIMBRE, TONE, PACING) must be IDENTICAL across ALL scenes — copy-paste the same string every time. Only the dialogue inside the quotes changes per scene.
- DIALOGUE RULES (the text inside the quotes):
  * Must be a sales pitch — hype the game, create urgency, make the viewer want to download NOW
  * Use power words: "dominate", "unstoppable", "epic", "legendary", "claim your throne", "rise to glory"
  * MUST FIT the scene's duration: ~2-3 words per second. A ${shortestDur}s scene = max ${shortestDur * 3} words. NEVER exceed this — incomplete sentences sound terrible.
  * Build a narrative arc across scenes: hook → excitement → climax → CTA. Each scene's dialogue flows naturally to the next.
  * Last scene (CTA): must end with a clear call-to-action like "Download now and claim your destiny!" or "Play free today!"
- FAST PACING (CRITICAL): Every video clip MUST feel like a high-octane TikTok game ad — never slow, never cinematic, never lingering. Use only rapid, aggressive camera movements: snap zoom, whip pan, fast dolly punch-in, explosive push-in, speed-ramped tracking shot. If a camera movement takes more than 1 second to complete, it is TOO SLOW. NO slow pans, NO cinematic eases, NO peaceful drone shots, NO slow reveals. Think: blink-and-you-miss-it energy.
- SMOOTH TRANSITIONS: Each scene's video should end with a natural visual transition — camera pushes through a portal/doorway, motion blur, particle effect wipe, dramatic zoom dissolve. Scenes must flow seamlessly when concatenated.
- VARIED CAMERA MOVEMENT: Each scene MUST use a DIFFERENT camera technique — never repeat the same movement in consecutive scenes.
- After the voice line, include: camera movement, scene action, sound effects, audio/mood
- Keep video prompts under 600 characters

HERO ASSIGNMENT PER SCENE:
- Each scene MUST include a "heroes" array listing the EXACT hero name(s) featured in that scene
- Use the exact names from the provided hero catalog/references (case-sensitive)
- Most scenes feature 1 hero. Ensemble/CTA scenes may list multiple heroes.
- The "heroes" array determines which reference images are sent to the AI model for that scene — only the listed heroes' images will be used
- EVERY scene must have at least 1 hero in its "heroes" array

CHARACTER RULES (apply to BOTH imagePrompt and videoPrompt):
${hasMultipleHeroes
  ? `- ${heroCount} distinct hero characters are defined — scenes may feature one, some, or all of them as the story demands
- Each hero's design is individually LOCKED — do NOT alter any hero's outfit, colors, proportions, style, or weapon in any way
- NO characters beyond the provided heroes — NO random soldiers, civilians, or bystanders`
  : `- ONLY the defined hero character may appear in image prompts — ZERO other visible characters, even as blurry background figures, partial silhouettes, or "barely visible" shapes
- If the story mentions a teammate or ally: their action is described ONLY in the videoPrompt as off-screen or implied — they NEVER appear in any imagePrompt
- Hero design is FULLY LOCKED — do NOT alter the character's face, hair, outfit, clothing details, colors, proportions, style, or weapon in any way — not even subtle changes
- Do NOT add any extra accessories, armor pieces, capes, scars, effects, or items onto the character that are not visible in the reference image
- The character's weapon is LOCKED — same weapon design and colors in every scene — never replace, upgrade, or omit it`}
- NO real humans — all characters must be clearly stylized game characters
- NO lip sync or mouth movement on heroes unless explicitly requested by the user
- Hero scenes use background voiceover only — the hero does NOT speak on camera

MODERATION SAFETY RULES (apply to BOTH imagePrompt and videoPrompt):
- FORBIDDEN words and concepts: kill, destroy, crush, eliminate, annihilate, slaughter, gore, blood, death, military, army, soldiers, troops, warfare, explosions, bombs, missiles, firearms, guns
- NO military imagery of any kind — no uniforms, no weapons, no battlefield scenes
- NO realistic explosions or fire — stylized arcane magical effects only (sparkles, energy bursts, glows, particle effects)
- USE these approved alternatives instead: outplay, outwit, win fast, skill-based victory, master the challenge, dominate the leaderboard, rise to the top, claim glory
- Visual conflict must be stylized and fantasy-based — glowing spells, arcane energy, magical duels — never realistic violence

VISUAL CONSISTENCY RULES (apply to BOTH imagePrompt and videoPrompt):
Character Consistency:
- Each character's weapons must maintain EXACT color, material, shape, and size across ALL frames — e.g. a bronze battle axe must never shift to silver/grey
- Armor details, belt buckles, shoulder plates, and accessories must remain IDENTICAL across all frames of a character's segment
- Body proportions (head-to-body ratio, limb length, muscle mass) must be REALISTIC and CONSISTENT across all characters — no chibi/oversized heads
- Each character must look IDENTICAL between their solo segment and the ensemble/CTA frame — same skin tone, same armor, same proportions
- Tattoos, markings, scars must stay in the EXACT same position and design across all frames

Hand & Face Quality:
- NEVER let hands merge with energy/fire/magic effects — fingers must remain distinct and anatomically correct at all times
- During channeling or casting sequences, keep hands clearly visible gripping staff/weapon rather than dissolving into energy blobs
- Faces must remain clear and detailed in every frame — NEVER allow facial features to blur, tint, or bleed colors from adjacent characters

CTA / Ensemble Frame Rules:
- CTA ensemble frame: ALL characters must face the camera in dynamic, front-facing battle stances — NEVER back-to-camera
- Character proportions in ensemble shots must EXACTLY match their solo segment proportions — no shrinking or scaling changes
- NEVER allow color bleeding between adjacent characters — each hero maintains their own distinct color palette
- The ensemble/confrontation shot must show active, dynamic poses — NEVER static, NEVER passive, NEVER back-facing

Transitions & Camera:
- NEVER use full-screen explosion or blinding white flash transitions between scenes — they look cheap and mask character inconsistency
- Use clean cuts, directional wipes, or brief environmental transitions instead
- The climax/confrontation shot must feature all heroes facing the viewer or each other in active combat stances
- Maintain environment layout consistency within a character's segment (same number and position of background elements like catapults, flags, walls)

Character Continuity:
- A character must NEVER fully dissolve/disappear into pure energy then reappear looking different — maintain visible body throughout all transitions
- When camera angle changes within a scene, armor/clothing details must remain IDENTICAL
- If a character exits frame and re-enters, they must look exactly the same — same outfit, same weapon, same proportions

${isSeedance ? `SEQUENCE GROUPING (Seedance 2.0 supports multi-shot video — use this to combine continuous action sequences):
If two or more CONSECUTIVE scenes form a single unbroken action sequence (e.g. a fight, chase, explosion burst, combo attack), assign them the SAME "sequenceGroup" string (e.g. "fight_sequence_1", "chase_sequence_1"). Rules:
- Scenes in the same group will be merged into ONE video clip — their prompts concatenated, durations summed (max 15s per group).
- Only group scenes where continuity genuinely improves the result — never force grouping on unrelated scenes.
- Scenes that are NOT part of a group MUST have "sequenceGroup": null.
- CTA/last scene must NEVER be grouped — always "sequenceGroup": null.
- Group names must be snake_case strings, unique per group (e.g. "fight_sequence_1", "fight_sequence_2" for two separate fights).
` : ''
}${seedanceSingleScene ? `CRITICAL — SEEDANCE SINGLE-VIDEO MODE:
The video model (Seedance 2.0) will generate the main story content as ONE single multi-shot video clip.
You MUST create EXACTLY 2 scenes:
  - Scene 1 (MAIN): Contains the ENTIRE story narrative — hook, action, climax — as one rich multi-shot videoPrompt.
    Duration: use most of the budget (e.g. ${Math.max(4, Math.min(15, durMax - 4))}s). Must be an integer from: ${allowedStr}.
    The videoPrompt should describe shot transitions within it (e.g. "Cut to...", "Then...", "Camera whips to...") since this is a single multi-shot video.
  - Scene 2 (CTA): A short call-to-action scene. Duration: ${shortestDur}s.
    Only has "ctaImagePrompt" (no "imagePrompt"). The videoPrompt is a short CTA line like "Download now!"
- The SUM of both durations MUST be between ${durMin} and ${durMax} seconds.
- Scene 1 gets "imagePrompt" (opening frame). Scene 2 gets "ctaImagePrompt" (CTA closing frame).
- No "imageBPrompt" for any scene.
` : `RULES FOR DURATION:
- The video model ONLY accepts these exact durations: ${allowedStr} seconds
- CRITICAL: You MUST pick from ONLY these values. Any other duration will be rejected.
- The SUM of all scene durations MUST be between ${durMin} and ${durMax} seconds. NEVER exceed ${durMax}s.
- HARD CAP: With a max of ${durMax}s and shortest allowed duration of ${shortestDur}s, you can have AT MOST ${maxSceneCount} scene(s). Do NOT create more scenes than this.
- TIGHT RANGE RULE: When the max is small (e.g. 15s or less), use the SHORTEST allowed duration (${shortestDur}s) for every scene to stay safely under the cap. Only use longer durations when the total will still not exceed ${durMax}s.
- ALWAYS verify: add up all your chosen durations before finalising — the sum MUST be ≤ ${durMax}s.
- Prefer shorter scenes with fast cuts for maximum engagement. Use the shortest duration (${shortestDur}s) for CTA.
- You decide how many scenes to create — pick the count that makes the video most engaging while staying strictly within the ${durMin}–${durMax}s range.
`}
OUTPUT FORMAT:
Return ONLY a valid JSON object (no markdown, no code fences, no explanation):
${seedanceSingleScene ? `{
  "voiceOverCharacteristics": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing",
  "scenes": [
    {
      "sceneNumber": 1,
      "heroes": ["Cravius"],
      "imagePrompt": "[FRONT] opening frame — wide front-facing establishing shot of hero ready for battle, full body head to toe...",
      "videoPrompt": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing: \\"Dominate every match.\\" Explosive snap zoom on hero — cut to fast combat montage, whip pan to ability showcase, speed-ramp tracking shot through arena — camera pushes into climactic power-up moment.",
      "duration": ${Math.max(4, Math.min(15, durMax - shortestDur))},
      "useHeroRef": true,
      "useBgRef": false,
      "sequenceGroup": null
    },
    {
      "sceneNumber": 2,
      "heroes": ["Cravius"],
      "ctaImagePrompt": "Following the provided CTA reference design exactly — same game logo style, font, and color as in the reference image, same app store badge design and placement — hero in heroic pose, stylized game art background, Download Now button, portrait 9:16 mobile game marketing layout...",
      "videoPrompt": "He says in the voice of a mature man, deep commanding voice, intense and electrifying tone, faster pacing: \\"Download now!\\" Fast push-in to CTA reveal.",
      "duration": ${shortestDur},
      "useHeroRef": true,
      "useBgRef": false,
      "sequenceGroup": null
    }
  ]
}
IMPORTANT: You MUST create EXACTLY 2 scenes. Scene 1 has "imagePrompt" (opening frame) — NO "imageBPrompt", NO "ctaImagePrompt". Scene 2 has ONLY "ctaImagePrompt" — NO "imagePrompt".
IMPORTANT: Scene 1 videoPrompt must be a complete multi-shot narrative (hook → action → climax) since it will be generated as one continuous video.` : outputFormatExample}
IMPORTANT: The voice characteristics part BEFORE the colon and quotes must be IDENTICAL in every videoPrompt — only the dialogue inside the quotes changes.
${seedanceSingleScene ? `IMPORTANT: You MUST create EXACTLY 2 scenes. The total of both durations MUST be between ${durMin} and ${durMax} seconds.` : `IMPORTANT: You MUST create at least 2 scenes. The total of all durations MUST be between ${durMin} and ${durMax} seconds.`}`;

  // Build Claude message content — text first, then optional images
  const userContent = [];

  userContent.push({
    type: 'text',
    text: `Create a fast-paced video ad (${durMin}–${durMax}s total) from this story/script. You decide how many scenes and how long each one is. Enhance the story to make it as engaging as possible:\n\n${storyText}`,
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

  console.log(`[Claude] Planning scenes (${durMin}-${durMax}s) with claude-sonnet-4-6... (voice: ${voiceDesc ? 'user-provided' : 'auto-generate'}, heroImg: ${hasHeroImage} (${heroCount}), bgImg: ${hasBgImage}, heroCatalog: ${heroesData?.heroes?.length ?? 0} heroes, namedHeroes: ${namedHeroes.length})`);

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
  if (scenesArr.length < 2) {
    throw new Error('Claude returned only 1 scene — need at least 2 (first + CTA)');
  }

  // Validate each scene — include reference image flags, mode-conditional image fields
  const scenes = scenesArr.map((s, i) => {
    const isFirstScene = (i === 0);
    const isLastScene = (i === scenesArr.length - 1);

    const scene = {
      sceneNumber: s.sceneNumber || (i + 1),
      heroes: Array.isArray(s.heroes) && s.heroes.length > 0 ? s.heroes : [],
      imagePrompt: (s.imagePrompt || ''),   // ALL scenes get imagePrompt in both modes
      videoPrompt: s.videoPrompt || '',
      duration: snapToAllowed(s.duration || 6, allowedDurations),
      useHeroRef: hasHeroImage ? (s.useHeroRef ?? true) : false,
      useBgRef: hasBgImage ? (s.useBgRef ?? false) : false,
    };

    // Standard mode only: scene 1 gets imageBPrompt (frame B / end frame)
    if (!isFastPaced && isFirstScene && s.imageBPrompt) {
      scene.imageBPrompt = s.imageBPrompt;
    }

    if (isLastScene) {
      if (isFastPaced) {
        // Fast-paced last scene: has imagePrompt (opening frame) — guard against Claude omitting it
        if (!scene.imagePrompt) {
          console.warn(`[Claude] ⚠ Fast-paced last scene missing imagePrompt — using fallback`);
          scene.imagePrompt = 'Cinematic establishing shot, hero in action pose, game art style, portrait 9:16';
        }
      } else {
        // Standard mode: last scene has NO imagePrompt (first frame extracted from prev video)
        scene.imagePrompt = '';
      }
      // Both modes: last scene gets ctaImagePrompt
      if (s.ctaImagePrompt) scene.ctaImagePrompt = s.ctaImagePrompt;
    }

    return scene;
  });

  const totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);
  console.log(`[Claude] ✅ Planned ${scenes.length} scenes | Total: ${totalDuration}s (target: ${durMin}-${durMax}s)`);
  console.log(`[Claude] Voice-over: ${voiceOver}`);
  for (const s of scenes) {
    const refs = [s.useHeroRef && 'hero', s.useBgRef && 'bg'].filter(Boolean).join('+') || 'none';
    const imgLabel = s.imageBPrompt ? `imgA: ${s.imagePrompt.slice(0, 30)}... | imgB: ${s.imageBPrompt.slice(0, 30)}...` : (s.ctaImagePrompt ? `cta: ${s.ctaImagePrompt.slice(0, 50)}...` : `img: ${s.imagePrompt.slice(0, 50)}...`);
    const heroNames = s.heroes?.length ? s.heroes.join(', ') : 'none';
    console.log(`  Scene ${s.sceneNumber}: ${s.duration}s | heroes: [${heroNames}] | refs: ${refs} | ${imgLabel}`);
  }

  return { scenes, voiceOverCharacteristics: voiceOver };
}

/**
 * Generate a structured video creative brief from a marketing angle.
 * @param {object}   angle         — Full marketing angle object from marketing_angles.json
 * @param {object}   marketingData — Full marketing_angles.json parsed object (game + guardrails)
 * @param {string}   gameContext   — Optional user-provided game context
 * @param {string}   heroDesc      — Optional hero text description
 * @param {string[]} namedHeroes   — Hero names selected from catalog
 * @returns {Promise<string>}      — Plain text video creative brief
 */
export async function generateVideoDescription(angle, marketingData, gameContext, heroDesc, namedHeroes = []) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env');

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const game = marketingData.game || {};
  const guardrails = marketingData.creative_guardrails || {};

  const lengthRange = Array.isArray(angle.format?.length_seconds)
    ? `${angle.format.length_seconds[0]}–${angle.format.length_seconds[1]} seconds`
    : `${angle.format?.length_seconds ?? 15} seconds`;

  let subFormatsText = '';
  if (angle.sub_formats && angle.sub_formats.length > 0) {
    subFormatsText = `\nSUB-FORMATS:\n` + angle.sub_formats.map(sf =>
      `  ${sf.id} — ${sf.name}${sf.recommended ? ' [RECOMMENDED — test this first]' : ''}: ${sf.description}`
    ).join('\n');
  }

  const heroSection = namedHeroes.length > 0
    ? `\nSELECTED HEROES (must appear in the video): ${namedHeroes.join(', ')}`
    : '';

  const systemPrompt = `You are a senior mobile UA creative director for "${game.title || 'Blitz of Battle'}" (${game.genre || 'Mobile MOBA'}).
Write a concise VIDEO CREATIVE BRIEF in plain text. No markdown. No bullet symbols. Use plain text section labels like "DURATION:" etc.

OUTPUT FORMAT — write exactly these sections in this order:
ANGLE: [angle name]
CORE MESSAGE: [one sentence]
DURATION: [specific seconds — use the exact value or range from the angle's format]
HERO COUNT: [number + one-sentence reason]
EMOTIONAL ARC: [hook emotion → mid emotion → payoff emotion]
SCENE STRUCTURE:
  Scene 1 (Xs): [what to show, camera style, specific action]
  Scene 2 (Xs): [what to show, camera style, specific action]
  [continue for all scenes needed to fill the duration]
  Final Scene (Xs): [CTA — what to show + text overlay suggestion]
CTA TEXT: [exact CTA copy suggestion]
PRODUCTION NOTES: [2–3 specific notes on tone, pacing, visual style]
WORDS TO AVOID: ${(guardrails.words_to_avoid || []).join(', ')}

Rules:
- Keep the entire brief under 400 words
- Be specific: name hero types/abilities, specific actions, camera movements
- Scene durations must add up to the DURATION value
- Never claim features that don't exist in-game
- Hook must land in the first ${guardrails.hook_window_seconds || 3} seconds`;

  const userPrompt = `Generate a video creative brief for this marketing angle:

ANGLE ID: ${angle.id}
ANGLE NAME: ${angle.name}
STATUS: ${angle.status}
CORE MESSAGE: ${angle.core_message}
EMOTIONAL TERRITORY: ${(angle.emotional_territory || []).join(', ')}
TARGET AUDIENCES: ${(angle.target_audiences || []).join(', ')}
FORMAT: ${angle.format?.style || ''}, ${lengthRange}, ${angle.format?.type || 'video'}
${angle.creative_principle ? `CREATIVE PRINCIPLE: ${angle.creative_principle}` : ''}
${subFormatsText}
CREATIVE DIRECTIONS:
${(angle.creative_directions || []).map((d, i) => `  ${i + 1}. ${d}`).join('\n')}

MESSAGING EXAMPLES:
${(angle.messaging_examples || []).map((m, i) => `  ${i + 1}. "${m}"`).join('\n')}
${angle.cta_variants ? `\nCTA VARIANTS:\n${angle.cta_variants.map((c, i) => `  ${i + 1}. "${c}"`).join('\n')}` : ''}

GAME INFO:
${gameContext || `${game.title} — ${game.genre}, ${game.format}, ${game.match_duration_minutes}-minute matches, ${(game.platforms || []).join(' & ')}`}
${heroDesc ? `\nHERO DESCRIPTION: ${heroDesc}` : ''}${heroSection}

CREATIVE GUARDRAILS:
- Hook window: first ${guardrails.hook_window_seconds || 3} seconds
- Optimal length: ${(guardrails.optimal_video_length_seconds || [15, 30]).join('–')} seconds
- CTA placement: ${guardrails.cta_placement || 'final 3-5 seconds'}
- Never do: ${(guardrails.never_do || []).join('; ')}`;

  console.log(`[Claude] Generating video description for angle "${angle.name}" (id: ${angle.id})`);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    temperature: 1,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return message.content[0]?.text?.trim() || '';
}

/**
 * Plan a podcaster ad — Claude generates image prompt, script, video prompt, and duration.
 * @param {string}   gender            — 'boy' | 'girl'
 * @param {object|null} marketingAngle — Selected angle object from marketing_angles.json (optional)
 * @param {object|null} heroesData     — Parsed Blitz_of_Battle_Heroes.json (optional)
 * @param {object|null} marketingAnglesData — Full marketing_angles.json parsed object (optional)
 * @param {string}   userScript        — User-provided script (optional — if provided, Claude uses it verbatim)
 * @param {string}   gameContext       — Game/brand context (optional)
 * @param {string[]} heroNames         — Hero names to mention (optional)
 * @returns {Promise<{podcasterImagePrompt: string, videoPrompt: string, voiceOverCharacteristics: string, script: string, suggestedDuration: number}>}
 */
export async function planPodcast(gender, marketingAngle, heroesData, marketingAnglesData, userScript = '', gameContext = '', heroNames = [], preferredDuration = null) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env');

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const allowedDurations = [3, 4, 6, 8, 10, 15];

  // Build hero details section
  let heroDetailsSection = '';
  if (heroNames.length > 0 && heroesData?.heroes) {
    const details = heroNames.map(name => {
      const h = heroesData.heroes.find(hero => hero.name === name);
      if (!h) return `  - ${name} (not found in catalog)`;
      return `  - ${h.name} (${h.class}): ${h.lore_description}\n    Abilities: ${(h.abilities || []).map(a => a.name).join(', ')}`;
    }).join('\n');
    heroDetailsSection = `\nHEROES TO MENTION IN THE SCRIPT:\n${details}`;
  }

  // Build marketing angle context
  let angleSection = '';
  if (marketingAngle) {
    angleSection = `\nMARKETING ANGLE: ${marketingAngle.name}\nCore message: ${marketingAngle.core_message}\nEmotional territory: ${(marketingAngle.emotional_territory || []).join(', ')}`;
  }

  const genderPerson = gender === 'girl' ? 'young woman' : 'young man';
  const genderPronoun = gender === 'girl' ? 'She' : 'He';
  const genderVoice = gender === 'girl' ? 'woman' : 'man';

  const scriptInstruction = userScript
    ? `The user has provided their OWN SCRIPT. You MUST use this script VERBATIM as the podcaster's dialogue — do NOT rewrite, rephrase, or alter it in any way. Here is the script:\n"${userScript}"\n\nBase the suggestedDuration on this script's word count (~2.5 words per second). Snap to the nearest allowed duration.`
    : `Write an enthusiastic, natural podcast-style script where the podcaster explains why the audience should download and play Blitz of Battle. Use power words: "dominate", "unstoppable", "epic", "legendary", "claim your throne", "rise to glory". The script should feel like a genuine podcaster recommendation, not a formal ad. Keep it conversational and exciting.${angleSection}${heroDetailsSection}`;

  const systemPrompt = `You are a creative director specializing in podcast-style gaming ad content.

YOUR MISSION: Generate a hyper-realistic podcaster image prompt + a video prompt where the podcaster talks about "Blitz of Battle" mobile game.

GAME CONTEXT:
${gameContext || 'Blitz of Battle — a fast-paced mobile MOBA with 2v2 PvP, 3-minute matches, stylized fantasy heroes with unique abilities. Available on iOS and Android.'}

PODCASTER IMAGE PROMPT RULES:
- Hyper-realistic close-up portrait of a ${genderPerson} aged 22 to 28
- VARY these details each time (do NOT always use the same look):
  * Skin tone (light, medium, tan, brown, dark — vary naturally)
  * Hair style and color (messy, styled, braids, curly, straight, dyed tips, etc.)
  * Specific facial features (jawline, cheekbones, freckles, dimples, etc.)
  * Clothing style (oversized graphic hoodie with gaming logo, band tee, flannel over tshirt, streetwear jacket — always gaming/casual aesthetic)
  * Accessories (small earring, chain necklace, wristband, gaming pin, etc.)
- MUST INCLUDE: Gaming headset with large ear cups resting around neck
- MUST INCLUDE: Leaning slightly forward toward a large professional black studio condenser microphone on a boom arm, natural warm confident smile with genuine joy — slightly parted lips, visible upper teeth, cheeks slightly raised, EYES LOOKING DIRECTLY INTO THE CAMERA with warmth and energy (direct eye contact with the viewer/audience), one hand raised gesturing expressively
- CRITICAL: The podcaster MUST be looking straight into the camera lens — direct eye contact with the audience, NOT looking at the mic, NOT looking sideways
- BACKGROUND (CRITICAL — NOT white, MUST be unique and varied every time): Gaming/streaming room. Pick ONE combination from each category below and commit to it — never use the same combo twice:
  * ROOM DEPTH: choose one — (a) tight close crop with only one monitor visible, blurred bokeh background; (b) medium shot showing full desk setup with two monitors; (c) wide angle showing corner of room with shelves of collectibles on both sides
  * MONITOR CONTENT: choose one — (a) abstract fluid art screensaver in deep purple/gold; (b) looping neon cityscape wallpaper; (c) chill lo-fi animated wallpaper (rainy window, cozy café); (d) green matrix-style data stream screensaver; (e) orange/red lava-lamp gradient; (f) dark minimal wallpaper with glowing geometric shapes — NEVER game gameplay or game UI
  * LIGHTING MOOD: choose one — (a) cool blue/teal LED strips behind monitors, blue rim light on face; (b) warm amber/orange LED on one side, cool purple on the other; (c) single hot-pink neon strip casting harsh shadows; (d) soft green and cyan RGB diffused through acoustic foam; (e) red and deep purple dramatic split-light; (f) white studio softbox on one side, RGB fill on the other
  * WALL TREATMENT: choose one — (a) black pyramid acoustic foam tiles; (b) hexagonal fabric panels in charcoal/grey; (c) exposed brick wall with mounted LED strips; (d) dark pegboard with hanging gear and cables; (e) dark painted wall with neon LED sign ("LIVE", "ON AIR", or abstract shape)
  * DESK SURFACE: choose one — (a) clean minimalist glass desk; (b) dark wood desk with visible cable management clips; (c) black metal desk with scattered gear; (d) white desk with pastel accessories
  * EXTRA DETAIL in background: choose one — (a) action figure or gaming collectible on desk; (b) small plant or cactus on corner shelf; (c) stack of game cases or books; (d) second small ring light visible; (e) coffee mug with steam near keyboard
- RGB glow reflecting off face and clothing matching the chosen lighting mood
- Realistic skin texture, natural studio lighting from above, sharp focus on face and microphone
- End prompt with "Portrait 9:16."

VIDEO PROMPT RULES:
- MUST start with voice-over in this EXACT format:
  "${genderPronoun} says in the voice of a young ${genderVoice}, [TIMBRE], [TONE], [PACING]: \\"dialogue here\\""
- Keep voice descriptors SHORT and SIMPLE — 2-4 words each, no compound adjectives:
  * TIMBRE: pick ONE simple descriptor e.g. "sharp clear voice" / "deep voice" / "bright voice" / "smooth voice" / "crisp voice"
  * TONE: pick ONE CALM tone e.g. "confident tone" / "relaxed tone" / "calm conversational tone" / "steady tone" / "matter-of-fact tone"
  * PACING: pick ONE e.g. "moderate pacing" / "steady pacing" / "natural pacing" / "conversational pacing"
- DO NOT use elaborate multi-word descriptions like "warm and slightly husky timbre" or "enthusiastic and genuinely hyped tone" — these produce AI-sounding voices
- DO NOT use "excited", "energetic", "hyped", "intense", "passionate", "dramatic" — these cause exaggerated facial expressions and unnatural AI-like movement
- GOOD example: "He says in the voice of a young man, sharp clear voice, confident tone, steady pacing: \\"dialogue\\""
- BAD example: "He says in the voice of a young man, warm and slightly husky timbre, enthusiastic and genuinely hyped tone, energetic yet conversational pacing: \\"dialogue\\""
- After the voice line, describe: very subtle slow camera push-in toward the podcaster, calm minimal hand gestures, direct eye contact with the camera, relaxed natural expression, still and composed posture
- EXPRESSION RULES (CRITICAL): The podcaster must look CALM, COMPOSED, and NATURAL — like a real person casually talking to camera. NO exaggerated expressions, NO wide eyes, NO dramatic eyebrow raises, NO over-animated mouth movements, NO theatrical gestures. Think: a chill YouTube creator, NOT a morning TV presenter. Subtle nods and slight smiles only.
- The podcaster is SEATED and STATIONARY — absolutely no dramatic camera movements. Keep it natural: very gentle push-in only, no rack focus shifts, no zooms, minimal movement overall
- The podcaster maintains direct eye contact with the camera/audience the entire time — never looks away
- Video prompt can be up to 2300 characters
- Sound is enabled — Kling will generate the podcaster's voice from the prompt

SCRIPT RULES:
${scriptInstruction}

MODERATION (CRITICAL):
- FORBIDDEN: kill, destroy, crush, eliminate, annihilate, slaughter, gore, blood, death, military, army, soldiers, troops, warfare, explosions, bombs, missiles, firearms, guns
- Use approved alternatives: outplay, outwit, win fast, skill-based victory, dominate the leaderboard, rise to the top

DURATION & SCRIPT LENGTH (CRITICAL):
- Speaking rate: ~2.5 words per second
- Word budget per duration:
${allowedDurations.map(d => `  * ${d}s = max ${Math.floor(d * 2.5)} words`).join('\n')}${preferredDuration ? `
- USER HAS REQUESTED: ${preferredDuration}s. You MUST set suggestedDuration to ${preferredDuration}.
- Write the script to fit EXACTLY ${preferredDuration}s — that means AT MOST ${Math.floor(preferredDuration * 2.5)} words. Count carefully.` : `
- Pick the duration that best matches your script's word count from the table above.
- The script word count MUST NOT exceed the word budget for the chosen duration.
- If you choose 15s, the script must be AT MOST 37 words. If you choose 10s, AT MOST 25 words. Etc.
- If the user provided a script: count its words, pick the matching duration, trim if it exceeds that budget.`}
- suggestedDuration MUST be one of: ${allowedDurations.join(', ')} — ${preferredDuration ? `use ${preferredDuration}` : `must match your script word count`}
- DOUBLE-CHECK: count the words in your script before finalising. If the count exceeds the budget for your chosen duration, either trim the script or pick a longer duration.

OUTPUT FORMAT:
Return ONLY a valid JSON object (no markdown, no code fences):
{
  "podcasterImagePrompt": "Hyper-realistic close-up portrait of a ${genderPerson}...",
  "videoPrompt": "${genderPronoun} says in the voice of a young ${genderVoice}, ...: \\"...\\" Subtle camera push-in...",
  "voiceOverCharacteristics": "${genderPronoun} says in the voice of a young ${genderVoice}, [simple timbre], [simple tone], [simple pacing]",
  "script": "The actual dialogue text the podcaster says",
  "suggestedDuration": 8
}`;

  const userPrompt = `Generate a podcast-style ad for Blitz of Battle. The podcaster is a ${genderPerson}. Create the image prompt, video prompt, script, and suggest the best duration.`;

  console.log(`[Claude] Planning podcast ad (gender: ${gender}, angle: ${marketingAngle?.name || 'none'}, userScript: ${userScript ? 'yes' : 'no'}, heroes: ${heroNames.length})...`);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    temperature: 1,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const responseText = message.content[0]?.text?.trim() || '';
  console.log(`[Claude] Podcast plan response length: ${responseText.length} chars`);

  // Parse JSON
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
        throw new Error(`Claude returned invalid JSON for podcast: ${responseText.slice(0, 200)}...`);
      }
    }
  }

  // Validate and snap duration — preferredDuration always wins if provided
  const suggestedDuration = preferredDuration
    ? snapToAllowed(preferredDuration, allowedDurations)
    : snapToAllowed(parsed.suggestedDuration || 8, allowedDurations);

  const result = {
    podcasterImagePrompt: parsed.podcasterImagePrompt || '',
    videoPrompt: parsed.videoPrompt || '',
    voiceOverCharacteristics: parsed.voiceOverCharacteristics || '',
    script: parsed.script || '',
    suggestedDuration,
  };

  console.log(`[Claude] ✅ Podcast planned | duration: ${result.suggestedDuration}s | script: ${result.script.slice(0, 80)}...`);
  return result;
}

/**
 * Generate a podcaster image prompt only (no script, no heroes, no marketing angle).
 * Much faster than planPodcast — only asks Claude for the image prompt.
 * @param {'boy'|'girl'} gender
 * @returns {Promise<string>} image prompt
 */
export async function buildPodcasterImagePrompt(gender) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env');
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const genderPerson = gender === 'girl' ? 'young woman' : 'young man';

  const prompt = `Generate a hyper-realistic podcaster portrait image prompt for an AI image generator. Return ONLY a JSON object with one key: "imagePrompt".

Rules for the prompt:
- Hyper-realistic close-up portrait of a ${genderPerson} aged 22 to 28
- VARY these details (do NOT use the same look each time):
  * Skin tone (light, medium, tan, brown, dark)
  * Hair style and color (messy, styled, braids, curly, straight, dyed tips, etc.)
  * Facial features (jawline, cheekbones, freckles, dimples, etc.)
  * Clothing (oversized graphic hoodie, band tee, flannel over tshirt, streetwear jacket — always gaming/casual)
  * Accessories (small earring, chain necklace, wristband, gaming pin, etc.)
- MUST INCLUDE: Gaming headset with large ear cups resting around neck
- MUST INCLUDE: Leaning slightly forward toward a large professional black studio condenser microphone on a boom arm, natural warm confident smile with genuine joy — slightly parted lips, visible upper teeth, cheeks slightly raised, EYES LOOKING DIRECTLY INTO THE CAMERA with warmth and energy
- BACKGROUND (CRITICAL — MUST be unique and varied every time — never the same setup twice): Gaming/streaming room. Pick ONE option from each category and commit to it:
  * ROOM DEPTH: (a) tight close crop, one monitor blurred bokeh; (b) medium shot full desk with two monitors; (c) wide angle showing corner with shelves on both sides
  * MONITOR CONTENT: (a) abstract fluid art in purple/gold; (b) neon cityscape wallpaper; (c) lo-fi animated wallpaper (rainy window); (d) green matrix data stream; (e) orange/red lava-lamp gradient; (f) dark geometric glowing shapes — NEVER game gameplay
  * LIGHTING MOOD: (a) cool blue/teal LED, blue rim light; (b) warm amber one side, cool purple other side; (c) hot-pink neon strip harsh shadows; (d) soft green and cyan through acoustic foam; (e) red and deep purple split-light; (f) white softbox one side, RGB fill other
  * WALL: (a) black pyramid acoustic foam; (b) hexagonal fabric panels; (c) exposed brick with LED strips; (d) dark pegboard with hanging gear; (e) dark wall with neon LED sign
  * DESK: (a) glass minimalist; (b) dark wood with cable clips; (c) black metal with scattered gear; (d) white desk with pastel accessories
  * EXTRA: (a) gaming collectible on desk; (b) small plant on shelf; (c) stack of game cases; (d) visible ring light; (e) coffee mug near keyboard
- RGB glow on face matching chosen lighting mood
- Realistic skin texture, natural studio lighting, sharp focus on face
- End with "Portrait 9:16."

Return only: {"imagePrompt": "..."}`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude returned no JSON');
  const parsed = JSON.parse(match[0]);
  if (!parsed.imagePrompt) throw new Error('No imagePrompt in response');
  return parsed.imagePrompt;
}
