# AirSpan Windows Desktop Build

## Prerequisites
- Windows 10/11 x64
- Node.js 22.x or newer
- npm

## Build
Open PowerShell in this folder and run:

```powershell
npm install
npm run desktop:dist
```

The unpacked app, NSIS installer, and portable executable are written to `dist\\`.

Portable-only build:

```powershell
npm run desktop:portable
```

If PowerShell blocks `npm.ps1`, use `npm.cmd` instead:

```powershell
npm.cmd install
npm.cmd run desktop:dist
```

The desktop build runs the bundled AirSpan server locally and serves the PC UI from Electron. The pairing origin uses the PC's LAN IPv4 address so a Mac on the same network can connect.
