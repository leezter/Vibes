Vibes — Offline Browser DJ

A lightweight, open-source, client-side DJ app built with the Web Audio API. Load local files, mix two decks, set hot cues, and analyze tracks — all in the browser. No servers, no uploads, fully offline after first load.

Features (partial implementation):
- Two decks with drag-and-drop or file picker load
- Play/Pause, Cue, Hot cues 1..8
- Jog wheel visuals, waveform rendering
- Mixer with crossfader and per-channel gain
- Offline analysis worker to compute basic peaks and BPM estimate
- IndexedDB caching for analysis
- PWA service worker for offline shell

How to run locally
1) Serve the folder with a static server (recommended). For quick dev using Node:

```powershell
# from project root
npx http-server -c-1 -p 5173 .
# or use python
python -m http.server 5173
```

Then open http://localhost:5173 in your browser.

Supported browsers
- Chromium-based browsers, Firefox, Safari (latest versions). AudioWorklets may be unavailable in older browsers; feature-falls back gracefully.

Security & Privacy
- This app never uploads audio or metadata. All processing is local to your machine.

Limitations & TODO
- BPM and beatgrid estimation is a simple placeholder; accuracy varies.
- No tag parser implemented for ID3 yet.
- Sync engine, advanced time-stretching, MIDI mapping are left as future work scaffolds.

Cue behavior and keyboard shortcuts
- Cue (Q):
	- When track is playing: press Q to set the main cue at the current position. Hold Q to play from that cue; releasing Q returns playback to the cue and stops.
	- When track is stopped: press Q to move the playhead to the stored cue and wait. Hold Q to play from the cue; release to stop and return to the cue.

Other shortcuts: Space = Play/Pause (for active deck), 1/2 = quick hotcue triggers (deck A), 9 = hotcue for deck B (example mapping).

License
MIT — see LICENSE
