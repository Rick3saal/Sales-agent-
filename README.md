# Flightdesk — live flight sales copilot

A prototype for English-language call transcription, short live sales coaching, and optional indicative flight searches. The Mac desktop app packages the local server and UI, so Node.js and Terminal are not needed for installation. No call is monitored automatically: start and stop each session yourself.

## Quick fix for "Transcription failed (provider returned 429)"

A `429` comes from the AI provider, not from a bug in the UI. It means **rate limited or out of quota**. Open **Settings → Test connection** (or `GET /api/test` in the browser version) to see which key is failing and why:

| Code | What it means | What to do |
| --- | --- | --- |
| `invalid_key` | Key rejected (401) | Paste a real key in Settings. A ChatGPT Plus/Pro subscription is **not** an API key. |
| `quota_exhausted` | `insufficient_quota` / no billing | Add billing/credits in the provider console, or switch the AI provider. Retrying cannot fix this. |
| `rate_limited` | Requests-per-minute limit | Flightdesk retries with exponential backoff and honours `Retry-After`. Use one audio source, or raise the plan limit. |
| `no_access` / `model_unavailable` | Key cannot use the model | Change the model under **Advanced** in Settings, or switch provider. |
| `network_error` / `provider_unavailable` | Connectivity or 5xx | Automatically retried; check the connection. |

The app now also: serialises transcription chunks (one at a time, with a bounded queue), throttles coaching calls, retries transient `429`/`5xx` failures with backoff, and falls back to the other configured provider. The green "AI connected" dot only means keys are present — use **Test connection** to actually validate them.

## Mac desktop app

Download the matching `.dmg` from the GitHub release: `arm64` for Apple silicon (M-series) or `x64` for Intel. Open it and drag Flightdesk to Applications, then open Flightdesk. These builds are **not Apple-notarized** and macOS may block them. Only if you trust this build, use the macOS Privacy & Security controls to allow it. This is not an Apple-signed or verified release.

When prompted, open **Settings** and paste your keys. Credentials are encrypted using OS secure storage and kept in Flightdesk's user data on your Mac; blank fields retain saved values, and **Remove saved credentials** deletes them.

**Key safety:** never paste keys into chat, issues, or GitHub. OpenAI API keys look like `sk-…`; Google AI Studio (Gemini) keys look like `AIza…`. If a key has been shared anywhere, revoke and rotate it in the provider console immediately. This repository contains no credentials — `.env` is gitignored and the desktop app stores keys only on your Mac.

Test first by entering a customer question in the Conversation box, then click **Test connection** in Settings. For live calls, follow the audio routing instructions below. The desktop app does not automatically capture calls from RingCentral: use a supported audio source, and grant the necessary permissions. For cross-app audio on Mac, a virtual/aggregate audio device may still be required. Obtain required consent from all participants. Flight search offers are indicative only, and the app does not issue tickets.

## AI providers

Settings → **AI provider**:

