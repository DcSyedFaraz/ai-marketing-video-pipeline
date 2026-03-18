// ---- Model catalogues ----

export const AVATAR_MODELS = [
  {
    id: 'klingai:avatar@2.0-pro',
    label: 'KlingAI Avatar 2.0 Pro',
    provider: 'KlingAI',
    description: 'Highest fidelity, smoothest motion, production-ready',
    cost: '$0.087/sec',
    costPerSec: 0.087,
    badge: 'PRO',
  },
  {
    id: 'klingai:avatar@2.0-standard',
    label: 'KlingAI Avatar 2.0 Standard',
    provider: 'KlingAI',
    description: 'Faster, more economical, great for longer content',
    cost: '$0.044/sec',
    costPerSec: 0.044,
    badge: 'STANDARD',
  },
  {
    id: 'bytedance:5@2',
    label: 'OmniHuman 1.5',
    provider: 'ByteDance',
    description: 'High fidelity, multi-subject, context-aware gestures',
    cost: '~$0.13/sec',
    costPerSec: 0.13,
    badge: 'NEW',
  },
  {
    id: 'bytedance:5@1',
    label: 'OmniHuman 1',
    provider: 'ByteDance',
    description: 'Strong generalization across portraits, cartoons, full body',
    cost: '~$0.10/sec',
    costPerSec: 0.10,
    badge: null,
  },
];

export const VEO_COST = {
  'google:3@2': 0.20,
  'google:3@3': 0.15,
};

export const LIPSYNC_MODELS = {
  'pixverse:lipsync@1': { label: 'PixVerse LipSync', provider: 'PixVerse' },
  'sync:lipsync-2-pro@1': { label: 'Sync LipSync 2 Pro', provider: 'Sync' },
};

export const STORY_VIDEO_MODELS = [
  {
    id: 'google:3@3',
    label: 'Google Veo 3.1 Fast',
    provider: 'Google',
    description: 'Faster generation, good quality',
    cost: '$0.15/sec',
    costPerSec: 0.15,
    allowedDurations: [4, 6, 8],
    maxRefImages: 0,
    badge: 'FAST',
  },
  {
    id: 'google:3@2',
    label: 'Google Veo 3.1',
    provider: 'Google',
    description: 'Highest quality, cinematic output',
    cost: '$0.20/sec',
    costPerSec: 0.20,
    allowedDurations: [4, 6, 8],
    maxRefImages: 3,
    badge: 'PRO',
  },
  {
    id: 'klingai:kling-video@o3-pro',
    label: 'KlingAI Kling Video O3 Pro',
    provider: 'KlingAI',
    description: 'High fidelity, smooth motion, sound generation',
    cost: '$0.087/sec',
    costPerSec: 0.087,
    allowedDurations: [3, 4, 6, 8, 10],
    maxRefImages: 7,
    badge: null,
  },
  {
    id: 'klingai:kling-video@3-standard',
    label: 'Kling 3.0 Standard',
    provider: 'KlingAI',
    description: 'High quality with sound, cost-effective',
    cost: '$0.126/sec',
    costPerSec: 0.126,
    allowedDurations: [3, 4, 6, 8, 10],
    maxRefImages: 0,
    badge: 'NEW',
  },
  {
    id: 'klingai:kling-video@3-pro',
    label: 'Kling 3.0 Pro',
    provider: 'KlingAI',
    description: 'Top-tier quality with sound generation',
    cost: '$0.168/sec',
    costPerSec: 0.168,
    allowedDurations: [3, 4, 6, 8, 10],
    maxRefImages: 0,
    badge: 'PRO',
  },
];
