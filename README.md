# Streameo IPTV

![Angular](https://img.shields.io/badge/Angular-17.3-DD0031?logo=angular&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-2.9-24C8D8?logo=tauri&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)

A modern, cross-platform IPTV player desktop application built with Angular and Tauri. Stream your favorite IPTV channels with a beautiful, responsive interface.

## Features

- 🎬 **IPTV Streaming**: Play M3U/M3U8 playlists with support for various video formats
- 📺 **Channel Management**: Organize and manage your IPTV channels with favorites
- 🔍 **Search & Filter**: Quickly find channels with powerful search functionality
- 🌍 **Multi-language Support**: Internationalization support with ngx-translate
- ⌨️ **Keyboard Shortcuts**: Navigate efficiently with customizable keyboard shortcuts
- 🔔 **Notifications**: Desktop notifications for channel updates and reminders
- 🎨 **Modern UI**: Beautiful interface built with Angular Material and Bootstrap
- 💾 **Playlist Management**: Import and manage multiple IPTV playlists
- 📋 **Clipboard Integration**: Copy channel URLs and stream links
- 🔄 **Auto-updates**: Automatic application updates via Tauri updater
- 🖥️ **Cross-platform**: Available for Windows, macOS, and Linux

## Installation

**Manual Installation**
Download the `.AppImage` or `.deb` package from the [Releases](https://github.com/kaveyro/streameo-iptv/releases) page.

## Building from Source

### Prerequisites

- Node.js (v18 or higher)
- pnpm (v10.10.0 or higher)
- Rust (for Tauri)
- Platform-specific build tools

### Setup

1. Clone the repository:
```bash
git clone https://github.com/kaveyro/streameo-iptv.git
cd streameo-iptv
```

2. Install dependencies:
```bash
pnpm install
```

3. Run the development server:
```bash
pnpm start
```

4. Build the application:
```bash
pnpm build
```

### Platform-Specific Builds

**macOS Universal Binary:**
```bash
pnpm run buildMac
```

## Development

### Project Structure

```
├── src/                   # Angular frontend
│   ├── app/               # Angular components and services
│   ├── assets/            # Static assets
│   └── styles.css         # Global styles
├── src-tauri/             # Tauri backend (Rust)
│   ├── src/               # Rust source code
│   ├── capabilities/      # Tauri capabilities
│   └── tauri.conf.json    # Tauri configuration
├── flatpak/               # Flatpak packaging files
└── package.json           # Node.js dependencies
```

### Available Scripts

- `pnpm start` - Start development server
- `pnpm build` - Build the application
- `pnpm buildMac` - Build macOS universal binary
- `pnpm watch` - Build and watch for changes
- `pnpm test` - Run tests
- `pnpm lint` - Run ESLint
- `pnpm format` - Format code with Prettier
- `pnpm format:check` - Check code formatting

### Technologies Used

**Frontend:**
- [Angular 17](https://angular.io/) - Web framework
- [Angular Material](https://material.angular.io/) - UI components
- [Bootstrap](https://getbootstrap.com/) - CSS framework
- [ngx-translate](https://github.com/ngx-translate/core) - Internationalization
- [RxJS](https://rxjs.dev/) - Reactive programming

**Backend:**
- [Tauri 2](https://tauri.app/) - Desktop application framework
- [Rust](https://www.rust-lang.org/) - Systems programming language

**Key Libraries:**
- ng-bootstrap - Bootstrap components for Angular
- ngx-toastr - Toast notifications
- ng-keyboard-shortcuts - Keyboard shortcut handling
- Tauri plugins: clipboard-manager, dialog, notification, process, shell, updater

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

If you encounter any issues or have questions, please [open an issue](https://github.com/kaveyro/streameo-iptv/issues) on GitHub.

## Acknowledgments

- Built with [Tauri](https://tauri.app/)
- UI components from [Angular Material](https://material.angular.io/) and [Bootstrap](https://getbootstrap.com/)
- Icons and assets from various open-source projects

---

**Note**: This application requires valid IPTV stream sources. Please ensure you have the right to access the content you stream.