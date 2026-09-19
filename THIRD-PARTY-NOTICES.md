# Third-Party Notices

AirSpan includes or is built with third-party software. AirSpan's MIT License applies only to AirSpan's original code. Each third-party component remains subject to its own copyright and license terms.

This file is provided for attribution and licensing clarity. It is not legal advice.

## FairPlay SAP helper

AirSpan distributes `tools/fpsap-helper/fairplay-helper.exe`, which is built from:

- AirSpan's wrapper source in `tools/fpsap-helper/Main.go`
- `github.com/objevovat/fairplay-sap-core-airplay2-sender-authentication-handshake` version `v1.1.0`
- Upstream source: <https://github.com/objevovat/fairplay-sap-core-airplay2-sender-authentication-handshake/tree/v1.1.0>

The upstream project states that the combined work is licensed under **GNU Lesser General Public License v3.0 or later (LGPL-3.0-or-later)**. Some independently developed files are offered under the **Blue Oak Model License 1.0.0**, but `fpbridge` imports LGPL-covered code, so the compiled helper must be treated as LGPL-3.0-or-later as a whole.

AirSpan does not relicense that helper or its upstream dependency under MIT. Recipients retain the rights granted by the LGPL, including the rights applicable to modifying the covered library and debugging those modifications.

The upstream project also states that a statically linked Go binary should be accompanied by the corresponding source or the material needed to relink it. Before redistributing `fairplay-helper.exe`, keep the exact `v1.1.0` source and applicable license texts available with the distribution. The authoritative file-by-file license declarations and provenance are in the upstream `NOTICE.md` and SPDX headers.

Applicable upstream documents:

- LGPL-3.0 text: <https://github.com/objevovat/fairplay-sap-core-airplay2-sender-authentication-handshake/blob/v1.1.0/LICENSE>
- GPL-3.0 text incorporated by LGPL-3.0: <https://github.com/objevovat/fairplay-sap-core-airplay2-sender-authentication-handshake/blob/v1.1.0/COPYING.GPL-3.0>
- Blue Oak 1.0.0 text: <https://github.com/objevovat/fairplay-sap-core-airplay2-sender-authentication-handshake/blob/v1.1.0/LICENSE.BlueOak-1.0.0>
- Upstream licensing and provenance notice: <https://github.com/objevovat/fairplay-sap-core-airplay2-sender-authentication-handshake/blob/v1.1.0/NOTICE.md>

The helper performs an AirPlay authentication handshake. It is not FairPlay Streaming DRM, does not decrypt protected media, and does not extract content keys.

## Bundled application dependencies

| Component | Version | License | Project |
| --- | ---: | --- | --- |
| `@leichtgewicht/ip-codec` | 2.0.5 | MIT | <https://github.com/martinheidegger/ip-codec> |
| `@noble/ciphers` | 2.4.0 | MIT | <https://github.com/paulmillr/noble-ciphers> |
| `@tanstack/react-router` | 1.170.32 | MIT | <https://github.com/TanStack/router> |
| `@xmldom/xmldom` | 0.9.12 | MIT | <https://github.com/xmldom/xmldom> |
| `bonjour-service` | 1.4.4 | MIT | <https://github.com/onlxltd/bonjour-service> |
| `dns-packet` | 5.6.1 | MIT | <https://github.com/mafintosh/dns-packet> |
| `fast-deep-equal` | 3.1.3 | MIT | <https://github.com/epoberezkin/fast-deep-equal> |
| `fast-srp-hap` | 2.0.4 | MIT | <https://github.com/homebridge/fast-srp> |
| `lucide-react` | 0.510.0 | ISC | <https://github.com/lucide-icons/lucide> |
| `multicast-dns` | 7.2.5 | MIT | <https://github.com/mafintosh/multicast-dns> |
| `plist` | 5.0.0 | MIT | <https://github.com/TooTallNate/plist.js> |
| `qrcode` | 1.5.4 | MIT | <https://github.com/soldair/node-qrcode> |
| `react` | 19.2.8 | MIT | <https://github.com/facebook/react> |
| `react-dom` | 19.2.8 | MIT | <https://github.com/facebook/react> |
| `thunky` | 1.1.0 | MIT | <https://github.com/mafintosh/thunky> |
| `xmlbuilder` | 15.1.1 | MIT | <https://github.com/oozcitak/xmlbuilder-js> |

The exact resolved dependency versions are recorded in `package-lock.json`. Additional copyright statements and license texts are available in each package's source repository and npm distribution.

## Application runtime and build tooling

| Component | Version | License | Project |
| --- | ---: | --- | --- |
| Electron | 38.8.6 | MIT | <https://github.com/electron/electron> |
| electron-builder | 26.15.3 | MIT | <https://github.com/electron-userland/electron-builder> |
| TypeScript | 5.9.3 | Apache-2.0 | <https://github.com/microsoft/TypeScript> |
| Vite | 8.2.2 | MIT | <https://github.com/vitejs/vite> |

Electron distributions include Chromium, Node.js, and additional third-party components. Their notices are included with Electron's distributed license resources and remain governed by their respective licenses.

## Trademarks

Apple, AirPlay, Apple TV, and related marks are trademarks of Apple Inc. AirSpan is an independent project and is not affiliated with or endorsed by Apple Inc. Product names and trademarks are used only to describe interoperability.

