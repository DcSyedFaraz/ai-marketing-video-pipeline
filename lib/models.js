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
  'google/veo-3.1': 0.20,
  'google:3@3': 0.15,
};

export const LIPSYNC_MODELS = {
  'pixverse:lipsync@1': { label: 'PixVerse LipSync', provider: 'PixVerse' },
  'sync:lipsync-2-pro@1': { label: 'Sync LipSync 2 Pro', provider: 'Sync' },
};
