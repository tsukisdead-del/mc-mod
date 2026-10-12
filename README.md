# Dr. Mochi: a cartoon AI therapist you can text

A private texting app where you talk to **Dr. Mochi**, a cartoon therapist powered by Claude. You type or talk out loud, and it texts back. You can send it photos and documents to look at, it texts *you* first to check in, and a slider controls how gentle or how real it is with you. It installs on your iPhone like a normal app.

![Dr. Mochi screens](docs/preview.png)

## What it does

- **Texting.** Replies stream in like someone typing and come as separate texts. The cartoon's face reacts to what it's saying: warm, laughing, thinking, concerned, proud, or curious.
- **Talking.** Tap the mic (or the face at the top) to talk out loud. Your words go in as texts and Dr. Mochi texts back. It can also read its replies out loud, and **hands-free** mode keeps listening after each reply so it feels like a conversation.
- **Photos and documents.** Send photos (screenshots of a group chat, a picture of your room, anything) and PDFs, Word (.docx) or text files (journals, letters, worksheets). It actually reads them and responds to what's in them.
- **It texts you first.** Check-ins arrive as phone notifications. In Settings you choose:
  - on or off
  - how often (every few days → every few hours)
  - which hours it's allowed to text you
  - what check-ins are about: how you're feeling, follow-ups on things you talked about, encouragement, self-care reminders

  If you ignore a few check-ins it backs off, and it pauses entirely until you reply. It can also notify you when a reply finishes after you've closed the app.
