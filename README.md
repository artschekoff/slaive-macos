# Slaive

Voice input over any app on macOS. Local, no cloud.

Hold the hotkey, speak, release — the text appears in the panel.
The "Paste" button sends it back to the app you called Slaive from.

## Requirements

- macOS 12+
- Rust, cmake (`brew install cmake`), Node.js 20+

## Running

```bash
npm install
npm run tauri dev
```

Settings open automatically on first launch: pick a model and click "Download".
For Russian, use `small` or `large-v3-turbo` — models with the `.en` suffix
don't understand Russian.

## macOS Permissions

The app needs two permissions:

- **Microphone** — requested automatically on the first recording.
- **Accessibility** — to paste text into other apps.
  System Settings → Privacy & Security → Accessibility.

The first time Slaive brings a window back into focus, macOS may also ask for
**Automation** access (System Settings → Privacy & Security → Automation →
Slaive → System Events) — grant that too.

## Hotkey conflict

The default hotkey is set by pressing a key combination in Slaive's settings.
The default, `Cmd+T`, is "New Tab" in most apps — a global hotkey intercepts
it system-wide. Set a different combination in Slaive's settings if that
conflicts with how you work.

## Building

```bash
npm run tauri build
```

The built app lands in `src-tauri/target/release/bundle/macos/Slaive.app`.
The build is unsigned: on first launch, macOS will ask you to confirm via the
right-click menu → "Open".