- **Auto** (default): OpenAI first; if a request fails, it is retried with Gemini. With both keys configured, call audio/transcripts may be sent to **both** providers — get consent for every provider you enable.
- **OpenAI only**: `gpt-4o-mini-transcribe` for audio and `gpt-4.1` for coaching (both changeable under Advanced). Needs a funded OpenAI API account; API usage is billed.
- **Gemini only**: a key from [Google AI Studio](https://aistudio.google.com) with the Gemini API enabled. Audio is sent inline to `gemini-2.5-flash` (configurable). Note that audio container support depends on the provider; Chrome records `audio/webm` (Opus), and if a provider rejects that format Flightdesk reports `audio_format` — try the other provider or a different browser.

Change `OPENAI_TRANSCRIBE_MODEL`, `OPENAI_COACH_MODEL`, or `GEMINI_MODEL` under **Advanced → model overrides** if a model name is no longer available to your account. **Test connection** validates each saved key with a cheap, non-audio request and reports the exact failure code.

## Developer / browser setup

1. Install [Node.js 20 or later](https://nodejs.org/), then in this folder run `npm install`.
2. Copy `.env.example` to `.env` (`cp .env.example .env`) and add `OPENAI_API_KEY` and/or `GEMINI_API_KEY`. Set `AI_PROVIDER` to `auto`, `openai` or `gemini`.
3. Run `npm start` and open **http://localhost:3000** on the same Mac. Credentials remain on the server, not in browser JavaScript. The server listens on loopback by default; don't expose it publicly, since it has no authentication.
4. Check `http://localhost:3000/api/test` for a per-provider key check. Settings in the browser is read-only; change keys in `.env` and restart the server.
5. For a text-only test, enter a customer question under **Conversation**. For audio, grant browser/macOS permissions, confirm consent, select your sources, and start listening. Stop when the call is over. Clear removes the displayed session; reloading also clears it.

## Capturing both sides of calls on macOS

Browser apps cannot silently tap every RingCentral or browser call. Microphone capture alone usually only hears you; headphones may prevent it hearing the customer. Use a supported browser such as Chrome, and grant Microphone and, where relevant, Screen & System Audio Recording permissions in macOS Privacy & Security. Choose one of the following:

- **Shared audio:** check "Shared tab or screen audio" and choose a source with audio sharing enabled in the browser picker. Depending on Chrome/macOS versions and the chosen source, sharing system or app audio may not be available. The app detects when the picker supplies no audio track. Browser-tab audio may work for browser calls, but does not automatically capture the RingCentral desktop app. Use microphone capture as a separate source to hear yourself.
- **Virtual audio:** install/configure a trusted virtual audio device (for example BlackHole) and use macOS Audio MIDI Setup and your call app's audio settings to route the remote call audio to it while still monitoring it through your headphones. If you also want your own microphone, create an aggregate input that includes both, select that aggregate as the audio input in Flightdesk, and test it before a real call. Exact routing varies by hardware and macOS. A multi-output device can help route playback to both the virtual device and your headphones; check its clock/drift settings. Avoid feedback loops. An aggregate input is transcribed as one mixed source, not diarized speakers.

The app uses short audio chunks, so there will be a few seconds of capture, transcription and model latency; it is not instant or guaranteed to hear every word. Separate mic and shared sources are labeled by source, not identified by speaker. Overlapping speech, missed chunks, provider errors and out-of-order responses are possible. If the provider falls behind, the oldest queued chunk is dropped and the UI warns you. Always verify the transcript and advice before speaking. Don't use the virtual input and shared audio simultaneously if they contain the same sound, or you may get duplicates.

## Flight search (optional, Amadeus)

The Amadeus integration **already exists in this repo**: `GET /api/flights` in `server.js`, validated by `validateFlightQuery`, with the form in `public/index.html`. What you need is credentials, not code:

1. Create a free [Amadeus Self-Service](https://developers.amadeus.com) account and an app.
2. Set `AMADEUS_CLIENT_ID` and `AMADEUS_CLIENT_SECRET` in Settings (or `.env` for the browser version).
3. Keep `AMADEUS_ENV=test`. Test offers may be synthetic/limited; production requires approved production access.

Search by three-letter IATA airport/city codes, dates, adults, and cabin. Availability, coverage and fare rules depend on Amadeus and its environment. Results are indicative only; reprice and verify all baggage, restrictions, total costs and availability in your authorized booking system before quoting. This app does **not** book, take payment or issue tickets.

Other providers (Sabre, etc.) require commercial agreements and their own credentials, so switching providers cannot create working API access for you. Apollo is a sales-intelligence product, not a flight-shopping API. Google Flights / ITA Matrix are not directly integrated; access to Google search results or booking data generally requires a suitable licensed provider. Never assume an unofficial scraping key provides booking or ticket issuance.

## Privacy, consent and limitations

Obtain the required consent from everyone on the call and comply with applicable recording, privacy, and workplace rules. Microphone/system audio chunks and transcript text are sent to OpenAI and/or Gemini (depending on the provider setting), and flight queries go to Amadeus. In **Auto** mode a failed request may be retried with the other AI provider, so both may receive call content — only enable keys for providers your consent covers. Review your provider agreements, data-retention settings, and sensitive-data obligations before use. This prototype does not persist transcripts or recordings itself, but providers may retain data under their policies. Do not enter card details or other sensitive personal information. No authentication, encryption at rest, audit trail, speaker diarization, native always-on capture, CRM connection or booking workflow is included. The model can make mistakes; use judgment and do not promise unverified fares or outcomes.

The coaching incorporates the discovery, listening, objection clarification, value, cost-of-inaction and follow-up ideas in the provided playbook, with safeguards against high-pressure tactics, fabricated claims and disregarding a customer's decision. Live flight search results are not automatically fed into the coaching model; share verified, non-sensitive details as a manual note if needed.

Run tests with `npm test`.
