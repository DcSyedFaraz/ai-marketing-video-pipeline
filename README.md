# Runware Video Generator

Generate AI videos via the Runware API. Supports:
- **KlingAI Avatar 2.0 Pro** — talking avatar videos from image + audio
- **Google Veo 3.1** — cinematic text-to-video generation

## Project structure

```
.
├── server.js           # GUI web server (Express) — START HERE
├── public/
│   └── index.html      # Web GUI (open in browser)
├── kling-avatar.js     # CLI: KlingAI Avatar 2.0 Pro
├── index.js            # CLI: Veo 3.1 video generation
├── extend.js           # CLI: Extend a Veo video by 7 s
├── full-pipeline.js    # CLI: Both Veo steps in one run
├── .env                # Your API key
├── .env.example
├── package.json
└── output/             # All generated videos saved here
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Add your API key
cp .env.example .env
# Edit .env and replace  your_api_key_here  with your real key
# Get a free key at https://runware.ai
```

## GUI (Recommended)

Launch the web interface — supports both Avatar and Veo generation:

```bash
npm start
# or
npm run gui
# or
node server.js
```

Open **http://localhost:3000** in your browser.

### Avatar Video tab
1. Upload a portrait image (JPG/PNG/WEBP, min 300×300 px)
2. Upload an audio file (MP3/WAV/M4A/AAC, 2–300 sec)
3. Optionally enter a style prompt
4. Click **Generate Avatar Video**

### Text-to-Video tab
1. Enter a text prompt describing the scene
2. Choose model, duration, and orientation
3. Click **Generate Video**

---

## CLI Usage

### KlingAI Avatar 2.0 Pro

```bash
npm run avatar -- ./path/to/face.jpg ./path/to/speech.mp3
# with optional prompt:
node kling-avatar.js ./face.jpg ./speech.mp3 "Speak with enthusiasm"
```

Output: `output/avatar_video.mp4`

### Google Veo 3.1

```bash
npm run full          # Full pipeline (generate + extend)
npm run generate      # Generate only → output/video1.mp4
npm run extend        # Extend video1 → output/video2_extension.mp4

# Extend a specific video with custom prompt:
node extend.js path/to/video.mp4 "Your extension prompt here"
```

---

## Model Details

### KlingAI Avatar 2.0 Pro

| Parameter | Details |
|-----------|---------|
| Model ID | `klingai:avatar@2.0-pro` |
| Image | JPG/PNG/WEBP · min 300×300 · max 10 MB · aspect 1:2.5–2.5:1 |
| Audio | MP3/WAV/M4A/AAC/OGG · 2–300 sec · max 5 MB |
| Prompt | Optional · max 2500 chars |
| Cost | ~$0.087 / second of output |
| Languages | Multilingual |

### Google Veo 3.1

| Setting | Options |
|---------|---------|
| `model` | `google:3@2` or `google:3@3` |
| `duration` | 7, 14, 21 seconds (multiples of 7) |
| `resolution` | 1280×720 (landscape) or 720×1280 (portrait) |
| Cost | ~$0.20 / second (720p) |

---

## API References

- Video inference API: https://runware.ai/docs/video-inference/api-reference
- KlingAI Avatar 2.0 Pro: https://runware.ai/models/klingai-avatar-2-0-pro
- Veo 3.1 model: https://runware.ai/models/google-veo-3-1
- KlingAI provider docs: https://runware.ai/docs/providers/klingai
