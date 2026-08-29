# Streameo IPTV

![Angular](https://img.shields.io/badge/Angular-17.3-DD0031?logo=angular&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-2.11-24C8D8?logo=tauri&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-GPL--2.0-blue)

A fast desktop IPTV player built with Angular and Tauri. It reads M3U playlists and
Xtream Codes accounts, plays through mpv, and adds EPG, recording, downloads and
restreaming on top.

## Features

- 📺 **Sources**: M3U/M3U8 files, M3U links, Xtream Codes accounts, and custom sources
  you assemble yourself
- 🎬 **Live TV, movies and series**, including season/episode browsing
- ▶️ **Playback through mpv**: embedded in the app window on Windows, or in a separate
  mpv window; any external player can be configured instead
- 📅 **EPG**: from Xtream, plus your own XMLTV sources, with catch-up/timeshift where the
  provider supports it
- ⏺️ **Recording**: record while watching, or schedule a recording from the EPG
- ⬇️ **Downloads**: a managed queue for movies and catch-up — pause it, reorder it,
  cancel single entries, retry what failed
- 📡 **Restreaming**: share a channel to another device on your network
- ⭐ **Organize**: favorites, watch history, hidden channels and groups, search across all
  sources, and bulk actions
- 🎨 **Appearance**: light/dark themes with accent colors, adjustable zoom, tray icon
- 🌍 **18 languages**, following your system language by default
- 🔄 **Updates**: checked at startup and offered in a dialog — nothing installs without
  your confirmation, and the check can be switched off in the settings
- 🖥️ **Windows, macOS and Linux** (the embedded player is Windows-only; the other
  platforms use a separate mpv window)

## Installation

Download the installer for your platform from the
[Releases](https://github.com/kaveyro/streameoIPTV/releases) page. Windows builds are
published as `-setup.exe` (NSIS) and `.msi`.

On Linux and macOS, build from source — see below.

### Runtime requirements

Playback, recording and downloads rely on external tools:

| Tool     | Windows                                | Linux / macOS                |
| -------- | -------------------------------------- | ---------------------------- |
| `mpv`    | bundled with the installer (`deps/`)   | install from your package manager |
| `ffmpeg` | bundled with the installer (`deps/`)   | install from your package manager |
| `yt-dlp` | bundled with the installer (`deps/`)   | install from your package manager |

The Linux `.deb`/`.rpm` packages declare these as dependencies, so the package manager
pulls them in.

## Building from Source

### Prerequisites

- Node.js 18 or newer
- Rust (stable, 1.91 or newer)
- Platform build tools: MSVC Build Tools on Windows, Xcode Command Line Tools on macOS,
  `webkit2gtk` and friends on Linux (see the
  [Tauri prerequisites](https://tauri.app/start/prerequisites/))
- **Windows only**: `mpv.exe`, `ffmpeg.exe` and `yt-dlp.exe` in `C:\open-tv-deps\`. They
  are copied into the bundle as declared in `src-tauri/tauri.windows.conf.json`.
- **Linux/macOS**: `mpv`, `ffmpeg` and `yt-dlp` on your `PATH`

### Setup

1. Clone the repository:

```bash
git clone https://github.com/kaveyro/streameoIPTV.git
```

2. Install dependencies:

```bash
npm install
```

3. Run the development build:

```bash
npm start
```

4. Build the installers:

```bash
npm run build
```

The artifacts end up in `src-tauri/target/release/bundle/`.

### Signed updater artifacts

The updater only accepts releases signed with the key matching `plugins.updater.pubkey`
in `src-tauri/tauri.conf.json`. Set the key before building, otherwise the build finishes
the installers and then fails at the signing step:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/streameo-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="..."
```

A release needs the installer, its `.sig` file and a `latest.json` pointing at the
download URL, all attached to the GitHub release the updater endpoint resolves to.

### Platform-Specific Builds

**macOS universal binary:**

```bash
npm run buildMac
```

## Development

### Project Structure

```
├── src/                       # Angular frontend
│   ├── app/                   # Components and services
│   ├── assets/i18n/           # Translations (18 languages)
│   └── styles.css             # Global styles
├── src-tauri/                 # Tauri backend (Rust)
│   ├── src/                   # Rust source code
│   ├── capabilities/          # Tauri capabilities
│   ├── player_ui/             # mpv on-screen controller (Lua)
│   ├── icons/                 # Application icons
│   ├── tauri.conf.json        # Tauri configuration
│   └── tauri.windows.conf.json  # Windows-only bundle resources
├── flatpak/                   # Flatpak packaging files
└── package.json               # Node.js dependencies
```

### Available Scripts

- `npm start` – Start the development server
- `npm run build` – Build the application and installers
- `npm run buildMac` – Build the macOS universal binary
- `npm run watch` – Rebuild the frontend on change
- `npm test` – Run the frontend tests
- `npm run lint` – Run ESLint
- `npm run format` – Format with Prettier
- `npm run format:check` – Check formatting

Rust tests run separately:

```bash
cd src-tauri && cargo test
```

### Logs

Both the app and mpv write to
`%LOCALAPPDATA%\kaveyro\streameoIPTV\cache\logs\` on Windows (the equivalent cache
directory elsewhere). `mpv.log` is the place to look when a channel will not play.

### Technologies Used

**Frontend:**

- [Angular 17](https://angular.io/) – Web framework
- [Angular Material](https://material.angular.io/) – UI components
- [Bootstrap](https://getbootstrap.com/) – CSS framework
- [ngx-translate](https://github.com/ngx-translate/core) – Internationalization
- [RxJS](https://rxjs.dev/) – Reactive programming

**Backend:**

- [Tauri 2](https://tauri.app/) – Desktop application framework
- [Rust](https://www.rust-lang.org/) – Systems programming language
- [SQLite](https://www.sqlite.org/) – Local channel and settings storage
- [mpv](https://mpv.io/) – Playback, driven over its JSON IPC

**Key Libraries:**

- ng-bootstrap – Bootstrap components for Angular
- ngx-toastr – Toast notifications
- ng-keyboard-shortcuts – Keyboard shortcut handling
- Tauri plugins: clipboard-manager, dialog, process, shell, single-instance, updater,
  window-state

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the GNU General Public License v2.0 – see the
[LICENSE](LICENSE) file for details.

## Support

If you encounter any issues or have questions, please
[open an issue](https://github.com/kaveyro/streameoIPTV/issues) on GitHub.

## Acknowledgments

- Based on [Open TV](https://github.com/Fredolx/open-tv) by Frédéric Lachapelle, which
  this project builds on under the GPL
- Playback by [mpv](https://mpv.io/), with the on-screen controller from
  [mpv-osc-tethys](https://github.com/Zren/mpv-osc-tethys)
- Built with [Tauri](https://tauri.app/)

---

**Note**: This application ships no content. It requires your own IPTV subscription or
playlist, and you are responsible for having the right to access what you stream.