- **Tone slider.** From **0 (gentle & therapeutic)** through **50 (balanced)** to **100 (keep it real)**, with jokes, banter and blunt honesty at the top end. There are also switches for cursing and emojis.
- **Memory.** It keeps short private notes about you (people in your life, what you're working on, things to follow up on) so it remembers between chats. You can read, edit, or erase them in Settings.
- **Safety first.** At any tone setting, if you mention self-harm, suicide, or being in danger, it drops the jokes, checks on your safety, and shows a card with one-tap links to 988 and the Crisis Text Line. The ♡ button at the top always opens those resources.

> Dr. Mochi is an AI, not a licensed therapist. It can be wrong, and it isn't for emergencies. If you might hurt yourself or someone else, call or text **988** in the US, text **HOME** to **741741**, or call your local emergency number.

---

## Set it up (about 15 minutes)

You need two things: a **Claude API key** (this is what makes Dr. Mochi think) and somewhere to **host the app** so your phone can reach it, even when your computer is off.

### 1. Get a Claude API key

1. Go to [console.anthropic.com](https://console.anthropic.com), sign up, and add a payment method under **Billing**.
2. Open **API Keys** → **Create Key**, and copy it. It starts with `sk-ant-`.

You pay per message. With the default model, a normal text exchange costs roughly a cent or a few cents; photos and long documents cost more. To spend less, set `CLAUDE_MODEL` to `claude-sonnet-5-5` (cheaper) or `claude-haiku-5-5` (much cheaper).

### 2. Pick an access code

Make up a private code, like a password. Anyone with your app's address *and* this code could read your chats, so make it long and don't reuse one from somewhere else.

### 3. Host the app

The app has to stay running all the time, so check-ins can go out, and it needs a disk that survives restarts, so your chats and memory are kept. Free tiers that sleep or wipe their disk won't work well.

**Option A: Render (easiest)**

1. Create an account at [render.com](https://render.com) and connect your GitHub.
2. Click **New → Blueprint** and pick this repository. Render reads `render.yaml` and sets up a web service with a 1 GB disk on the Starter plan.
3. When it asks, paste your `ANTHROPIC_API_KEY` and your `ACCESS_CODE`.
4. After it deploys, you'll get an address like `https://dr-mochi-xxxx.onrender.com`.

**Option B: Railway**

1. Create a project at [railway.app](https://railway.app) → **Deploy from GitHub repo** → pick this repo. It builds the included `Dockerfile`.
2. Add a **Volume** mounted at `/data`.
3. Under **Variables**, add `ANTHROPIC_API_KEY` and `ACCESS_CODE`.
4. Under **Settings → Networking**, click **Generate Domain** to get your https address.

**Option C: Any server with Docker**

```bash
docker build -t dr-mochi .
docker run -d --restart unless-stopped -p 3000:3000 -v mochi-data:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... -e ACCESS_CODE=your-code -e PUBLIC_URL=https://your.domain \
  dr-mochi
```

Put it behind https (for example with Caddy or a Cloudflare Tunnel). The mic, notifications, and installing on iPhone all require https.

### 4. Put it on your iPhone

On your iPhone, open **`https://YOUR-ADDRESS/install` in Safari**. On a computer, that page shows a QR code you can scan with your phone. Then follow the steps on the page:

**Install profile (the iOS configuration profile)**

1. Tap **Download install profile**, then **Allow**.
2. Open the **Settings** app → tap **Profile Downloaded** near the top → **Install**, enter your passcode, then **Install** again.
   It says "Not Verified" because it's your own unsigned profile; that's expected. The profile only adds a full-screen Home Screen icon. It doesn't manage or monitor anything on your phone, and you can remove it anytime in **Settings → General → VPN & Device Management**.
3. Open **Dr. Mochi** from your Home Screen and type your access code.

**Or: Add to Home Screen**

In Safari, tap **Share → Add to Home Screen**. This method is the most reliable for notifications.

The profile is generated by the server at `/app.mobileconfig`, already pointed at your address. If you want the file itself, for example to AirDrop it, run `npm run profile -- https://YOUR-ADDRESS`.

### 5. Turn on notifications

In the app, tap the **sliders icon** (top right) → **Check-ins** → **Notifications: Turn on** → **Allow**. Then tap **Test notification**. iPhone notifications for web apps need **iOS 16.4 or newer** and only work in the Home Screen app, not in a Safari tab. If you installed with the profile and the app never asks for permission, delete that icon and use **Add to Home Screen** instead.

---

## Settings at a glance

| Setting | What it does |
| --- | --- |
| **Tone** slider | 0 = gentle & therapeutic, 50 = balanced, 100 = keep it real (jokes, blunt honesty). The face previews the vibe as you slide. |
| Cursing / Emojis | Whether it swears and uses emojis. |
| **Text me first** | Turns check-ins on or off. |
| How often / Between | Check-in frequency and the hours it's allowed to text you (in your phone's time zone). |
| Check-in topics | Mood check-ins, follow-ups on what you talked about, encouragement, self-care reminders. |
| Notify when a reply finishes | If you leave the app mid-reply, you get the reply as a notification. |
| Send me a check-in now | See what a check-in looks like right away. |
| Voice | Read replies out loud, pick the voice and speed, send when you stop talking, hands-free. Saved per device. |
| Personalize | Rename the therapist; tell it what to call you. |
| Memory | View, edit, refresh, or erase what it remembers about you. |
| Your data | Download your chats as JSON, delete chat history, lock the app. |

## Privacy

- Your chats, memory notes and uploaded files are stored only on **your** server, in `DATA_DIR`.
- Messages, and the photos and files you send, go to Anthropic's API to generate replies. See Anthropic's [privacy policy](https://www.anthropic.com/legal/privacy).
- The app is locked behind your access code with an HttpOnly cookie. Changing `ACCESS_CODE` logs every device out.
- **Delete chat history** removes all messages and uploaded files from the server. **Erase** (under Memory) wipes the notes.

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | | Your Claude API key. |
| `ACCESS_CODE` | yes | | The code you type to unlock the app. |
| `DATA_DIR` | | `./data` | Where chats, memory, uploads and push keys live. Use a persistent disk. |
| `PUBLIC_URL` | | auto | Your https address. Detected automatically on Render and Railway. Used in the iPhone profile and QR code. |
| `CLAUDE_MODEL` | | `claude-opus-5-5` | Try `claude-sonnet-5-5` or `claude-haiku-5-5` to lower cost. |
| `CHAT_EFFORT` | | `medium` | `low` replies faster; `high` thinks harder. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | | generated | Push notification keys, generated once and saved in `DATA_DIR`. |
| `VAPID_SUBJECT` | | your URL | Contact address push services can use (`mailto:` or https). |
| `MOCK_AI` | | | Set to `1` for canned replies with no API key (demo/testing). |

## Run it on your computer

Requires Node.js 20.12 or newer.

```bash
npm install
npm run demo          # canned replies, access code "demo" → http://localhost:3000
cp .env.example .env  # then fill in ANTHROPIC_API_KEY and ACCESS_CODE
npm start             # the real thing
npm test              # unit tests
```

To try it on your phone before deploying, expose your computer over https, e.g. `cloudflared tunnel --url http://localhost:3000`, and open the printed address in Safari.

## How it works

- `server/`: Express app. `ai.js` talks to Claude with streaming, prompt caching and a server-side safety fallback; `prompts.js` holds the persona, tone bands and check-in instructions; `scheduler.js` decides when to check in; `push.js` sends Web Push notifications; `profile.js` builds the iPhone `.mobileconfig`; `store.js` keeps everything in one JSON file.
- `public/`: the installable web app (no build step). `js/avatar.js` is the cartoon (one SVG, with expressions driven by CSS), `js/voice.js` handles speech recognition and read-aloud, and `sw.js` is the service worker for notifications and offline loading.
- Each reply starts with a hidden `[[mood:…]]` tag that sets the cartoon's face, and uses `|||` to split into separate texts. A `[[crisis]]` tag shows the help card.
- `npm run icons` regenerates the app icons from the cartoon (needs Playwright + Chromium).
