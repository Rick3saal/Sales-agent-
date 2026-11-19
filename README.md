# Flightdesk — live flight sales copilot

A prototype for English-language call transcription, short live sales coaching, and optional indicative flight searches. The Mac desktop app packages the local server and UI, so Node.js and Terminal are not needed for installation. No call is monitored automatically: start and stop each session yourself.

## Mac desktop app

Download the matching `.dmg` from the GitHub release: `arm64` for Apple silicon (M-series) or `x64` for Intel. Open it and drag Flightdesk to Applications, then open Flightdesk. These builds are **not Apple-notarized** and macOS may block them. Only if you trust this build, use the macOS Privacy & Security controls to allow it. This is not an Apple-signed or verified release.

When prompted, paste your OpenAI API key into Settings and click Save. You can reopen Settings anytime. Credentials are encrypted using the OS secure storage and stored in Flightdesk's user data on your Mac; blank fields retain saved values, and Remove saved credentials deletes them. An OpenAI API account with billing is required. Optionally add Amadeus Self-Service credentials for flight search. Do not put credentials in GitHub or chat.

Test first by entering a customer question in the Conversation box. For live calls, follow the audio routing instructions below. The desktop app does not automatically capture calls from RingCentral: use a supported audio source, and grant the necessary permissions. For cross-app audio on Mac, a virtual/aggregate audio device may still be required. Audio is sent to OpenAI; obtain required consent from all participants. Flight search offers are indicative only, and the app does not issue tickets.

## Developer / browser setup

## Setup

1. Install [Node.js 20 or later](https://nodejs.org/), then in this folder run `npm install`.
2. Copy `.env.example` to `.env` (`cp .env.example .env`) and add `OPENAI_API_KEY`. The default coach is `gpt-4.1`; you can change `OPENAI_COACH_MODEL` to a model available to your account. Transcription defaults to `gpt-4o-mini-transcribe`. Both incur provider charges and require API access; a ChatGPT subscription is not an API key.
3. Run `npm start` and open **http://localhost:3000** on the same Mac. Credentials remain on the server, not in browser JavaScript. The server listens on loopback by default; don't expose it publicly, since it has no authentication.
4. For a text-only test, enter a customer question under **Conversation**. For audio, grant browser/macOS permissions, confirm consent, select your sources, and start listening. Stop when the call is over. Clear removes the displayed session; reloading also clears it.

## Capturing both sides of calls on macOS

Browser apps cannot silently tap every RingCentral or browser call. Microphone capture alone usually only hears you; headphones may prevent it hearing the customer. Use a supported browser such as Chrome, and grant Microphone and, where relevant, Screen & System Audio Recording permissions in macOS Privacy & Security. Choose one of the following:

- **Shared audio:** check “Shared tab or screen audio” and choose a source with audio sharing enabled in the browser picker. Depending on Chrome/macOS versions and the chosen source, sharing system or app audio may not be available. The app detects when the picker supplies no audio track. Browser-tab audio may work for browser calls, but does not automatically capture the RingCentral desktop app. Use microphone capture as a separate source to hear yourself.
- **Virtual audio:** install/configure a trusted virtual audio device (for example BlackHole) and use macOS Audio MIDI Setup and your call app's audio settings to route the remote call audio to it while still monitoring it through your headphones. If you also want your own microphone, create an aggregate input that includes both, select that aggregate as the audio input in Flightdesk, and test it before a real call. Exact routing varies by hardware and macOS. A multi-output device can help route playback to both the virtual device and your headphones; check its clock/drift settings. Avoid feedback loops. An aggregate input is transcribed as one mixed source, not diarized speakers.

The app uses short audio chunks, so there will be a few seconds of capture, transcription and model latency; it is not instant or guaranteed to hear every word. Separate mic and shared sources are labeled by source, not identified by speaker. Overlapping speech, missed chunks, provider errors and out-of-order responses are possible. Always verify the transcript and advice before speaking. Don't use the virtual input and shared audio simultaneously if they contain the same sound, or you may get duplicates.

## Flight search

Optional: create an Amadeus Self-Service account and set `AMADEUS_CLIENT_ID` and `AMADEUS_CLIENT_SECRET`. `AMADEUS_ENV=test` is the default and may return synthetic or limited data; production requires approved production access and `AMADEUS_ENV=production`. Search by three-letter IATA airport/city codes, dates, adults, and cabin. Availability, coverage and fare rules depend on Amadeus and its environment. Results are indicative only; reprice and verify all baggage, restrictions, total costs and availability in your authorized booking system before quoting. This app does **not** book, take payment or issue tickets.

Google Flights / ITA Matrix are not directly integrated; access to Google search results or booking data generally requires a suitable licensed provider or other authorized integration. Never assume an unofficial Google scraping key provides booking or ticket issuance.

## Privacy, consent and limitations

Obtain the required consent from everyone on the call and comply with applicable recording, privacy, and workplace rules. Microphone/system audio chunks and transcript text are sent to OpenAI; flight queries go to Amadeus. Review your provider agreements, data-retention settings, and sensitive-data obligations before use. This prototype does not persist transcripts or recordings itself, but providers may retain data under their policies. Do not enter card details or other sensitive personal information. No authentication, encryption at rest, audit trail, speaker diarization, native always-on capture, CRM connection or booking workflow is included. The model can make mistakes; use judgment and do not promise unverified fares or outcomes.

The coaching incorporates the discovery, listening, objection clarification, value, cost-of-inaction and follow-up ideas in the provided playbook, with safeguards against high-pressure tactics, fabricated claims and disregarding a customer's decision. Live flight search results are not automatically fed into the coaching model; share verified, non-sensitive details as a manual note if needed.

Run tests with `npm test`.
