# Cal Photo

A personal, zero-cost clone of the Cal AI experience: photograph a meal, get calories, protein, carbs and fat, log it against daily goals.

- No backend, no account, no subscription. It is a static web app you install to your phone's home screen.
- Photo analysis uses the **Google Gemini API free tier** (no card required). Your key is stored only on your device.
- All meals, photos, weights and goals live in your browser's storage. Nothing is uploaded except the photo you send to Gemini for analysis.

## Set it up (about 5 minutes)

### 1. Host it for free on GitHub Pages
1. In this repo on GitHub go to **Settings → Pages**.
2. Under **Build and deployment → Source** choose **GitHub Actions**.
3. Merge this branch into `main` (or run the *Deploy to GitHub Pages* workflow from the **Actions** tab on this branch).
4. Your app will be at `https://<your-username>.github.io/calories/`.

Alternative: any static host works (Netlify, Cloudflare Pages, Vercel free tiers). Opening `index.html` straight from disk also works for testing, but the camera and install-to-home-screen need HTTPS.

### 2. Get a free Gemini API key
1. Open https://aistudio.google.com/apikey and sign in with a Google account.
2. Click **Create API key**, copy it.
3. Paste it into the app during onboarding, or later in **Settings → Photo AI**. Tap **Test connection** to confirm.

The free tier has per-model rate limits (requests per minute / per day). See your current limits at https://aistudio.google.com/rate-limit. For one person logging meals this is far more than enough. If you ever hit a limit the app tells you and you can switch models in Settings.

Do **not** add billing to the Google Cloud project behind the key. Without billing the key cannot spend money.

### 3. Install to your phone
- **iPhone (Safari):** open the URL → Share → **Add to Home Screen**.
- **Android (Chrome):** open the URL → menu → **Add to Home screen** / **Install app**.

## What it does
- Onboarding calculates calorie and macro targets from gender, age, height, weight, activity and goal pace (Mifflin-St Jeor). Edit any number in Settings.
- Home: 7-day strip, calories left ring, protein / carbs / fat rings, today's meals, streak.
- Add meal: **Scan food** (camera), **Gallery**, **Describe** (text), **Barcode** (Open Food Facts, free), **Manual**.
- Result screen: name, servings stepper, per-ingredient breakdown you can edit, health score, **Fix results** (tell the AI what it got wrong and it re-estimates).
- Progress: weight log with chart, calories per day vs goal, weekly macro averages.
- Settings: goals, personal details, AI provider and model, backup export / import, wipe.
- Works offline for viewing and manual logging (service worker). Photo analysis needs a connection.

### Gemini not working? Use OpenRouter (also free)
If Google refuses your key ("permission denied", region errors, work account restrictions):
1. Sign up at https://openrouter.ai with Google or email. No card.
2. Create a key at https://openrouter.ai/keys.
3. In the app: **Settings → Photo AI → Provider → OpenRouter**, paste the key, keep the suggested free model, tap **Test connection**, then **Save**.

Free models allow 50 requests a day and 20 a minute. Quality is a step below Gemini but fine for meals.

## Honest notes on accuracy
Photo calorie estimation is a guess about portion size. Cal AI itself is typically off by 10 to 30 percent on mixed dishes, and so is this. Use **Fix results** when the portion looks wrong, and use barcode or manual entry for packaged food where exact numbers exist.

## Optional: Claude instead of Gemini
Settings lets you switch the provider to Anthropic Claude. Anthropic has **no free tier**; every photo is billed to your API account. Leave this on Gemini unless you have decided to pay.

## Files
```
index.html            app shell
css/styles.css        styling (light + dark)
js/app.js             screens, state, flows
js/ai.js              Gemini / Claude requests, image resizing, Open Food Facts
js/nutrition.js       goal math
js/db.js              IndexedDB wrapper for meals + photos
sw.js                 offline shell cache
manifest.webmanifest  PWA install metadata
.github/workflows/pages.yml   GitHub Pages deploy
```

## Backups
Everything is in the browser. If you clear site data or lose the phone, the log is gone. Use **Settings → Export backup** now and then; the file can be re-imported on any device. API keys are deliberately excluded from backups.
