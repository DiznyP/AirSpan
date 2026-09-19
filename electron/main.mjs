import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  desktopCapturer,
  session,
  safeStorage,
} from 'electron';
import http from 'node:http';
import net from "node:net";
import dgram from "node:dgram";
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  appendFileSync,
  createReadStream,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Bonjour } from "bonjour-service";
import fastSrp from "fast-srp-hap"; 
import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes,
  generateKeyPairSync,
  hkdfSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import {
  execFile,
} from "node:child_process";

import {
  promisify,
} from "node:util";


import {
  chacha20poly1305,
} from "@noble/ciphers/chacha.js";
import { buildBinary } from "plist";
import {
  parseBinaryPlist,
} from "./parse-binary-plist.mjs";
import {
  createDiagnosticsArchive,
  makeDiagnosticsFilename,
} from "./diagnostics.mjs";

if (process.platform === "win32") {
  app.commandLine.appendSwitch(
    "disable-features",
    "AllowWgcScreenCapturer",
  );
}

const { SRP, SrpClient } = fastSrp;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const STATIC_ROOT = path.join(APP_ROOT, 'web-dist');
const execFileAsync =
  promisify(execFile);

const FAIRPLAY_HELPER_PATH =
  app.isPackaged
    ? path.join(
        process.resourcesPath,
        "fairplay-helper.exe",
      )
    : path.join(
        APP_ROOT,
        "tools",
        "fpsap-helper",
        "fairplay-helper.exe",
      );
const PORT = Number(process.env.AIRSPAN_PORT || 47832);
const airPlayDevices = new Map();

const AIRPLAY_DIAGNOSTIC_LOG_PATH =
  process.env.AIRSPAN_LOG_PATH ||
  path.join(
    app.getPath("logs"),
    "airspan-airplay.log",
  );
const AIRPLAY_DIAGNOSTIC_MAX_BYTES =
  5 * 1024 * 1024;
let airPlayDiagnosticWrites = 0;

function airPlayDiagnostic(
  event,
  details = {},
) {
  try {
    mkdirSync(
      path.dirname(
        AIRPLAY_DIAGNOSTIC_LOG_PATH,
      ),
      { recursive: true },
    );

    airPlayDiagnosticWrites += 1;
    if (
      airPlayDiagnosticWrites === 1 ||
      airPlayDiagnosticWrites % 100 === 0
    ) {
      try {
        if (
          statSync(
            AIRPLAY_DIAGNOSTIC_LOG_PATH,
          ).size >
          AIRPLAY_DIAGNOSTIC_MAX_BYTES
        ) {
          const rotatedPath =
            `${AIRPLAY_DIAGNOSTIC_LOG_PATH}.1`;

          rmSync(
            rotatedPath,
            {
              force: true,
            },
          );
          renameSync(
            AIRPLAY_DIAGNOSTIC_LOG_PATH,
            rotatedPath,
          );
        }
      } catch {
        // The log does not exist yet or could not be rotated this time.
      }
    }

    const line =
      JSON.stringify(
        {
          at:
            new Date().toISOString(),
          pid:
            process.pid,
          event,
          ...details,
        },
        (_key, value) => {
          if (typeof value === "bigint") {
            return value.toString();
          }

          if (Buffer.isBuffer(value)) {
            return `<Buffer ${value.length} bytes>`;
          }

          return value;
        },
      );

    appendFileSync(
      AIRPLAY_DIAGNOSTIC_LOG_PATH,
      `${line.slice(0, 32 * 1024)}\n`,
      "utf8",
    );
  } catch {
    // Diagnostics must never interrupt mirroring.
  }
}

airPlayDiagnostic(
  "process-start",
  {
    packaged:
      app.isPackaged,
    logPath:
      AIRPLAY_DIAGNOSTIC_LOG_PATH,
  },
);

function normalizeAirPlayDevice(service) {
  return {
    id:
      service.txt?.deviceid ||
      `${service.host}:${service.port}`,

    name:
      service.name ||
      service.host ||
      "AirPlay Device",

    host: service.host,
    port: service.port,

    addresses: service.addresses || [],

    model:
      service.txt?.model || "",

    manufacturer:
      service.txt?.manufacturer ||
      service.txt?.integrator ||
      "",
      features:
  service.txt?.features || "",

featuresEx:
  service.txt?.fex || "",

sourceVersion:
  service.txt?.srcvers || "",

protocolVersion:
  service.txt?.protovers || "",

flags:
  service.txt?.flags || "",

vv:
  service.txt?.vv || "",
  };
}
async function getAirPlayInfo(device) {
  const ipv4 = (device.addresses || []).find(
    (address) =>
      typeof address === "string" &&
      /^\d+\.\d+\.\d+\.\d+$/.test(address),
  );

  const address = ipv4 || device.host;
  const port = device.port || 7000;

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: address,
        port,
        path: "/info",
        method: "GET",
        headers: {
          "User-Agent": "AirPlay/550.10",
          "X-Apple-ProtocolVersion": "1",
        },
        timeout: 5000,
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          const body = Buffer.concat(chunks);

          console.log("[AirSpan] AirPlay /info response:", {
            device: device.name,
            statusCode: response.statusCode,
            contentType: response.headers["content-type"],
            bytes: body.length,
          });

          resolve({
            ok:
              response.statusCode >= 200 &&
              response.statusCode < 300,
            statusCode: response.statusCode,
            contentType:
              response.headers["content-type"] || "",
            bytes: body.length,
          });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(
        new Error("AirPlay receiver timed out."),
      );
    });

    request.on("error", reject);

    request.end();
  });
}


async function startAirPlayPinPairing(
  device,
  agent,
) {
  const ipv4 = (device.addresses || []).find(
    (address) =>
      typeof address === "string" &&
      /^\d+\.\d+\.\d+\.\d+$/.test(address),
  );

  const address = ipv4 || device.host;
  const port = device.port || 7000;

  return new Promise((resolve, reject) => {
    let settled = false;

    const request = http.request(
      {
        hostname: address,
        port,
        path: "/pair-pin-start",
        method: "POST",
        agent,
        headers: {
          "User-Agent": "AirPlay/381.13",
          "X-Apple-HKP": "3",
          "Content-Length": "0",
          Connection: "keep-alive",
        },
        timeout: 5000,
      },
      (response) => {
        // A number of AirPlay receivers return a successful status line but
        // keep the HTTP connection alive without terminating the response
        // body.  Waiting for `end` in that case makes the pairing request
        // hit the client timeout even though pairing has already started.
        request.setTimeout(0);
        response.resume();
        // Release the keep-alive socket so the same pairing agent can send
        // the following /pair-setup request immediately.
        response.destroy();

        settled = true;

        console.log(
          "[AirSpan] AirPlay PIN pairing response:",
          {
            device: device.name,
            statusCode: response.statusCode,
          },
        );

        resolve({
          ok:
            response.statusCode >= 200 &&
            response.statusCode < 300,
          statusCode: response.statusCode,
        });
      },
    );

    request.on("timeout", () => {
      if (settled) {
        return;
      }

      settled = true;
      request.destroy(
        new Error("AirPlay pairing request timed out."),
      );
    });

    request.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    });
    request.end();
  });
}
function sendAirPlayDevices() {
  void getAirPlayDeviceSummaries()
    .then((devices) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(
          "airspan:airplay-devices",
          devices,
        );
      }
    })
    .catch((error) => {
      console.error(
        "[AirSpan] Could not refresh AirPlay device pairing state:",
        error,
      );
    });
}
const AIRPLAY_TLV = {
  METHOD: 0x00,
  IDENTIFIER: 0x01,
  SALT: 0x02,
  PUBLIC_KEY: 0x03,
  PROOF: 0x04,
  ENCRYPTED_DATA: 0x05,
  STATE: 0x06,
  ERROR: 0x07,
  SIGNATURE: 0x0a,
};


function getAirPlayNetworkAddress(device) {
  const ipv4 = (device.addresses || []).find(
    (address) =>
      typeof address === "string" &&
      /^\d+\.\d+\.\d+\.\d+$/.test(address),
  );

  return ipv4 || device.host;
}


function encodeTlv8(entries) {
  const chunks = [];

  for (const [tag, input] of entries) {
    const value = Buffer.isBuffer(input)
      ? input
      : Buffer.from(input);

    if (value.length === 0) {
      chunks.push(Buffer.from([tag, 0]));
      continue;
    }

    for (
      let offset = 0;
      offset < value.length;
      offset += 255
    ) {
      const part = value.subarray(
        offset,
        offset + 255,
      );

      chunks.push(
        Buffer.from([tag, part.length]),
        part,
      );
    }
  }

  return Buffer.concat(chunks);
}


function decodeTlv8(buffer) {
  const values = new Map();

  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 2 > buffer.length) {
      throw new Error(
        "Malformed AirPlay TLV response.",
      );
    }

    const tag = buffer[offset];
    const length = buffer[offset + 1];

    offset += 2;

    if (offset + length > buffer.length) {
      throw new Error(
        "Malformed AirPlay TLV value.",
      );
    }

    const value = Buffer.from(
      buffer.subarray(
        offset,
        offset + length,
      ),
    );

    offset += length;

    const previous = values.get(tag);

    values.set(
      tag,
      previous
        ? Buffer.concat([previous, value])
        : value,
    );
  }

  return values;
}


async function postAirPlayPairSetup(
  device,
  agent,
  body,
) {
  const address =
    getAirPlayNetworkAddress(device);

  const port = device.port || 7000;

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: address,
        port,
        path: "/pair-setup",
        method: "POST",
        agent,
        headers: {
          "User-Agent": "AirPlay/381.13",
          "X-Apple-HKP": "3",
          "Content-Type":
            "application/octet-stream",
          "Content-Length": body.length,
          Connection: "keep-alive",
        },
        timeout: 5000,
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
        });

        response.on("end", () => {
          resolve({
            statusCode:
              response.statusCode || 0,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(
        new Error(
          "AirPlay pair-setup request timed out.",
        ),
      );
    });

    request.on("error", reject);

    request.write(body);
    request.end();
  });
}


async function startAirPlayPairSetupM1(
  device,
  agent,
) {
  const body = encodeTlv8([
    [
      AIRPLAY_TLV.STATE,
      Buffer.from([0x01]),
    ],
    [
      AIRPLAY_TLV.METHOD,
      Buffer.from([0x00]),
    ],
  ]);

  const response =
    await postAirPlayPairSetup(
      device,
      agent,
      body,
    );

  if (
    response.statusCode < 200 ||
    response.statusCode >= 300
  ) {
    throw new Error(
      `AirPlay M1 failed with HTTP ${response.statusCode}.`,
    );
  }

  const tlv = decodeTlv8(response.body);

  const state =
    tlv.get(AIRPLAY_TLV.STATE)?.[0];

  const error =
    tlv.get(AIRPLAY_TLV.ERROR)?.[0];

  if (error !== undefined) {
    throw new Error(
      `Apple TV returned pairing error ${error}.`,
    );
  }

  if (state !== 0x02) {
    throw new Error(
      `Expected AirPlay M2, received state ${state}.`,
    );
  }

  const salt =
    tlv.get(AIRPLAY_TLV.SALT);

  const serverPublicKey =
    tlv.get(AIRPLAY_TLV.PUBLIC_KEY);

  if (!salt || !serverPublicKey) {
    throw new Error(
      "AirPlay M2 did not contain the SRP salt/public key.",
    );
  }

  console.log(
    "[AirSpan] AirPlay pair-setup M2:",
    {
      statusCode: response.statusCode,
      state,
      saltBytes: salt.length,
      publicKeyBytes:
        serverPublicKey.length,
    },
  );

  return {
    salt,
    serverPublicKey,
  };
}


async function finishAirPlayPairSetupM3(pin) {
  if (!pendingAirPlayPairing) {
    throw new Error(
      "No active AirPlay SRP pairing session.",
    );
  }

  const {
    device,
    agent,
    salt,
    serverPublicKey,
  } = pendingAirPlayPairing;

  const secret = await SRP.genKey(32);

  const params = SRP.params.hap;

  if (!params) {
    throw new Error(
      "fast-srp-hap does not expose HAP SRP parameters.",
    );
  }

  const srp = new SrpClient(
    params,
    salt,
    Buffer.from("Pair-Setup"),
    Buffer.from(pin),
    secret,
  );

  srp.setB(serverPublicKey);

  const clientPublicKey =
    srp.computeA();

  const clientProof =
    srp.computeM1();

  const body = encodeTlv8([
    [
      AIRPLAY_TLV.STATE,
      Buffer.from([0x03]),
    ],
    [
      AIRPLAY_TLV.PUBLIC_KEY,
      clientPublicKey,
    ],
    [
      AIRPLAY_TLV.PROOF,
      clientProof,
    ],
  ]);

  const response =
    await postAirPlayPairSetup(
      device,
      agent,
      body,
    );

  if (
    response.statusCode < 200 ||
    response.statusCode >= 300
  ) {
    throw new Error(
      `AirPlay M3 failed with HTTP ${response.statusCode}.`,
    );
  }

  const tlv = decodeTlv8(response.body);

  const state =
    tlv.get(AIRPLAY_TLV.STATE)?.[0];

  const error =
    tlv.get(AIRPLAY_TLV.ERROR)?.[0];

  if (error !== undefined) {
    throw new Error(
      `Apple TV rejected the PIN. Pairing error ${error}.`,
    );
  }

  if (state !== 0x04) {
    throw new Error(
      `Expected AirPlay M4, received state ${state}.`,
    );
  }

  const serverProof =
    tlv.get(AIRPLAY_TLV.PROOF);

  if (!serverProof) {
    throw new Error(
      "AirPlay M4 did not contain a server proof.",
    );
  }

  srp.checkM2(serverProof);

  const sessionKey =
    srp.computeK();

  pendingAirPlayPairing.srp = srp;
  pendingAirPlayPairing.sessionKey =
    sessionKey;

  console.log(
    "[AirSpan] AirPlay SRP M4 verified:",
    {
      device: device.name,
      statusCode: response.statusCode,
      state,
      proofBytes: serverProof.length,
      sessionKeyBytes:
        sessionKey.length,
    },
  );

  return {
    ok: true,
    state,
  };
}
function hapHkdf(
  salt,
  info,
  sharedSecret,
) {
  return Buffer.from(
    hkdfSync(
      "sha512",
      sharedSecret,
      Buffer.from(salt),
      Buffer.from(info),
      32,
    ),
  );
}


function hapNonce(label) {
  const value = Buffer.from(label);

  if (value.length !== 8) {
    throw new Error(
      `HAP nonce must be 8 bytes: ${label}`,
    );
  }

  return Buffer.concat([
    Buffer.alloc(4),
    value,
  ]);
}


function encryptHapPayload(
  key,
  nonceLabel,
  plaintext,
) {
  const nonce = hapNonce(nonceLabel);

  const cipher =
    chacha20poly1305(
      new Uint8Array(key),
      new Uint8Array(nonce),
    );

  const encrypted =
    cipher.encrypt(
      new Uint8Array(plaintext),
    );

  return Buffer.from(encrypted);
}


function decryptHapPayload(
  key,
  nonceLabel,
  encrypted,
) {
  const nonce = hapNonce(nonceLabel);

  const cipher =
    chacha20poly1305(
      new Uint8Array(key),
      new Uint8Array(nonce),
    );

  const plaintext =
    cipher.decrypt(
      new Uint8Array(encrypted),
    );

  return Buffer.from(plaintext);
}


async function finishAirPlayPairSetupM5M6() {
  if (!pendingAirPlayPairing) {
    throw new Error(
      "No active AirPlay pairing session.",
    );
  }

  const {
    device,
    agent,
    sessionKey,
  } = pendingAirPlayPairing;

  if (!sessionKey) {
    throw new Error(
      "AirPlay SRP session key is missing.",
    );
  }

  // AirSpan's long-term controller identity.
  const {
    publicKey,
    privateKey,
  } = generateKeyPairSync("ed25519");

  const publicJwk =
    publicKey.export({
      format: "jwk",
    });

  const privateJwk =
    privateKey.export({
      format: "jwk",
    });

  if (!publicJwk.x) {
    throw new Error(
      "Could not export AirSpan Ed25519 public key.",
    );
  }

  const controllerPublicKey =
    Buffer.from(
      publicJwk.x,
      "base64url",
    );

  const controllerId =
    Buffer.from(randomUUID());

  // HKDF value used in the controller signature.
  const controllerSignKey =
    hapHkdf(
      "Pair-Setup-Controller-Sign-Salt",
      "Pair-Setup-Controller-Sign-Info",
      sessionKey,
    );

  const controllerInfo =
    Buffer.concat([
      controllerSignKey,
      controllerId,
      controllerPublicKey,
    ]);

  const controllerSignature =
    cryptoSign(
      null,
      controllerInfo,
      privateKey,
    );

  const innerM5 =
    encodeTlv8([
      [
        AIRPLAY_TLV.IDENTIFIER,
        controllerId,
      ],
      [
        AIRPLAY_TLV.PUBLIC_KEY,
        controllerPublicKey,
      ],
      [
        AIRPLAY_TLV.SIGNATURE,
        controllerSignature,
      ],
    ]);

  // Key used to encrypt M5 and decrypt M6.
  const pairSetupEncryptionKey =
    hapHkdf(
      "Pair-Setup-Encrypt-Salt",
      "Pair-Setup-Encrypt-Info",
      sessionKey,
    );

  const encryptedM5 =
    encryptHapPayload(
      pairSetupEncryptionKey,
      "PS-Msg05",
      innerM5,
    );

  const outerM5 =
    encodeTlv8([
      [
        AIRPLAY_TLV.STATE,
        Buffer.from([0x05]),
      ],
      [
        AIRPLAY_TLV.ENCRYPTED_DATA,
        encryptedM5,
      ],
    ]);

  console.log(
    "[AirSpan] Sending AirPlay pair-setup M5:",
    {
      device: device.name,
      controllerId:
        controllerId.toString(),
      publicKeyBytes:
        controllerPublicKey.length,
      signatureBytes:
        controllerSignature.length,
      encryptedBytes:
        encryptedM5.length,
    },
  );

  const response =
    await postAirPlayPairSetup(
      device,
      agent,
      outerM5,
    );

  if (
    response.statusCode < 200 ||
    response.statusCode >= 300
  ) {
    throw new Error(
      `AirPlay M5 failed with HTTP ${response.statusCode}.`,
    );
  }

  const outerM6 =
    decodeTlv8(response.body);

  const state =
    outerM6.get(
      AIRPLAY_TLV.STATE,
    )?.[0];

  const error =
    outerM6.get(
      AIRPLAY_TLV.ERROR,
    )?.[0];

  if (error !== undefined) {
    throw new Error(
      `Apple TV returned M6 pairing error ${error}.`,
    );
  }

  if (state !== 0x06) {
    throw new Error(
      `Expected AirPlay M6, received state ${state}.`,
    );
  }

  const encryptedM6 =
    outerM6.get(
      AIRPLAY_TLV.ENCRYPTED_DATA,
    );

  if (!encryptedM6) {
    throw new Error(
      "AirPlay M6 did not contain encrypted data.",
    );
  }

  const decryptedM6 =
    decryptHapPayload(
      pairSetupEncryptionKey,
      "PS-Msg06",
      encryptedM6,
    );

  const innerM6 =
    decodeTlv8(decryptedM6);

  const accessoryIdentifier =
    innerM6.get(
      AIRPLAY_TLV.IDENTIFIER,
    );

  const accessoryPublicKey =
    innerM6.get(
      AIRPLAY_TLV.PUBLIC_KEY,
    );

  const accessorySignature =
    innerM6.get(
      AIRPLAY_TLV.SIGNATURE,
    );

  if (
    !accessoryIdentifier ||
    !accessoryPublicKey ||
    !accessorySignature
  ) {
    throw new Error(
      "AirPlay M6 is missing accessory credentials.",
    );
  }

  pendingAirPlayPairing.credentials = {
    controllerId:
      controllerId.toString(),

    controllerPublicKey:
      controllerPublicKey.toString(
        "base64",
      ),

    controllerPrivateJwk:
      privateJwk,

    accessoryIdentifier:
      accessoryIdentifier.toString(),

    accessoryPublicKey:
      accessoryPublicKey.toString(
        "base64",
      ),
  };
await saveAirPlayPairing(
  device,
  pendingAirPlayPairing.credentials,
);
  console.log(
    "[AirSpan] AirPlay pair-setup M6 verified:",
    {
      device: device.name,

      accessoryIdentifier:
        accessoryIdentifier.toString(),

      accessoryPublicKeyBytes:
        accessoryPublicKey.length,

      accessorySignatureBytes:
        accessorySignature.length,
    },
  );

  return {
    ok: true,
    state,
    controllerId:
      controllerId.toString(),
    accessoryIdentifier:
      accessoryIdentifier.toString(),
  };
}
const PRELOAD_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'preload.cjs')
  : path.join(__dirname, 'preload.cjs');

let server;
let mainWindow;
let airPlayBonjour = null;
let airPlayBrowser = null;
let pendingAirPlayDevice = null;
let pendingAirPlayPairing = null;
let pendingAirPlayPinSubmission = null;
let lastAirPlayDevice = null;
let airPlayConnectionState = {
  status: "disconnected",
  deviceId: null,
  name: null,
  message: "Select an AirPlay receiver.",
  connected: false,
  canReconnect: false,
  paired: false,
};

function setAirPlayConnectionState(
  update,
) {
  airPlayConnectionState = {
    ...airPlayConnectionState,
    ...update,
  };

  airPlayDiagnostic(
    "connection-state",
    airPlayConnectionState,
  );

  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(
      "airspan:airplay-state",
      airPlayConnectionState,
    );
  }
}

async function readAirPlayDiagnosticLogs() {
  const paths = [
    `${AIRPLAY_DIAGNOSTIC_LOG_PATH}.1`,
    AIRPLAY_DIAGNOSTIC_LOG_PATH,
  ];
  const logs = [];

  for (const logPath of paths) {
    try {
      logs.push(await fs.readFile(logPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[AirSpan] Could not read a diagnostic log:", error);
      }
    }
  }

  return logs;
}

function getReceiverDiagnosticSummaries() {
  const receivers = [...airPlayDevices.values()];
  if (
    lastAirPlayDevice &&
    !receivers.some((device) => device.id === lastAirPlayDevice.id)
  ) {
    receivers.push(lastAirPlayDevice);
  }

  return receivers.map((device) => ({
    name: device.name || "AirPlay receiver",
    model: device.model || "",
    manufacturer: device.manufacturer || "",
    features: device.features || "",
    featuresEx: device.featuresEx || "",
    sourceVersion: device.sourceVersion || "",
    protocolVersion: device.protocolVersion || "",
  }));
}

async function exportAirSpanDiagnostics() {
  const generatedAt = new Date();
  const fileName = makeDiagnosticsFilename(generatedAt);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export AirSpan diagnostics",
    defaultPath: path.join(app.getPath("documents"), fileName),
    buttonLabel: "Export diagnostics",
    filters: [
      {
        name: "ZIP archive",
        extensions: ["zip"],
      },
    ],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });

  if (result.canceled || !result.filePath) {
    return {
      ok: false,
      canceled: true,
    };
  }

  airPlayDiagnostic("diagnostics-export-started", {
    fileName: path.basename(result.filePath),
  });

  const logTexts = await readAirPlayDiagnosticLogs();
  const archive = createDiagnosticsArchive({
    generatedAt,
    logTexts,
    metadata: {
      app: {
        name: app.getName(),
        version: app.getVersion(),
        packaged: app.isPackaged,
      },
      runtime: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      system: {
        platform: process.platform,
        release: os.release(),
        architecture: process.arch,
      },
      connection: {
        status: airPlayConnectionState.status,
        receiverName: airPlayConnectionState.name,
        message: airPlayConnectionState.message,
        connected: airPlayConnectionState.connected,
        canReconnect: airPlayConnectionState.canReconnect,
        paired: airPlayConnectionState.paired,
      },
      receivers: getReceiverDiagnosticSummaries(),
    },
  });

  await fs.writeFile(result.filePath, archive.buffer);
  airPlayDiagnostic("diagnostics-export-complete", {
    fileName: path.basename(result.filePath),
    bytes: archive.buffer.length,
    eventCount: archive.eventCount,
    files: archive.files,
  });

  return {
    ok: true,
    canceled: false,
    filePath: result.filePath,
    fileName: path.basename(result.filePath),
    bytes: archive.buffer.length,
    eventCount: archive.eventCount,
  };
}

function getAirPlayPairingsPath() {
  return path.join(
    app.getPath("userData"),
    "airplay-pairings.dat",
  );
}

async function migrateLegacyAirPlayPairings() {
  const currentPath = getAirPlayPairingsPath();
  const legacyPath = path.join(
    app.getPath("appData"),
    "app-builder-workspace",
    "airplay-pairings.dat",
  );

  if (currentPath.toLowerCase() === legacyPath.toLowerCase()) {
    return;
  }

  try {
    await fs.access(currentPath);
    return;
  } catch {}

  try {
    await fs.mkdir(path.dirname(currentPath), { recursive: true });
    await fs.copyFile(legacyPath, currentPath);
    console.log("[AirSpan] Migrated saved AirPlay pairings to the AirSpan profile.");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("[AirSpan] Could not migrate legacy AirPlay pairings:", error);
    }
  }
}

function airPlayPairingMatchesDevice(
  entry,
  device,
) {
  if (
    !entry ||
    typeof entry !== "object" ||
    !device
  ) {
    return false;
  }

  const address =
    getAirPlayNetworkAddress(device);
  const port =
    Number(device.port || 7000);

  return (
    entry.deviceId === device.id ||
    (
      entry.host === device.host &&
      Number(entry.port || 7000) === port
    ) ||
    (
      entry.address === address &&
      Number(entry.port || 7000) === port
    ) ||
    (
      entry.name === device.name &&
      Number(entry.port || 7000) === port
    )
  );
}

function isSameAirPlayDevice(
  first,
  second,
) {
  if (!first || !second) {
    return false;
  }

  const firstPort =
    Number(first.port || 7000);
  const secondPort =
    Number(second.port || 7000);

  return (
    first.id === second.id ||
    (
      first.host === second.host &&
      firstPort === secondPort
    ) ||
    (
      getAirPlayNetworkAddress(first) ===
        getAirPlayNetworkAddress(second) &&
      firstPort === secondPort
    ) ||
    (
      first.name === second.name &&
      firstPort === secondPort
    )
  );
}

function findSavedAirPlayPairing(
  pairings,
  device,
) {
  return (
    pairings?.[device.id] ||
    Object.values(pairings || {}).find(
      (entry) =>
        airPlayPairingMatchesDevice(
          entry,
          device,
        ),
    ) ||
    null
  );
}

async function getAirPlayDeviceSummaries() {
  const pairings =
    await loadAirPlayPairings();

  return Array.from(
    airPlayDevices.values(),
  ).map((device) => ({
    ...device,
    paired: Boolean(
      findSavedAirPlayPairing(
        pairings,
        device,
      ),
    ),
  }));
}

async function writeAirPlayPairings(
  pairings,
) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "Windows secure credential storage is unavailable.",
    );
  }

  const encrypted =
    safeStorage.encryptString(
      JSON.stringify(pairings),
    );
  const filePath =
    getAirPlayPairingsPath();

  await fs.mkdir(
    path.dirname(filePath),
    {
      recursive: true,
    },
  );
  await fs.writeFile(
    filePath,
    encrypted,
  );
}


async function loadAirPlayPairings() {
  const filePath =
    getAirPlayPairingsPath();

  try {
    const encrypted =
      await fs.readFile(filePath);

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "Windows secure storage is unavailable.",
      );
    }

    const plaintext =
      safeStorage.decryptString(
        encrypted,
      );

    const pairings =
      JSON.parse(plaintext);

    if (
      !pairings ||
      typeof pairings !== "object"
    ) {
      return {};
    }

    return pairings;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }

    console.error(
      "[AirSpan] Failed to load saved AirPlay pairings:",
      error,
    );

    return {};
  }
}


async function saveAirPlayPairing(
  device,
  credentials,
) {
  const pairings =
    await loadAirPlayPairings();

  pairings[device.id] = {
    deviceId: device.id,
    name: device.name,
    host: device.host,
    port: device.port,
    address: getAirPlayNetworkAddress(device),
    model: device.model,
    manufacturer:
      device.manufacturer || "",

    credentials,

    savedAt:
      new Date().toISOString(),
  };

  const filePath =
    getAirPlayPairingsPath();
  await writeAirPlayPairings(
    pairings,
  );

  console.log(
    "[AirSpan] AirPlay credentials saved:",
    {
      device: device.name,
      deviceId: device.id,
      path: filePath,
    },
  );

  sendAirPlayDevices();
}


async function getSavedAirPlayPairing(
  device,
) {
  const pairings =
    await loadAirPlayPairings();
  const saved =
    findSavedAirPlayPairing(
      pairings,
      device,
    );

  if (saved) {
    console.log(
      "[AirSpan] Matched saved AirPlay pairing by receiver identity fallback:",
      {
        device: device.name,
        savedDeviceId: saved.deviceId,
        currentDeviceId: device.id,
      },
    );
  }

  return saved || null;
}

async function forgetSavedAirPlayPairing(
  device,
) {
  const pairings =
    await loadAirPlayPairings();
  let removed = 0;

  for (const [key, entry] of
    Object.entries(pairings)) {
    if (
      key === device.id ||
      airPlayPairingMatchesDevice(
        entry,
        device,
      )
    ) {
      delete pairings[key];
      removed += 1;
    }
  }

  if (removed) {
    await writeAirPlayPairings(
      pairings,
    );
  }

  sendAirPlayDevices();
  return removed;
}
async function postAirPlayPairVerify(
  device,
  agent,
  body,
  detachSocket = false,
) {
  const address =
    getAirPlayNetworkAddress(device);

  const port =
    device.port || 7000;

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: address,
        port,
        path: "/pair-verify",
        method: "POST",
        agent,
        headers: {
          "User-Agent": "AirPlay/381.13",
          "X-Apple-HKP": "3",
          "Content-Type":
            "application/octet-stream",
          "Content-Length":
            body.length,
          Connection: "keep-alive",
        },
        timeout: 5000,
      },
      (response) => {
        const chunks = [];

        const responseSocket =
          response.socket;

        if (
          detachSocket &&
          responseSocket
        ) {
          responseSocket.emit(
            "agentRemove",
          );

          responseSocket.ref();
          responseSocket.setTimeout(0);
        }

        response.on(
          "data",
          (chunk) => {
            chunks.push(
              Buffer.from(chunk),
            );
          },
        );

        response.on(
          "end",
          () => {
            resolve({
              statusCode:
                response.statusCode || 0,

              body:
                Buffer.concat(chunks),

              socket:
                detachSocket
                  ? responseSocket
                  : null,
            });
          },
        );
      },
    );

    request.on(
      "timeout",
      () => {
        request.destroy(
          new Error(
            "AirPlay pair-verify request timed out.",
          ),
        );
      },
    );

    request.on(
      "error",
      reject,
    );

    request.write(body);
    request.end();
  });
}
function airPlayCounterNonce(counter) {
  const nonce =
    Buffer.alloc(12);

  nonce.writeBigUInt64LE(
    BigInt(counter),
    4,
  );

  return nonce;
}


function createAirPlayControlChannel(
  socket,
  writeKey,
  readKey,
) {
  return {
    socket,

    writeKey,
    readKey,

    writeCounter: 0,
    readCounter: 0,

    encryptedBuffer:
      Buffer.alloc(0),

    plaintextBuffer:
      Buffer.alloc(0),

    cseq: 1,
    requestQueue:
      Promise.resolve(),
  };
}


function encryptAirPlayControlData(
  channel,
  plaintext,
) {
  const input =
    Buffer.isBuffer(plaintext)
      ? plaintext
      : Buffer.from(plaintext);

  const output = [];

  for (
    let offset = 0;
    offset < input.length;
    offset += 1024
  ) {
    const block =
      input.subarray(
        offset,
        offset + 1024,
      );

    const length =
      Buffer.alloc(2);

    length.writeUInt16LE(
      block.length,
      0,
    );

    const nonce =
      airPlayCounterNonce(
        channel.writeCounter,
      );

    const cipher =
      chacha20poly1305(
        new Uint8Array(
          channel.writeKey,
        ),

        new Uint8Array(nonce),

        new Uint8Array(length),
      );

    const encrypted =
      cipher.encrypt(
        new Uint8Array(block),
      );

    output.push(
      length,
      Buffer.from(encrypted),
    );

    channel.writeCounter += 1;
  }

  return Buffer.concat(output);
}


function decryptAirPlayControlData(
  channel,
  incoming,
) {
  channel.encryptedBuffer =
    Buffer.concat([
      channel.encryptedBuffer,
      Buffer.from(incoming),
    ]);

  const plaintext = [];

  while (
    channel.encryptedBuffer.length >= 2
  ) {
    const lengthHeader =
      channel.encryptedBuffer
        .subarray(0, 2);

    const plaintextLength =
      lengthHeader.readUInt16LE(0);

    const frameLength =
      2 +
      plaintextLength +
      16;

    if (
      channel.encryptedBuffer.length <
      frameLength
    ) {
      break;
    }

    const encrypted =
      channel.encryptedBuffer
        .subarray(
          2,
          frameLength,
        );

    const nonce =
      airPlayCounterNonce(
        channel.readCounter,
      );

    const cipher =
      chacha20poly1305(
        new Uint8Array(
          channel.readKey,
        ),

        new Uint8Array(nonce),

        new Uint8Array(
          lengthHeader,
        ),
      );

    const decrypted =
      cipher.decrypt(
        new Uint8Array(encrypted),
      );

    plaintext.push(
      Buffer.from(decrypted),
    );

    channel.readCounter += 1;

    channel.encryptedBuffer =
      channel.encryptedBuffer
        .subarray(frameLength);
  }

  return Buffer.concat(
    plaintext,
  );
}


function tryParseAirPlayRtspResponse(
  channel,
) {
  const headerEnd =
    channel.plaintextBuffer.indexOf(
      "\r\n\r\n",
    );

  if (headerEnd < 0) {
    return null;
  }

  const headerText =
    channel.plaintextBuffer
      .subarray(0, headerEnd)
      .toString("utf8");

  const lines =
    headerText.split("\r\n");

  const statusLine =
    lines.shift() || "";

  const statusMatch =
    statusLine.match(
      /^(?:RTSP|HTTP)\/\d+(?:\.\d+)?\s+(\d+)/i,
    );

  if (!statusMatch) {
    throw new Error(
      `Invalid AirPlay RTSP response: ${statusLine}`,
    );
  }

  const headers = {};

  for (const line of lines) {
    const colon =
      line.indexOf(":");

    if (colon < 0) {
      continue;
    }

    const name =
      line
        .slice(0, colon)
        .trim()
        .toLowerCase();

    const value =
      line
        .slice(colon + 1)
        .trim();

    headers[name] = value;
  }

  const contentLength =
    Number(
      headers[
        "content-length"
      ] || 0,
    );

  const bodyStart =
    headerEnd + 4;

  const totalLength =
    bodyStart +
    contentLength;

  if (
    channel.plaintextBuffer.length <
    totalLength
  ) {
    return null;
  }

  const body =
    Buffer.from(
      channel.plaintextBuffer
        .subarray(
          bodyStart,
          totalLength,
        ),
    );

  channel.plaintextBuffer =
    channel.plaintextBuffer
      .subarray(totalLength);

  return {
    statusCode:
      Number(statusMatch[1]),

    headers,
    body,
  };
}


function waitForEncryptedAirPlayResponse(
  channel,
) {
  return new Promise(
    (resolve, reject) => {
      const socket =
        channel.socket;

      const timer =
        setTimeout(() => {
          cleanup();

          reject(
            new Error(
              "Encrypted AirPlay response timed out.",
            ),
          );
        }, 5000);

      function cleanup() {
        clearTimeout(timer);

        socket.removeListener(
          "data",
          onData,
        );

        socket.removeListener(
          "error",
          onError,
        );

        socket.removeListener(
          "close",
          onClose,
        );
      }

      function onError(error) {
        cleanup();
        reject(error);
      }

      function onClose() {
        cleanup();

        reject(
          new Error(
            "AirPlay control socket closed.",
          ),
        );
      }

      function onData(chunk) {
        try {
          const plaintext =
            decryptAirPlayControlData(
              channel,
              chunk,
            );

          if (plaintext.length) {
            channel.plaintextBuffer =
              Buffer.concat([
                channel
                  .plaintextBuffer,

                plaintext,
              ]);
          }

          const response =
            tryParseAirPlayRtspResponse(
              channel,
            );

          if (response) {
            cleanup();
            resolve(response);
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      }

      socket.on(
        "data",
        onData,
      );

      socket.once(
        "error",
        onError,
      );

      socket.once(
        "close",
        onClose,
      );
    },
  );
}
function formatAirPlayFeatureMask(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  try {
    const numeric =
      BigInt(value);

    return {
      decimal:
        numeric.toString(),

      hex:
        `0x${numeric
          .toString(16)
          .toUpperCase()}`,
    };
  } catch {
    return {
      raw:
        String(value),
    };
  }
}


function summarizeAirPlayInfo(info) {
  const displays =
    Array.isArray(info?.displays)
      ? info.displays.map(
          (display) => ({
            uuid:
              display?.uuid,

            width:
              display?.width,

            height:
              display?.height,

            widthPixels:
              display?.widthPixels,

            heightPixels:
              display?.heightPixels,

            widthPhysical:
              display?.widthPhysical,

            heightPhysical:
              display?.heightPhysical,

            refreshRate:
              display?.refreshRate,

            maxFPS:
              display?.maxFPS,

            overscanned:
              display?.overscanned,

            rotation:
              display?.rotation,
          }),
        )
      : [];

  return {
    name:
      info?.name,

    model:
      info?.model,

    deviceID:
      info?.deviceID,

    macAddress:
      info?.macAddress,

    sourceVersion:
      info?.sourceVersion,

    protocolVersion:
      info?.protocolVersion,

    features:
      formatAirPlayFeatureMask(
        info?.features,
      ),

    statusFlags:
      info?.statusFlags,

    vv:
      info?.vv,

    displays,

    audioFormats:
      Array.isArray(
        info?.audioFormats,
      )
        ? info.audioFormats.length
        : 0,

    audioLatencies:
      Array.isArray(
        info?.audioLatencies,
      )
        ? info.audioLatencies.length
        : 0,

    keys:
      Object.keys(info || {}),
  };
}
function getAirPlayVideoTarget(info) {
  const display =
    Array.isArray(info?.displays)
      ? info.displays[0]
      : null;

  if (!display) {
    return null;
  }

  const width =
    Number(
      display.widthPixelsMax ||
      display.widthPixels ||
      display.width ||
      0,
    );

  const height =
    Number(
      display.heightPixelsMax ||
      display.heightPixels ||
      display.height ||
      0,
    );

  const maxFPS =
    Number(
      display.maxFPS || 30,
    );

  if (!width || !height) {
    return null;
  }

  return {
    width,
    height,
    maxFPS,

    displayUUID:
      display.uuid || "",

    hdr:
      info?.receiverHDRCapability || "",

    receiverName:
      info?.name || "",

    receiverModel:
      info?.model || "",
  };
}
async function probeEncryptedAirPlayInfo(
  channel,
) {
  const cseq =
    channel.cseq++;

  const request =
    Buffer.from(
      [
        "GET /info RTSP/1.0",
        `CSeq: ${cseq}`,
        "User-Agent: AirPlay/550.10",
        "X-Apple-ProtocolVersion: 1",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
      "utf8",
    );

  const responsePromise =
    waitForEncryptedAirPlayResponse(
      channel,
    );

  const encrypted =
    encryptAirPlayControlData(
      channel,
      request,
    );

  channel.socket.write(
    encrypted,
  );

  return responsePromise;
}
async function sendEncryptedAirPlayRtspRequestNow(
  channel,
  method,
  uri,
  body = Buffer.alloc(0),
  contentType = "",
  extraHeaders = {},
) {
  const cseq =
    channel.cseq++;

  const headers = [
    `${method} ${uri} RTSP/1.0`,
    `CSeq: ${cseq}`,
    "User-Agent: AirPlay/980.71.1",
    "X-Apple-ProtocolVersion: 1",
  ];

  if (contentType) {
    headers.push(
      `Content-Type: ${contentType}`,
    );
  }

  for (
    const [name, value]
    of Object.entries(extraHeaders)
  ) {
    if (
      value === undefined ||
      value === null
    ) {
      continue;
    }

    headers.push(
      `${name}: ${value}`,
    );
  }

  headers.push(
    `Content-Length: ${body.length}`,
    "",
    "",
  );

  const plaintext =
    Buffer.concat([
      Buffer.from(
        headers.join("\r\n"),
        "utf8",
      ),
      body,
    ]);

  const responsePromise =
    waitForEncryptedAirPlayResponse(
      channel,
    );

  const encrypted =
    encryptAirPlayControlData(
      channel,
      plaintext,
    );

  channel.socket.write(
    encrypted,
  );

  return responsePromise;
}

function sendEncryptedAirPlayRtspRequest(
  channel,
  method,
  uri,
  body = Buffer.alloc(0),
  contentType = "",
  extraHeaders = {},
) {
  const previous =
    channel.requestQueue ||
    Promise.resolve();
  const response = previous
    .catch(() => {})
    .then(() =>
      sendEncryptedAirPlayRtspRequestNow(
        channel,
        method,
        uri,
        body,
        contentType,
        extraHeaders,
      ),
    );

  channel.requestQueue =
    response.then(
      () => undefined,
      () => undefined,
    );

  return response;
}
async function runAirPlayFairPlayHelper(
  command,
  input = null,
) {
  const args = [
    command,
  ];

  if (input) {
    args.push(
      Buffer.from(input)
        .toString("base64"),
    );
  }

  const {
    stdout,
    stderr,
  } =
    await execFileAsync(
      FAIRPLAY_HELPER_PATH,
      args,
      {
        windowsHide: true,
        timeout: 10000,
        maxBuffer:
          1024 * 1024,
      },
    );

  if (stderr?.trim()) {
    console.warn(
      "[AirSpan] FairPlay helper:",
      stderr.trim(),
    );
  }

  const encoded =
    stdout.trim();

  if (!encoded) {
    throw new Error(
      "FairPlay helper returned no data.",
    );
  }

  return Buffer.from(
    encoded,
    "base64",
  );
}


async function setupAirPlayFairPlay(
  controlChannel,
) {
  const m1 =
    await runAirPlayFairPlayHelper(
      "m1",
    );

  const m2Response =
    await sendEncryptedAirPlayRtspRequest(
      controlChannel,
      "POST",
      "/fp-setup",
      m1,
      "application/octet-stream",
      {
        "X-Apple-ET":
          "32",
      },
    );

  if (
    m2Response.statusCode !==
    200
  ) {
    const error =
      new Error(
        `AirPlay FairPlay M1 returned ${m2Response.statusCode}.`,
      );
    error.statusCode =
      m2Response.statusCode;
    throw error;
  }

  if (!m2Response.body.length) {
    throw new Error(
      "AirPlay FairPlay M2 was empty.",
    );
  }

  const m3 =
    await runAirPlayFairPlayHelper(
      "m3",
      m2Response.body,
    );

  const m4Response =
    await sendEncryptedAirPlayRtspRequest(
      controlChannel,
      "POST",
      "/fp-setup",
      m3,
      "application/octet-stream",
      {
        "X-Apple-ET":
          "32",
      },
    );

  if (
    m4Response.statusCode !==
    200
  ) {
    const error =
      new Error(
        `AirPlay FairPlay M3 returned ${m4Response.statusCode}.`,
      );
    error.statusCode =
      m4Response.statusCode;
    throw error;
  }

  controlChannel.fairPlay = {
    ready: true,

    m2Bytes:
      m2Response.body.length,

    m3Bytes:
      m3.length,

    m4Bytes:
      m4Response.body.length,
  };

  console.log(
    "[AirSpan] AirPlay FairPlay SAP ready:",
    controlChannel.fairPlay,
  );

  return (
    controlChannel.fairPlay
  );
}
function createAirPlaySenderDeviceId() {
  const bytes =
    Buffer.from(
      randomUUID()
        .replace(/-/g, "")
        .slice(0, 12),
      "hex",
    );

  // Locally administered,
  // unicast MAC-style address.
  bytes[0] =
    (bytes[0] | 0x02) & 0xfe;

  return Array.from(bytes)
    .map(
      (value) =>
        value
          .toString(16)
          .padStart(2, "0")
          .toUpperCase(),
    )
    .join(":");
}

// AirPlay's native AP2 timing path uses an EUI-64-shaped PTP clock identity.
// Derive it from the same locally-administered MAC-style identity advertised
// in SETUP so the receiver can associate the PTP packets with this session.
function createAirPlayPtpClockId(senderDeviceID) {
  const mac =
    Buffer.from(
      String(senderDeviceID || "")
        .split(":")
        .map((part) => Number.parseInt(part, 16))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 255),
    );

  if (mac.length !== 6) {
    return 0n;
  }

  const eui64 = Buffer.from([
    mac[0] ^ 0x02,
    mac[1],
    mac[2],
    0xff,
    0xfe,
    mac[3],
    mac[4],
    mac[5],
  ]);

  return eui64.readBigUInt64BE(0);
}

function writeAirPlayPtpTimestamp(buffer, offset, timestampNs) {
  const value =
    BigInt.asUintN(
      80,
      BigInt(timestampNs || 0),
    );
  const seconds = value / 1000000000n;
  const nanoseconds = Number(value % 1000000000n);

  buffer.writeUInt16BE(
    Number((seconds >> 32n) & 0xffffn),
    offset,
  );
  buffer.writeUInt32BE(
    Number(seconds & 0xffffffffn),
    offset + 2,
  );
  buffer.writeUInt32BE(
    nanoseconds >>> 0,
    offset + 6,
  );
}

function writeAirPlayPtpHeader(
  buffer,
  messageType,
  messageLength,
  flags,
  clockID,
  sequence,
  control,
  logInterval,
) {
  buffer.fill(0);
  // transportSpecific=1 is the gPTP profile used by AirPlay receivers.
  buffer[0] = 0x10 | (messageType & 0x0f);
  buffer[1] = 0x02;
  buffer.writeUInt16BE(messageLength, 2);
  buffer[4] = 0;
  buffer.writeUInt16BE(flags, 6);
  buffer.writeBigUInt64BE(
    BigInt.asUintN(64, BigInt(clockID || 0)),
    20,
  );
  // Port identity 0x8005 is what iOS senders advertise.
  buffer.writeUInt16BE(0x8005, 28);
  buffer.writeUInt16BE(sequence & 0xffff, 30);
  buffer[32] = control & 0xff;
  buffer.writeInt8(logInterval, 33);
}

// LG/webOS televisions commonly advertise AirPlay 2 features that overlap
// with PTP. Keep this helper available for the legacy timing fallback, but do
// not force NTP for the whole screen-mirroring session: the LG video-class
// receiver accepts the PTP SETUP and can otherwise reset the video socket when
// the session is advertised as NTP.
function airPlayDevicePrefersNtp(device) {
  const text = [
    device?.manufacturer,
    device?.model,
    device?.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    /\blg\b/.test(text) ||
    /webos/.test(text) ||
    /(?:^|[^a-z])(oled|qned|nano|uk\d|um\d|un\d|up\d|uq\d|ur\d|ut\d)/.test(text)
  );
}

const AIRPLAY_NTP_EPOCH_OFFSET_MS = 2208988800000;

function compactAirPlayNtpMilliseconds(value) {
  return compactAirPlayMilliseconds(
    Number(value) + AIRPLAY_NTP_EPOCH_OFFSET_MS,
  );
}

function startAirPlayNtpTiming(
  device,
  localAddress,
) {
  const remoteAddress =
    getAirPlayNetworkAddress(device);

  if (!remoteAddress || !localAddress) {
    return Promise.resolve(null);
  }

  const socket = dgram.createSocket("udp4");

  return new Promise((resolve) => {
    const fail = (error) => {
      try { socket.close(); } catch {}
      console.warn(
        "[AirSpan] AirPlay NTP timing socket could not be opened; falling back to PTP:",
        error,
      );
      resolve(null);
    };

    socket.once("error", fail);
    socket.bind(
      {
        address: localAddress,
        port: 0,
      },
      () => {
        socket.removeListener("error", fail);

        let running = true;
        let requests = 0;

        const currentTimestamp = () =>
          compactAirPlayNtpMilliseconds(
            Date.now(),
          );

        socket.on("error", (error) => {
          console.warn(
            "[AirSpan] AirPlay NTP timing socket error:",
            error,
          );
        });

        socket.on("message", (request, rinfo) => {
          // NTP timing requests are 32-byte packets with RTP payload type
          // 0xd2. The receiver expects the request's reference timestamp at
          // bytes 8..15 and receive/send timestamps at 16..31.
          if (
            !running ||
            request.length < 32 ||
            request[1] !== 0xd2
          ) {
            return;
          }

          requests += 1;
          if (requests === 1 || requests % 100 === 0) {
            airPlayDiagnostic("ntp-request", {
              requests,
              remoteAddress: rinfo.address,
              remotePort: rinfo.port,
            });
          }

          const response = Buffer.alloc(32);
          response[0] = 0x80;
          response[1] = 0xd3;
          response.writeUInt16BE(7, 2);
          request.copy(response, 8, 24, 32);

          const timestamp = currentTimestamp();
          response.writeBigUInt64BE(timestamp, 16);
          response.writeBigUInt64BE(timestamp, 24);

          try {
            socket.send(
              response,
              rinfo.port,
              rinfo.address,
            );
          } catch (error) {
            console.warn(
              "[AirSpan] Could not send AirPlay NTP timing response:",
              error,
            );
          }
        });

        const address = socket.address();
        const timingPort =
          typeof address === "object"
            ? address.port
            : 0;

        if (!timingPort) {
          try { socket.close(); } catch {}
          resolve(null);
          return;
        }

        const timing = {
          enabled: false,
          protocol: "NTP",
          timingPort,
          requests: () => requests,
          remoteAddress,
          localAddress,
          stop() {
            if (!running) {
              return;
            }
            running = false;
            try { socket.close(); } catch {}
          },
        };

        console.log(
          "[AirSpan] AirPlay NTP timing ready:",
          {
            timingPort,
            remoteAddress,
            localAddress,
          },
        );
        airPlayDiagnostic("ntp-transport-ready", {
          timingPort,
          remoteAddress,
          localAddress,
        });
        resolve(timing);
      },
    );
  });
}

async function startAirPlayPtpTiming(
  device,
  localAddress,
  clockID,
) {
  const remoteAddress =
    getAirPlayNetworkAddress(device);

  if (!remoteAddress || !clockID) {
    return null;
  }

  const eventSocket = dgram.createSocket("udp4");
  const generalSocket = dgram.createSocket("udp4");

  try {
    await Promise.all([
      new Promise((resolve, reject) => {
        eventSocket.once("error", reject);
        eventSocket.bind({ address: localAddress, port: 319 }, resolve);
      }),
      new Promise((resolve, reject) => {
        generalSocket.once("error", reject);
        generalSocket.bind({ address: localAddress, port: 320 }, resolve);
      }),
    ]);
  } catch (error) {
    try { eventSocket.close(); } catch {}
    try { generalSocket.close(); } catch {}
    console.warn(
      "[AirSpan] Native AirPlay PTP ports could not be opened; retaining the receiver-clock fallback.",
      error,
    );
    return null;
  }

  eventSocket.on("error", (error) => {
    console.warn("[AirSpan] AirPlay PTP event socket error:", error);
  });
  generalSocket.on("error", (error) => {
    console.warn("[AirSpan] AirPlay PTP general socket error:", error);
  });

  let running = true;
  let anchorLocalMs = null;
  let anchorTimestamp = 0n;
  let announceSequence = 1;
  let syncSequence = 1;
  let announceTimer = null;
  let syncTimer = null;

  const currentTimestamp = () => {
    if (!Number.isFinite(anchorLocalMs)) {
      return 0n;
    }

    const elapsed = Math.max(
      0,
      performance.now() - anchorLocalMs,
    );

    return airPlayPtpNanoseconds(
      anchorTimestamp + compactAirPlayMilliseconds(elapsed),
    );
  };

  const send = (socket, packet, port, targetAddress = remoteAddress) => {
    if (!running || !packet.length) {
      return;
    }
    try {
      socket.send(packet, port, targetAddress);
    } catch (error) {
      console.warn("[AirSpan] Could not send AirPlay PTP packet:", error);
    }
  };

  const sendAnnounce = () => {
    const packet = Buffer.alloc(76);
    writeAirPlayPtpHeader(
      packet,
      0x0b,
      packet.length,
      0x0408,
      clockID,
      announceSequence,
      0,
      0,
    );
    const body = 34;
    // originTimestamp/currentUtcOffset/reserved
    packet[body + 13] = 128; // priority1
    packet[body + 14] = 6; // GPS-locked clock class
    packet[body + 15] = 0x21; // 100 ns accuracy
    packet.writeUInt16BE(0x436a, body + 16);
    packet[body + 18] = 128; // priority2
    packet.writeBigUInt64BE(clockID, body + 19);
    packet.writeUInt16BE(0, body + 27); // stepsRemoved
    packet[body + 29] = 0x20; // GPS time source
    packet.writeUInt16BE(0x0008, body + 30); // PATH_TRACE type
    packet.writeUInt16BE(0x0008, body + 32); // PATH_TRACE length
    packet.writeBigUInt64BE(clockID, body + 34);
    send(generalSocket, packet, 320);
    announceSequence = (announceSequence + 1) & 0xffff;
  };

  const sendSync = () => {
    const sequence = syncSequence;
    const sync = Buffer.alloc(44);
    writeAirPlayPtpHeader(
      sync,
      0x00,
      sync.length,
      0x0608,
      clockID,
      sequence,
      0,
      -3,
    );
    send(eventSocket, sync, 319);

    const followUp = Buffer.alloc(96);
    writeAirPlayPtpHeader(
      followUp,
      0x08,
      followUp.length,
      0x0408,
      clockID,
      sequence,
      0,
      -3,
    );
    writeAirPlayPtpTimestamp(
      followUp,
      34,
      currentTimestamp(),
    );
    // 802.1AS Follow_Up information TLV.
    followUp.writeUInt16BE(0x0003, 44);
    followUp.writeUInt16BE(0x001c, 46);
    followUp[48] = 0x00;
    followUp[49] = 0x80;
    followUp[50] = 0xc2;
    followUp[53] = 0x01;
    // Apple clock-id organization TLV.
    followUp.writeUInt16BE(0x0003, 76);
    followUp.writeUInt16BE(0x0010, 78);
    followUp[80] = 0x00;
    followUp[81] = 0x0d;
    followUp[82] = 0x93;
    followUp[85] = 0x04;
    followUp.writeBigUInt64BE(clockID, 86);
    send(generalSocket, followUp, 320);
    syncSequence = (syncSequence + 1) & 0xffff;
  };

  const sendDelayResponse = (request, rinfo) => {
    if (request.length < 44) {
      return;
    }
    const response = Buffer.alloc(54);
    writeAirPlayPtpHeader(
      response,
      0x09,
      response.length,
      0x0608,
      clockID,
      request.readUInt16BE(30),
      0,
      -3,
    );
    writeAirPlayPtpTimestamp(response, 34, currentTimestamp());
    request.copy(response, 44, 20, 30);
    send(generalSocket, response, 320, rinfo.address);
  };

  const sendPdelayResponses = (request, rinfo) => {
    if (request.length < 44) {
      return;
    }
    const sequence = request.readUInt16BE(30);
    const response = Buffer.alloc(54);
    writeAirPlayPtpHeader(
      response,
      0x03,
      response.length,
      0x0608,
      clockID,
      sequence,
      0,
      -3,
    );
    writeAirPlayPtpTimestamp(response, 34, currentTimestamp());
    request.copy(response, 44, 20, 30);
    send(eventSocket, response, 319, rinfo.address);

    const followUp = Buffer.alloc(54);
    writeAirPlayPtpHeader(
      followUp,
      0x0a,
      followUp.length,
      0x0408,
      clockID,
      sequence,
      0,
      -3,
    );
    writeAirPlayPtpTimestamp(followUp, 34, currentTimestamp());
    request.copy(followUp, 44, 20, 30);
    send(generalSocket, followUp, 320, rinfo.address);
  };

  const sendSignalingGrant = (request, rinfo) => {
    if (request.length < 48) {
      return;
    }

    const grants = [];
    let offset = 44; // header + targetPortIdentity
    while (offset + 4 <= request.length) {
      const type = request.readUInt16BE(offset);
      const length = request.readUInt16BE(offset + 2);
      const end = offset + 4 + length;
      if (end > request.length) {
        break;
      }
      if (type === 0x0004 && length >= 6) {
        const value = request.subarray(offset + 4, end);
        const duration = value.readUInt32BE(2) || 300;
        const grant = Buffer.alloc(12);
        grant.writeUInt16BE(0x0005, 0);
        grant.writeUInt16BE(8, 2);
        grant[4] = value[0] & 0xf0;
        grant[5] = value[1];
        grant.writeUInt32BE(duration, 6);
        grant[11] = 1; // renewal invited
        grants.push(grant);
      }
      offset = end;
    }

    if (!grants.length) {
      return;
    }

    const response = Buffer.alloc(44 + grants.length * 12);
    writeAirPlayPtpHeader(
      response,
      0x0c,
      response.length,
      0x0400,
      clockID,
      request.readUInt16BE(30),
      0x05,
      0x7f,
    );
    request.copy(response, 34, 20, 30);
    for (let index = 0; index < grants.length; index += 1) {
      grants[index].copy(response, 44 + index * 12);
    }
    send(generalSocket, response, 320, rinfo.address);
  };

  eventSocket.on("message", (packet, rinfo) => {
    if (!running || packet.length < 34) {
      return;
    }
    const messageType = packet[0] & 0x0f;
    if (messageType === 0x01) {
      sendDelayResponse(packet, rinfo);
    } else if (messageType === 0x02) {
      sendPdelayResponses(packet, rinfo);
    }
  });

  generalSocket.on("message", (packet, rinfo) => {
    if (!running || packet.length < 34) {
      return;
    }
    if ((packet[0] & 0x0f) === 0x0c) {
      sendSignalingGrant(packet, rinfo);
    }
  });

  const startPeriodic = () => {
    if (!running || announceTimer || !Number.isFinite(anchorLocalMs)) {
      return;
    }
    sendAnnounce();
    sendSync();
    announceTimer = setInterval(sendAnnounce, 1000);
    syncTimer = setInterval(sendSync, 125);
  };

  const timing = {
    enabled: true,
    clockID,
    remoteAddress,
    localAddress,
    setClock(clock) {
      if (!clock) {
        return;
      }
      anchorLocalMs = clock.anchorLocalMs;
      anchorTimestamp = clock.anchorTimestamp;
      startPeriodic();
    },
    stop() {
      if (!running) {
        return;
      }
      running = false;
      if (announceTimer) clearInterval(announceTimer);
      if (syncTimer) clearInterval(syncTimer);
      try { eventSocket.close(); } catch {}
      try { generalSocket.close(); } catch {}
    },
  };

  console.log(
    "[AirSpan] AirPlay PTP timing ready:",
    {
      clockID: `0x${clockID.toString(16).toUpperCase()}`,
      remoteAddress,
      localAddress,
    },
  );
  airPlayDiagnostic("ptp-transport-ready", {
    clockID: clockID.toString(),
    remoteAddress,
    localAddress,
  });
  return timing;
}


function createAirPlayStreamConnectionId() {
  return String(
    createAirPlayVideoStreamId(),
  );
}


async function startEncryptedAirPlayControlSetup(
  device,
  channel,
) {
  const localAddress =
    channel.socket.localAddress;

  if (!localAddress) {
    throw new Error(
      "AirPlay control socket has no local address.",
    );
  }

  const senderDeviceID =
    createAirPlaySenderDeviceId();

  const senderClockID =
    createAirPlayPtpClockId(
      senderDeviceID,
    );

  // PTP is the stable timing mode for screen video. LG/webOS receivers need
  // the legacy NTP session advertisement for their type-96 audio clock, so
  // keep the native PTP clock/timeline alive for video while negotiating NTP
  // on that receiver-specific path.
  const ptpTiming =
    await startAirPlayPtpTiming(
      device,
      localAddress,
      senderClockID,
    );

  // The LG/webOS compatibility path uses NTP-style RTP audio even while the
  // enclosing screen session remains PTP for stable video. Keep an auxiliary
  // NTP responder alive for those receivers so they can complete their audio
  // clock exchange; it does not replace the PTP media timeline.
  const ntpTiming =
    ptpTiming && airPlayDevicePrefersNtp(device)
      ? await startAirPlayNtpTiming(
          device,
          localAddress,
        )
      : ptpTiming
        ? null
        : await startAirPlayNtpTiming(
            device,
            localAddress,
          );

  const timingProtocol =
    airPlayDevicePrefersNtp(device)
      ? "NTP"
      : ptpTiming
        ? "PTP"
        : "NTP";

  // Keep the transport reachable even if a later SETUP parse or response
  // fails before the session object is attached to the channel.
  channel.ptpTiming = ptpTiming;
  channel.ntpTiming = ntpTiming;

  const sessionUUID =
    randomUUID().toUpperCase();

  const timingPeerID =
    randomUUID().toUpperCase();

  const timingPeerInfo = {
    ID:
      timingPeerID,

    SupportsClockPortMatchingOverride:
      true,

    DeviceType:
      0,

    Addresses: [
      localAddress,
    ],

    ...(ptpTiming
      ? {
          ClockID:
          senderClockID,
        }
      : {}),
  };

  const payload = {
    deviceID:
      senderDeviceID,

    macAddress:
      senderDeviceID,

    sessionUUID,

    sourceVersion:
      "980.71.1",

    isScreenMirroringSession:
      true,

    timingProtocol:
      timingProtocol,

    ...(ntpTiming
      ? {
          timingPort:
            ntpTiming.timingPort,
        }
      : {}),

    osBuildVersion:
      "13F69",

    model:
      "Windows",

    name:
      "AirSpan",

    ...(ptpTiming
      ? {
          timingPeerInfo,
          timingPeerList: [
            timingPeerInfo,
          ],
        }
      : {}),

    updateSessionRequest:
      false,

    combinedGetInfoWithControlSetup:
      true,
  };

  const body =
    Buffer.from(
      buildBinary(payload),
    );

  const address =
    getAirPlayNetworkAddress(
      device,
    );

  const streamConnectionID =
    createAirPlayStreamConnectionId();

  const uri =
    `rtsp://${address}:${device.port || 7000}/${streamConnectionID}`;

  console.log(
    "[AirSpan] Sending AirPlay control SETUP:",
    {
      device:
        device.name,

      uri,

      sessionUUID,

      streamConnectionID,

      timingProtocol:
        payload.timingProtocol,

      timingPort:
        payload.timingPort || null,

      timingPeerID,

      senderClockID:
        `0x${senderClockID
          .toString(16)
          .toUpperCase()}`,

      ptpTiming:
        Boolean(ptpTiming),

      ntpTiming:
        Boolean(ntpTiming),

      localAddress,

      bodyBytes:
        body.length,

      writeCounter:
        channel.writeCounter,

      readCounter:
        channel.readCounter,
    },
  );

  const response =
    await sendEncryptedAirPlayRtspRequest(
      channel,
      "SETUP",
      uri,
      body,
      "application/x-apple-binary-plist",
    );

  if (
    response.statusCode < 200 ||
    response.statusCode >= 300
  ) {
    ptpTiming?.stop?.();
    ntpTiming?.stop?.();
  }

  let parsed = {};

  if (response.body.length) {
    const result =
      parseBinaryPlist(
        response.body,
      );

    parsed =
      Array.isArray(result)
        ? result[0] || {}
        : result || {};
  }

  console.log(
    "[AirSpan] AirPlay control SETUP response:",
    {
      statusCode:
        response.statusCode,

      bytes:
        response.body.length,

      keys:
        Object.keys(parsed),

      eventPort:
        parsed.eventPort,

      timingPort:
        parsed.timingPort,

      skipRecord:
        parsed.skipRecord,

      timingPeerInfo:
        parsed.timingPeerInfo,

      infoKeys:
        parsed.info
          ? Object.keys(
              parsed.info,
            )
          : [],

      displays:
        parsed.info?.displays,

      sessionHeader:
        response.headers[
          "session"
        ],

      requestReceivedTimestamp:
        response.headers[
          "x-apple-requestreceivedtimestamp"
        ],

      processingTime:
        response.headers[
          "x-apple-processingtime"
        ],

      writeCounter:
        channel.writeCounter,

      readCounter:
        channel.readCounter,
    },
  );

  return {
    response,
    parsed,
    uri,
    sessionUUID,
    streamConnectionID,
    senderDeviceID,
    senderClockID,
    timingPeerID,
    ptpTiming,
    ntpTiming,
    timingProtocol,
  };
}
function createAirPlayEventChannel(
  socket,
  sharedSecret,
  controlChannel,
) {
  // Event-channel direction is reversed.
  //
  // Apple TV -> AirSpan:
  // Events-Write-Encryption-Key
  //
  // AirSpan -> Apple TV:
  // Events-Read-Encryption-Key

  const readKey =
    hapHkdf(
      "Events-Salt",
      "Events-Write-Encryption-Key",
      sharedSecret,
    );

  const writeKey =
    hapHkdf(
      "Events-Salt",
      "Events-Read-Encryption-Key",
      sharedSecret,
    );

  return {
    socket,

    readKey,
    writeKey,

    readCounter: 0,
    writeCounter: 0,

    encryptedBuffer:
      Buffer.alloc(0),

    plaintextBuffer:
      Buffer.alloc(0),

    controlChannel,
  };
}


function tryParseAirPlayEventRequest(
  channel,
) {
  const headerEnd =
    channel.plaintextBuffer.indexOf(
      "\r\n\r\n",
    );

  if (headerEnd < 0) {
    return null;
  }

  const headerText =
    channel.plaintextBuffer
      .subarray(0, headerEnd)
      .toString("utf8");

  const lines =
    headerText.split("\r\n");

  const requestLine =
    lines.shift() || "";

  const requestMatch =
    requestLine.match(
      /^([A-Z_]+)\s+(\S+)\s+RTSP\/1\.0$/i,
    );

  if (!requestMatch) {
    throw new Error(
      `Invalid AirPlay event request: ${requestLine}`,
    );
  }

  const headers = {};

  for (const line of lines) {
    const colon =
      line.indexOf(":");

    if (colon < 0) {
      continue;
    }

    const name =
      line
        .slice(0, colon)
        .trim()
        .toLowerCase();

    const value =
      line
        .slice(colon + 1)
        .trim();

    headers[name] = value;
  }

  const contentLength =
    Number(
      headers[
        "content-length"
      ] || 0,
    );

  const bodyStart =
    headerEnd + 4;

  const totalLength =
    bodyStart +
    contentLength;

  if (
    channel.plaintextBuffer.length <
    totalLength
  ) {
    return null;
  }

  const body =
    Buffer.from(
      channel.plaintextBuffer
        .subarray(
          bodyStart,
          totalLength,
        ),
    );

  channel.plaintextBuffer =
    channel.plaintextBuffer
      .subarray(totalLength);

  return {
    method:
      requestMatch[1],

    path:
      requestMatch[2],

    cseq:
      headers.cseq || "0",

    headers,

    body,
  };
}
function summarizeAirPlayEventValue(
  value,
  depth = 0,
) {
  if (depth > 6) {
    return "[max depth]";
  }

  if (Buffer.isBuffer(value)) {
    return `<Buffer ${value.length} bytes>`;
  }

  if (value instanceof Uint8Array) {
    return `<Uint8Array ${value.byteLength} bytes>`;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(
      (item) =>
        summarizeAirPlayEventValue(
          item,
          depth + 1,
        ),
    );
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const output = {};

    for (
      const [key, item]
      of Object.entries(value)
    ) {
      output[key] =
        summarizeAirPlayEventValue(
          item,
          depth + 1,
        );
    }

    return output;
  }

  return value;
}

function startAirPlayEventReader(
  channel,
) {
  const socket =
    channel.socket;

  socket.on(
    "data",
    (chunk) => {
      try {
        const plaintext =
          decryptAirPlayControlData(
            channel,
            chunk,
          );

        if (plaintext.length) {
          channel.plaintextBuffer =
            Buffer.concat([
              channel.plaintextBuffer,
              plaintext,
            ]);
        }

        while (true) {
          const request =
            tryParseAirPlayEventRequest(
              channel,
            );

          if (!request) {
            break;
          }

          console.log(
            "[AirSpan] AirPlay EVENT request:",
            {
              method:
                request.method,

              path:
                request.path,

              cseq:
                request.cseq,

              bytes:
                request.body.length,

              contentType:
                request.headers[
                  "content-type"
                ],
            },
          );
if (
  request.body.length &&
  request.headers[
    "content-type"
  ]?.includes(
    "application/x-apple-binary-plist",
  )
) {
  try {
    const parsed =
      parseBinaryPlist(
        request.body,
      );

    const eventBody =
      Array.isArray(parsed)
        ? parsed[0]
        : parsed;

    console.log(
      "[AirSpan] AirPlay EVENT plist:",
      summarizeAirPlayEventValue(
        eventBody,
      ),
    );

    updateAirPlayMediaClockFromEvent(
      channel.controlChannel,
      eventBody,
    );
  } catch (error) {
    console.error(
      "[AirSpan] Could not parse EVENT plist:",
      error,
    );
  }
}
          const response =
            Buffer.from(
              [
                "RTSP/1.0 200 OK",
                "Server: AirTunes/220.68",
                `CSeq: ${request.cseq}`,
                "",
                "",
              ].join("\r\n"),
              "utf8",
            );

          const encrypted =
            encryptAirPlayControlData(
              channel,
              response,
            );

          socket.write(
            encrypted,
          );

          console.log(
            "[AirSpan] AirPlay EVENT acknowledged:",
            {
              cseq:
                request.cseq,

              readCounter:
                channel.readCounter,

              writeCounter:
                channel.writeCounter,
            },
          );
        }
      } catch (error) {
        console.error(
          "[AirSpan] AirPlay EVENT channel error:",
          error,
        );

        socket.destroy();
      }
    },
  );

  socket.on(
    "close",
    () => {
      console.log(
        "[AirSpan] AirPlay EVENT channel closed.",
      );
    },
  );

  socket.on(
    "error",
    (error) => {
      console.error(
        "[AirSpan] AirPlay EVENT socket error:",
        error,
      );
    },
  );
}


async function connectAirPlayEventChannel(
  device,
  eventPort,
  sharedSecret,
  controlChannel,
) {
  const address =
    getAirPlayNetworkAddress(
      device,
    );

  return new Promise(
    (resolve, reject) => {
      const socket =
        net.createConnection({
          host:
            address,

          port:
            eventPort,
        });

      const timer =
        setTimeout(() => {
          socket.destroy();

          reject(
            new Error(
              "AirPlay event-channel connection timed out.",
            ),
          );
        }, 5000);

      function cleanupStartupListeners() {
        clearTimeout(timer);

        socket.removeListener(
          "error",
          startupError,
        );
      }

      function startupError(error) {
        cleanupStartupListeners();
        reject(error);
      }

      socket.once(
        "error",
        startupError,
      );

      socket.once(
        "connect",
        () => {
          cleanupStartupListeners();

          const channel =
            createAirPlayEventChannel(
              socket,
              sharedSecret,
              controlChannel,
            );

          startAirPlayEventReader(
            channel,
          );

          console.log(
            "[AirSpan] AirPlay EVENT channel connected:",
            {
              address,
              port:
                eventPort,

              readKeyBytes:
                channel.readKey.length,

              writeKeyBytes:
                channel.writeKey.length,
            },
          );

          resolve(channel);
        },
      );
    },
  );
}


async function startAirPlayRecord(
  controlChannel,
  controlSetup,
) {
  // RECORD declares the first audio RTP position. Keep these values on the
  // channel so the later type-96 stream setup starts at exactly the same
  // sequence/timestamp instead of advertising one pair and sending another.
  const initialSequence =
    randomBytes(2).readUInt16BE(0);
  const initialRtpTimestamp =
    randomBytes(4).readUInt32BE(0);
  controlChannel.audioInitialSequence =
    initialSequence;
  controlChannel.audioInitialRtpTimestamp =
    initialRtpTimestamp;

  console.log(
    "[AirSpan] Sending AirPlay RECORD:",
    {
      uri:
        controlSetup.uri,

      sessionUUID:
        controlSetup.sessionUUID,

      initialSequence,

      initialRtpTimestamp,

      writeCounter:
        controlChannel.writeCounter,

      readCounter:
        controlChannel.readCounter,
    },
  );

  const response =
    await sendEncryptedAirPlayRtspRequest(
      controlChannel,
      "RECORD",
      controlSetup.uri,
      Buffer.alloc(0),
      "",
      {
        Session:
          controlSetup.sessionUUID,

        Range:
          "npt=0-",

        "RTP-Info":
          `seq=${initialSequence};rtptime=${initialRtpTimestamp}`,
      },
    );

  console.log(
    "[AirSpan] AirPlay RECORD response:",
    {
      statusCode:
        response.statusCode,

      bytes:
        response.body.length,

      audioLatency:
        response.headers[
          "audio-latency"
        ],

      server:
        response.headers.server,

      writeCounter:
        controlChannel.writeCounter,

      readCounter:
        controlChannel.readCounter,
    },
  );

  return response;
}

async function setAirPlayTimingPeers(
  device,
  controlChannel,
  controlSetup,
) {
  if (!controlSetup.ptpTiming?.enabled) {
    return null;
  }

  const localAddress =
    controlChannel.socket.localAddress;
  const remoteAddress =
    getAirPlayNetworkAddress(device);

  if (!localAddress || !remoteAddress) {
    return null;
  }

  // SETPEERS is a bare binary-plist address array. The receiver is listed
  // first, followed by the sender, matching native AP2 senders.
  const body =
    Buffer.from(
      buildBinary([
        remoteAddress,
        localAddress,
      ]),
    );

  console.log(
    "[AirSpan] Sending AirPlay SETPEERS:",
    {
      remoteAddress,
      localAddress,
      bodyBytes: body.length,
    },
  );

  try {
    const response =
      await sendEncryptedAirPlayRtspRequest(
        controlChannel,
        "SETPEERS",
        controlSetup.uri,
        body,
        "/peer-list-changed",
      );

    console.log(
      "[AirSpan] AirPlay SETPEERS response:",
      {
        statusCode: response.statusCode,
        bytes: response.body.length,
      },
    );

    airPlayDiagnostic("ptp-setpeers", {
      statusCode: response.statusCode,
      remoteAddress,
      localAddress,
    });

    if (
      response.statusCode < 200 ||
      response.statusCode >= 300
    ) {
      console.warn(
        `[AirSpan] AirPlay SETPEERS returned ${response.statusCode}; continuing with PTP timing.`,
      );
    }

    return response;
  } catch (error) {
    // Some older receivers do not implement SETPEERS. The PTP transport can
    // still be useful, so keep the stream alive and expose the failure in the
    // diagnostic log instead of aborting video/audio setup.
    console.warn(
      "[AirSpan] AirPlay SETPEERS failed; continuing with PTP timing:",
      error,
    );
    airPlayDiagnostic("ptp-setpeers-failed", {
      message: String(error?.message || error),
    });
    return null;
  }
}


const AIRPLAY_AUDIO_SAMPLE_RATE = 44100;
const AIRPLAY_AUDIO_SAMPLES_PER_FRAME = 352;
const AIRPLAY_AUDIO_CHANNELS = 2;
// Keep enough audio queued for both Apple and third-party receivers to seat
// the RTP clock mapping before playback. A 100 ms lead produced healthy UDP
// traffic but silent receivers; 250 ms is the last hardware-verified value.
const AIRPLAY_AUDIO_LATENCY_MS = 250;

function writeAirPlayBits(buffer, state, value, count) {
  for (let bit = count - 1; bit >= 0; bit -= 1) {
    const bitValue = (value >>> bit) & 1;
    const byteOffset = Math.floor(state.bitOffset / 8);
    const bitInByte = 7 - (state.bitOffset % 8);
    if (bitValue) {
      buffer[byteOffset] |= 1 << bitInByte;
    }
    state.bitOffset += 1;
  }
}

function encodeAirPlayAlacVerbatimFrame(pcm, frameSamples = AIRPLAY_AUDIO_SAMPLES_PER_FRAME) {
  const source = Buffer.from(pcm);
  const requiredBytes = frameSamples * AIRPLAY_AUDIO_CHANNELS * 2;

  if (source.length < requiredBytes) {
    throw new Error(
      `AirPlay audio frame needs ${requiredBytes} PCM bytes, received ${source.length}.`,
    );
  }

  // A verbatim ALAC element is deliberately simple: it preserves each
  // interleaved 16-bit sample and avoids a dependency on a native encoder.
  // The uncompressed ALAC element omits the optional frame-size field. The
  // receiver expects hasSize=0; including those 32 bits shifts every sample
  // and produces static/garbled audio even though RTP decryption succeeds.
  const bitCount = 23 + frameSamples * AIRPLAY_AUDIO_CHANNELS * 16 + 3;
  const output = Buffer.alloc(Math.ceil(bitCount / 8));
  const state = { bitOffset: 0 };

  writeAirPlayBits(output, state, 1, 3); // element type: verbatim
  writeAirPlayBits(output, state, 0, 4); // instance
  writeAirPlayBits(output, state, 0, 12); // reserved
  writeAirPlayBits(output, state, 0, 1); // no optional frame-size field
  writeAirPlayBits(output, state, 0, 2); // extra bytes
  writeAirPlayBits(output, state, 1, 1); // uncompressed/verbatim samples

  for (let offset = 0; offset < requiredBytes; offset += 2) {
    writeAirPlayBits(output, state, source.readUInt16LE(offset), 16);
  }

  writeAirPlayBits(output, state, 7, 3); // end element
  return output;
}

function airPlayPtpNanoseconds(timestamp) {
  const value = BigInt(timestamp || 0);
  const seconds = value >> 32n;
  const fraction = value & 0xffffffffn;
  return seconds * 1000000000n + ((fraction * 1000000000n) >> 32n);
}

function sendAirPlayAudioSync(
  controlChannel,
  audio,
  rtpTimestamp,
  force = false,
  startBoundary = false,
) {
  const useNtpAudio =
    audio?.timingProtocol === "NTP";
  const currentTimelineID =
    useNtpAudio
      ? 0n
      : controlChannel?.mediaClock?.timelineID ||
        audio?.timelineID ||
        0n;

  if (audio) {
    audio.timelineID = currentTimelineID;
  }

  if (
    audio?.closed ||
    !audio?.controlSocket ||
    !audio.remoteControlPort ||
    audio.controlSocket.closed ||
    audio.controlSocket.destroyed
  ) {
    return false;
  }

  const now = Date.now();
  // LG/webOS receivers let a legacy NTP audio anchor expire much sooner than
  // native PTP receivers. Keep that compatibility path refreshed frequently;
  // native PTP audio retains the normal low-rate announce cadence.
  const syncIntervalMs =
    audio?.timingProtocol === "NTP"
      ? 250
      : 900;
  if (
    !force &&
    audio.lastSyncAt &&
    now - audio.lastSyncAt < syncIntervalMs
  ) {
    return false;
  }

  const clock = getAirPlayMediaTimestamp(controlChannel, 0);
  const hasPtpTimeline = Boolean(currentTimelineID);
  // In the hybrid LG path the media clock remains PTP for video, but the
  // audio receiver expects the legacy NTP wall-clock domain. The global NTP
  // path already anchors the media clock in that domain, so only add the NTP
  // epoch offset when converting from a PTP/Unix-epoch media clock.
  const syncTimestamp =
    useNtpAudio &&
    controlChannel?.session?.ptpTiming?.enabled
      ? clock.timestamp +
        compactAirPlayMilliseconds(
          AIRPLAY_NTP_EPOCH_OFFSET_MS,
        )
      : clock.timestamp;
  const packet = Buffer.alloc(hasPtpTimeline ? 28 : 20);
  packet[0] = startBoundary || !audio.syncPackets ? 0x90 : 0x80;
  packet[1] = hasPtpTimeline ? 0xd7 : 0xd4;
  // The second word identifies the announce layout: 0x0007 for the legacy
  // NTP form and 0x0006 for the native PTP form. The RTP sequence is carried
  // separately in the audio data packets.
  packet.writeUInt16BE(hasPtpTimeline ? 6 : 7, 2);

  const syncRtpTimestamp =
    (Number(rtpTimestamp >>> 0) - audio.latencySamples) >>> 0;
  if (hasPtpTimeline) {
    // Native PTP announces carry the current RTP position first, followed by
    // the PTP wall-clock timestamp, then the rendering position (current RTP
    // minus the negotiated lead) and the sender's PTP clock identity. Keeping
    // these two RTP fields reversed makes Apple TV accept the session while
    // never releasing the encrypted audio frames for playback.
    packet.writeUInt32BE(Number(rtpTimestamp >>> 0), 4);
    packet.writeBigUInt64BE(
      airPlayPtpNanoseconds(syncTimestamp),
      8,
    );
    packet.writeUInt32BE(syncRtpTimestamp, 16);
    packet.writeBigUInt64BE(audio.timelineID, 20);
  } else {
    // Legacy NTP announces use the rendering position first and the current
    // RTP position in the final word.
    packet.writeUInt32BE(syncRtpTimestamp, 4);
    packet.writeBigUInt64BE(syncTimestamp, 8);
    packet.writeUInt32BE(Number(rtpTimestamp >>> 0), 16);
  }

  try {
    audio.controlSocket.send(
      packet,
      audio.remoteControlPort,
      audio.remoteAddress,
    );
    audio.lastSyncAt = now;
    audio.syncPackets = (audio.syncPackets || 0) + 1;
    audio.syncSequence = (audio.syncSequence + 1) & 0xffff;
    return true;
  } catch (error) {
    console.error("[AirSpan] Could not send AirPlay audio sync:", error);
    return false;
  }
}

function sendAirPlayAudioPacket(controlChannel, pcm, captureTimestampUs) {
  const audio = controlChannel?.audioSetup;
  const video = controlChannel?.video;

  if (
    !audio?.dataSocket ||
    !audio.remoteDataPort ||
    !video?.codecSent
  ) {
    return false;
  }

  const alac = encodeAirPlayAlacVerbatimFrame(pcm);
  const packetRtpTimestamp = audio.rtpTimestamp >>> 0;
  const now = Date.now();
  // Stopping screen capture does not necessarily tear down the RTSP session.
  // When capture resumes, the receiver needs a new RTP-to-clock mapping even
  // though the negotiated audio sockets and sequence counters are unchanged.
  const resumedAfterPause =
    Number.isFinite(audio.lastPacketAt) &&
    audio.lastPacketAt > 0 &&
    now - audio.lastPacketAt > 750;

  const header = Buffer.alloc(12);
  header[0] = 0x80;
  // The first packet after RECORD/SETUP, and the first packet after a capture
  // pause, carries the RTP marker bit so the receiver opens a new boundary.
  header[1] =
    audio.packetsSent === 0 || resumedAfterPause
      ? 0xe0
      : 0x60;
  header.writeUInt16BE(audio.sequence & 0xffff, 2);
  header.writeUInt32BE(packetRtpTimestamp, 4);
  // PTP receivers key the stream by their negotiated timeline and use a zero
  // SSRC. The LG/webOS compatibility path uses the NTP stream identifier even
  // though the enclosing video session remains PTP; leaving this field at zero
  // makes those receivers discard audio after accepting SETUP.
  const hasPtpTimeline =
    audio.timingProtocol !== "NTP" &&
    Boolean(
      controlChannel?.mediaClock?.timelineID,
    );
  const audioSsrc = hasPtpTimeline
    ? 0
    : Number(
        BigInt.asUintN(
          32,
          BigInt(
            audio.streamConnectionID ||
              0,
          ),
        ),
      );
  header.writeUInt32BE(audioSsrc >>> 0, 8);

  const nonce = Buffer.alloc(12);
  // AirPlay's 8-byte trailer is nonce[4..11], with the RTP sequence in the
  // first two bytes (little-endian) and the remaining six bytes zero.
  nonce.writeUInt16LE(audio.sequence & 0xffff, 4);
  const aad = header.subarray(4, 12);
  const cipher = chacha20poly1305(audio.audioKey, nonce, aad);
  const encrypted = Buffer.from(cipher.encrypt(alac));
  const packet = Buffer.concat([
    header,
    encrypted,
    nonce.subarray(4),
  ]);

  try {
    if (audio.packetsSent === 0 || resumedAfterPause) {
      // The receiver needs the RTP-to-PTP mapping before it will release the
      // first encrypted audio frame, and again after a stop/start gap.
      if (resumedAfterPause) {
        airPlayDiagnostic("audio-resume-sync", {
          gapMs: now - audio.lastPacketAt,
          sequence: audio.sequence,
          rtpTimestamp: packetRtpTimestamp,
          timingProtocol: audio.timingProtocol || "PTP",
        });
      }
      const startSyncSent = sendAirPlayAudioSync(
        controlChannel,
        audio,
        packetRtpTimestamp,
        true,
        true,
      );
      if (startSyncSent && audio.packetsSent === 0) {
        airPlayDiagnostic("audio-time-announce", {
          timingProtocol: audio.timingProtocol || "PTP",
          rtpTimestamp: packetRtpTimestamp,
          initial: true,
          source: "first-audio-packet",
        });
      }
    }

    audio.dataSocket.send(
      packet,
      audio.remoteDataPort,
      audio.remoteAddress,
    );

    audio.history.set(audio.sequence & 0xffff, packet);
    while (audio.history.size > 512) {
      audio.history.delete(audio.history.keys().next().value);
    }

    audio.packetsSent += 1;
    audio.payloadBytes += alac.length;
    audio.sequence = (audio.sequence + 1) & 0xffff;
    audio.lastPacketAt = now;
    audio.rtpTimestamp = (packetRtpTimestamp + AIRPLAY_AUDIO_SAMPLES_PER_FRAME) >>> 0;
    sendAirPlayAudioSync(
      controlChannel,
      audio,
      audio.rtpTimestamp,
      false,
    );

    if (audio.packetsSent === 1 || audio.packetsSent % 500 === 0) {
      const pcmBytes = Buffer.from(pcm);
      let peak = 0;
      let sumSquares = 0;
      let sampleCount = 0;

      for (
        let offset = 0;
        offset + 1 < pcmBytes.length;
        offset += 2
      ) {
        const sample =
          pcmBytes.readInt16LE(offset);
        const magnitude =
          Math.abs(sample);
        peak = Math.max(
          peak,
          magnitude,
        );
        sumSquares +=
          sample * sample;
        sampleCount += 1;
      }

      const rms =
        sampleCount
          ? Math.sqrt(
              sumSquares /
                sampleCount,
            )
          : 0;

      airPlayDiagnostic("audio-packet", {
        packetsSent: audio.packetsSent,
        payloadBytes: audio.payloadBytes,
        sequence: audio.sequence,
        rtpTimestamp: audio.rtpTimestamp,
        ssrc: audioSsrc,
        ptpTimeline: hasPtpTimeline,
        captureTimestampUs: Number(captureTimestampUs) || null,
        pcmPeak: peak,
        pcmRms: Math.round(rms),
      });
    }
    return true;
  } catch (error) {
    console.error("[AirSpan] Could not send AirPlay audio packet:", error);
    return false;
  }
}

async function setupAirPlaySilentScreenAudio(
  device,
  controlChannel,
  controlSetup,
  sharedSecret,
) {
  const localAddress =
    controlChannel.socket
      .localAddress;

  if (!localAddress) {
    throw new Error(
      "AirPlay control channel has no local address.",
    );
  }

  const controlSocket =
    dgram.createSocket(
      "udp4",
    );

  const dataSocket =
    dgram.createSocket(
      "udp4",
    );

  await new Promise(
    (resolve, reject) => {
      let pending = 2;
      let settled = false;

      function cleanup() {
        controlSocket.removeListener(
          "error",
          onError,
        );
        dataSocket.removeListener(
          "error",
          onError,
        );
      }

      function onError(error) {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        try {
          controlSocket.close();
        } catch {}
        try {
          dataSocket.close();
        } catch {}
        reject(error);
      }

      function onBound() {
        pending -= 1;
        if (!pending || settled) {
          settled = true;
          cleanup();
          resolve();
        }
      }

      controlSocket.once(
        "error",
        onError,
      );

      dataSocket.once(
        "error",
        onError,
      );

      controlSocket.bind(
        {
          address:
            localAddress,

          port:
            0,
        },

        onBound,
      );

      dataSocket.bind(
        {
          address:
            localAddress,

          port:
            0,
        },

        onBound,
      );
    },
  );

  const socketAddress =
    controlSocket.address();

  const controlPort =
    typeof socketAddress ===
    "object"
      ? socketAddress.port
      : 0;

  const dataSocketAddress =
    dataSocket.address();

  const dataPort =
    typeof dataSocketAddress ===
    "object"
      ? dataSocketAddress.port
      : 0;

  if (!controlPort || !dataPort) {
    controlSocket.close();
    dataSocket.close();

    throw new Error(
      "Could not allocate AirPlay screen-audio UDP ports.",
    );
  }

  const streamConnectionID =
    Number(
      controlSetup
        .streamConnectionID,
    );

  if (
    !Number.isSafeInteger(
      streamConnectionID,
    )
  ) {
    controlSocket.close();
    dataSocket.close();

    throw new Error(
      "AirPlay control streamConnectionID is not a safe integer.",
    );
  }

  // AirPlay derives the realtime audio key directly from the pairing secret;
  // it is not a per-session random key.  Pair-verify produces 32 bytes, while
  // transient pairing can produce 64, so only the first 32 are sent/used.
  const audioKey =
    Buffer.from(sharedSecret || []).subarray(0, 32);

  if (audioKey.length !== 32) {
    controlSocket.close();
    dataSocket.close();

    throw new Error(
      "AirPlay audio setup is missing the 32-byte pairing secret.",
    );
  }

  // Keep the realtime screen-audio lead shallow so audio follows the live
  // display closely. The receiver can still add its own output/HDMI delay.
  const latencyMinSamples =
    Math.floor(
      AIRPLAY_AUDIO_SAMPLE_RATE *
        AIRPLAY_AUDIO_LATENCY_MS /
        1000,
    );
  const latencyMaxSamples =
    AIRPLAY_AUDIO_SAMPLE_RATE * 2;
  const latencySamples =
    latencyMinSamples;

  const stream = {
    type:
      96,

    streamConnectionID,

    // ALAC.
    ct:
      2,

    spf:
      AIRPLAY_AUDIO_SAMPLES_PER_FRAME,

    sr:
      AIRPLAY_AUDIO_SAMPLE_RATE,

    audioFormat:
      0x40000,

    audioMode:
      "default",

    usingScreen:
      true,

    latencyMin:
      latencyMinSamples,

    latencyMax:
      latencyMaxSamples,

    // Sender-side RTP/RTCP ports are advertised so the receiver can associate
    // the negotiated type-96 stream with these sockets.
    controlPort,

    shk:
      audioKey,

    isMedia:
      true,

    supportsDynamicStreamID:
      false,

    dataPort,
  };

  const body =
    Buffer.from(
      buildBinary({
        streams: [
          stream,
        ],
      }),
    );

  console.log(
    "[AirSpan] Sending silent screen-audio SETUP:",
    {
      uri:
        controlSetup.uri,

      streamConnectionID,

      controlPort,

      latencyMinSamples,
      latencyMaxSamples,

      keyBytes:
        audioKey.length,

      bodyBytes:
        body.length,
    },
  );

  const response =
    await sendEncryptedAirPlayRtspRequest(
      controlChannel,
      "SETUP",
      controlSetup.uri,
      body,
      "application/x-apple-binary-plist",
    );

  let parsed = {};

  if (response.body.length) {
    const result =
      parseBinaryPlist(
        response.body,
      );

    parsed =
      Array.isArray(result)
        ? result[0] || {}
        : result || {};
  }

  console.log(
    "[AirSpan] Silent screen-audio SETUP response:",
    {
      statusCode:
        response.statusCode,

      bytes:
        response.body.length,

      keys:
        Object.keys(parsed),

      streams:
        parsed.streams,

      remoteDataPort:
        Array.isArray(parsed.streams)
          ? parsed.streams.find((item) => Number(item?.type) === 96)?.dataPort
          : null,

      remoteControlPort:
        Array.isArray(parsed.streams)
          ? parsed.streams.find((item) => Number(item?.type) === 96)?.controlPort
          : null,
    },
  );

  const streams =
    Array.isArray(parsed.streams)
      ? parsed.streams
      : [];

  const audioStream =
    streams.find(
      (item) => Number(item?.type) === 96,
    );

  const remoteDataPort =
    Number(audioStream?.dataPort || 0);

  const remoteControlPort =
    Number(
      audioStream?.controlPort ||
        audioStream?.dataPort ||
        0,
    );

  if (
    response.statusCode !==
    200
  ) {
    controlSocket.close();
    dataSocket.close();

    throw new Error(
      `AirPlay screen-audio SETUP returned ${response.statusCode}.`,
    );
  }

  if (!remoteDataPort) {
    controlSocket.close();
    dataSocket.close();
    console.warn(
      "[AirSpan] AirPlay screen-audio SETUP omitted the type-96 data port; continuing without audio.",
      { remoteDataPort, remoteControlPort },
    );
    return {
      response,
      parsed,
      enabled: false,
    };
  }

  const remoteAddress =
    getAirPlayNetworkAddress(
      device,
    );

  // Some LG/webOS receivers only release type-96 audio when it is identified
  // using the legacy NTP RTP mapping. The session still has a live PTP clock
  // for the screen/video timeline; this choice only changes the audio RTP
  // mapping so Apple TV and other native receivers retain PTP audio.
  const audioTimingProtocol =
    airPlayDevicePrefersNtp(device)
      ? "NTP"
      : controlChannel.session?.timingProtocol ||
        (controlChannel.mediaClock?.timelineID
          ? "PTP"
          : "NTP");

  controlSocket.on(
    "error",
    (error) => {
      console.error(
        "[AirSpan] AirPlay audio control socket error:",
        error,
      );
    },
  );

  dataSocket.on(
    "error",
    (error) => {
      console.error(
        "[AirSpan] AirPlay audio data socket error:",
        error,
      );
    },
  );

  // Keep this socket alive for the
  // lifetime of the AirPlay session.
  controlChannel.audioControlSocket =
    controlSocket;

  controlChannel.audioDataSocket =
    dataSocket;

  const audioSetup = {
    streamConnectionID,
    controlPort,
    dataPort,
    remoteDataPort,
    remoteControlPort,
    remoteAddress,
    audioKey,
    latencySamples,
    timingProtocol: audioTimingProtocol,
    timelineID:
      audioTimingProtocol === "PTP"
        ? controlChannel.mediaClock?.timelineID || 0n
        : 0n,
    sequence:
      Number.isInteger(
        controlChannel.audioInitialSequence,
      )
        ? controlChannel.audioInitialSequence
        : 0,
    syncSequence: 1,
    rtpTimestamp:
      Number.isInteger(
        controlChannel.audioInitialRtpTimestamp,
      )
        ? controlChannel.audioInitialRtpTimestamp
        : 0,
    history: new Map(),
    lastSyncAt: 0,
    lastPacketAt: 0,
    syncPackets: 0,
    packetsSent: 0,
    payloadBytes: 0,
    controlSocket,
    dataSocket,
    response: parsed,
  };

  // Keep one shared setup object. The packet sender, pre-audio announce timer,
  // and teardown path all update/read this state; cloning it here leaves the
  // timer running against a stale socket after the first packet or disconnect.
  controlChannel.audioSetup = audioSetup;

  controlSocket.on(
    "message",
    (packet) => {
      // Receivers use 0xd5 control packets to request retransmission of
      // one or more RTP sequence numbers. Reply with the original packet.
      if (packet.length < 4 || packet[1] !== 0xd5) {
        return;
      }

      // The common layout is an 8-byte RTP-like header followed by the
      // first-missing sequence and count. A few older receivers put those
      // fields immediately after the 4-byte header, so accept both forms.
      let requestedOffset = 2;
      if (packet.length >= 12) {
        requestedOffset = 8;
      } else if (packet.length >= 8) {
        requestedOffset = 4;
      }
      const requested = packet.readUInt16BE(requestedOffset);
      const countOffset = requestedOffset + 2;
      const count =
        packet.length >= countOffset + 2
          ? Math.max(1, packet.readUInt16BE(countOffset))
          : 1;

      for (let index = 0; index < count; index += 1) {
        const sequence = (requested + index) & 0xffff;
        const resent = audioSetup.history.get(sequence);
        if (!resent) {
          continue;
        }

        const responsePacket = Buffer.alloc(
          8 + resent.length,
        );
        responsePacket[0] = 0x80;
        responsePacket[1] = 0xd6;
        responsePacket.writeUInt16BE(4, 2);
        responsePacket.writeUInt32BE(0, 4);
        resent.copy(responsePacket, 8);
        try {
          controlSocket.send(
            responsePacket,
            remoteControlPort,
            remoteAddress,
          );
        } catch (error) {
          console.warn(
            "[AirSpan] Could not retransmit AirPlay audio packet:",
            error,
          );
        }
      }
    },
  );

  // The timeline can be updated by an EVENT after SETUP. Keep the audio
  // sync packet on the current clock whenever the first frame is sent.
  airPlayDiagnostic(
    "audio-setup-ready",
    {
      streamConnectionID,
      localControlPort: controlPort,
      localDataPort: dataPort,
      remoteDataPort,
      remoteControlPort,
      latencyMs:
        AIRPLAY_AUDIO_LATENCY_MS,
      latencySamples,
      initialSequence:
        audioSetup.sequence,
      initialRtpTimestamp:
        audioSetup.rtpTimestamp,
      ptpTimeline:
        Boolean(audioSetup.timelineID),
      timingProtocol:
        audioTimingProtocol,
    },
  );

  return {
    response,
    parsed,
    enabled: true,
    audioSetup,
  };
}
function createAirPlayVideoStreamId() {
  // 48 bits keeps the value safely inside
  // JavaScript's exact integer range.
  const hex =
    randomUUID()
      .replace(/-/g, "")
      .slice(0, 12);

  return Number.parseInt(
    hex,
    16,
  );
}


async function setupAirPlayVideoStream(
  device,
  controlChannel,
  sharedSecret,
) {
  const streamConnectionID =
    createAirPlayVideoStreamId();

  const address =
    getAirPlayNetworkAddress(
      device,
    );

  const uri =
    `rtsp://${address}:${device.port || 7000}/${streamConnectionID}`;

  // On an encrypted HAP connection,
  // AirPlay's stream descriptor retains
  // the first 16 bytes of the control keys.
  const streamKey =
    Buffer.from(
      controlChannel.writeKey
        .subarray(0, 16),
    );

  const streamIV =
    Buffer.from(
      controlChannel.readKey
        .subarray(0, 16),
    );

  const stream = {
  type:
    110,

  streamConnectionID,

  latencyMs:
    75,

  timestampInfo: [
      { name: "SubSu" },
      { name: "BePxT" },
      { name: "AfPxT" },
      { name: "BefEn" },
      { name: "EmEnc" },
    ],

    shk:
      streamKey,

    shiv:
      streamIV,
  };

  const payload = {
    streams: [
      stream,
    ],
  };

  const body =
    Buffer.from(
      buildBinary(payload),
    );

  console.log(
    "[AirSpan] Sending AirPlay VIDEO SETUP:",
    {
      device:
        device.name,

      uri,

      type:
        stream.type,

      streamConnectionID,

      shkBytes:
        streamKey.length,

      shivBytes:
        streamIV.length,

      bodyBytes:
        body.length,

      writeCounter:
        controlChannel.writeCounter,

      readCounter:
        controlChannel.readCounter,
    },
  );

  const response =
    await sendEncryptedAirPlayRtspRequest(
      controlChannel,
      "SETUP",
      uri,
      body,
      "application/x-apple-binary-plist",
    );

  let parsed = {};

  if (response.body.length) {
    const result =
      parseBinaryPlist(
        response.body,
      );

    parsed =
      Array.isArray(result)
        ? result[0] || {}
        : result || {};
  }

  const streams =
    Array.isArray(parsed.streams)
      ? parsed.streams
      : [];

  const videoStream =
    streams.find(
      (item) =>
        Number(item?.type) === 110,
    );

  const dataPort =
    Number(
      videoStream?.dataPort || 0,
    );

  console.log(
    "[AirSpan] AirPlay VIDEO SETUP response:",
    {
      statusCode:
        response.statusCode,

      bytes:
        response.body.length,

      keys:
        Object.keys(parsed),

      streams,

      dataPort,

      writeCounter:
        controlChannel.writeCounter,

      readCounter:
        controlChannel.readCounter,
    },
  );

  if (
    response.statusCode !== 200
  ) {
    throw new Error(
      `AirPlay video SETUP returned ${response.statusCode}.`,
    );
  }

  if (!dataPort) {
    throw new Error(
      "AirPlay video SETUP did not return a type-110 dataPort.",
    );
  }

  // The actual screen-data encryption key.
  //
  // Sender -> receiver uses:
  // HKDF-SHA512(
  //   Pair-Verify shared secret,
  //   "DataStream-Salt<stream ID>",
  //   "DataStream-Output-Encryption-Key"
  // )
  const videoDataKey =
    hapHkdf(
      `DataStream-Salt${streamConnectionID}`,
      "DataStream-Output-Encryption-Key",
      sharedSecret,
    );

  console.log(
    "[AirSpan] AirPlay video encryption ready:",
    {
      streamConnectionID,

      keyBytes:
        videoDataKey.length,

      dataPort,
    },
  );

  return {
    uri,
    streamConnectionID,
    dataPort,
    videoDataKey,
    response:
      parsed,
  };
}
async function connectAirPlayVideoDataChannel(
  device,
  videoSetup,
) {
  const address =
    getAirPlayNetworkAddress(
      device,
    );

  return new Promise(
    (resolve, reject) => {
      const socket =
        net.createConnection({
          host:
            address,

          port:
            videoSetup.dataPort,
        });

      const timer =
        setTimeout(() => {
          socket.destroy();

          reject(
            new Error(
              "AirPlay video data connection timed out.",
            ),
          );
        }, 5000);

      function startupError(error) {
        clearTimeout(timer);
        reject(error);
      }

      socket.once(
        "error",
        startupError,
      );

      socket.once(
        "connect",
        () => {
          clearTimeout(timer);

          socket.removeListener(
            "error",
            startupError,
          );

          socket.setNoDelay(true);

          console.log(
            "[AirSpan] AirPlay VIDEO data channel connected:",
            {
              address,

              port:
                videoSetup.dataPort,

              streamConnectionID:
                videoSetup
                  .streamConnectionID,

              localAddress:
                socket.localAddress,

              localPort:
                socket.localPort,
            },
          );
socket.on(
  "data",
  (chunk) => {
    const data =
      Buffer.from(chunk);

    console.log(
      "[AirSpan] AirPlay VIDEO data received:",
      {
        bytes:
          data.length,

        hex:
          data
            .subarray(
              0,
              Math.min(
                data.length,
                128,
              ),
            )
            .toString(
              "hex",
            ),
      },
    );
  },
);
          socket.on(
            "error",
            (error) => {
              console.error(
                "[AirSpan] AirPlay VIDEO data socket error:",
                error,
              );
            },
          );

          socket.on(
            "close",
            () => {
              console.log(
                "[AirSpan] AirPlay VIDEO data channel closed.",
              );
            },
          );

          resolve(socket);
        },
      );
    },
  );
}
function airPlayUint64(value) {
  try {
    const input =
      typeof value === "bigint"
        ? value
        : BigInt(value);

    return BigInt.asUintN(
      64,
      input,
    );
  } catch {
    return 0n;
  }
}


function compactAirPlayMilliseconds(
  value,
) {
  const milliseconds =
    Math.max(
      0,
      Math.floor(value),
    );

  const seconds =
    BigInt(
      Math.floor(
        milliseconds / 1000,
      ),
    );

  const remainder =
    BigInt(
      milliseconds % 1000,
    );

  return (
    (seconds << 32n) |
    ((remainder << 32n) /
      1000n)
  );
}


function initializeAirPlayMediaClock(
  channel,
  controlSetup,
) {
  const headers =
    controlSetup.response
      ?.headers || {};

  const received =
    Number(
      headers[
        "x-apple-requestreceivedtimestamp"
      ],
    );

  const processing =
    Number(
      headers[
        "x-apple-processingtime"
      ] || 0,
    );

  const receiverClockID =
    airPlayUint64(
      controlSetup.parsed
        ?.timingPeerInfo
        ?.ClockID || 0,
    );

  const senderClockID =
    airPlayUint64(
      controlSetup.senderClockID || 0,
    );

  const useNtpTiming =
    controlSetup.timingProtocol ===
      "NTP" &&
    !controlSetup.ptpTiming?.enabled;

  // With a live native PTP transport, AirSpan is the timing master and the
  // media timeline must use the same clock identity carried by our gPTP
  // packets. Retain the receiver-clock behavior only when the OS refused the
  // PTP ports and the existing fallback is the only available path.
  const useSenderClock =
    Boolean(
      controlSetup.ptpTiming?.enabled &&
      senderClockID,
    );

  const clockID =
    useNtpTiming
      ? 0n
      : useSenderClock
      ? senderClockID
      : receiverClockID;

  const hasReceiverTimestamp =
    Number.isFinite(received);

  if (!hasReceiverTimestamp) {
    console.warn(
      "[AirSpan] Receiver omitted its media timestamp; starting AirSpan's local media clock.",
    );
  }

  const anchorMilliseconds =
    hasReceiverTimestamp
      ? received + processing
      : useNtpTiming
        ? Date.now() +
          AIRPLAY_NTP_EPOCH_OFFSET_MS
        : Date.now();

  channel.mediaClock = {
    anchorLocalMs:
      performance.now(),

    anchorTimestamp:
      compactAirPlayMilliseconds(
        anchorMilliseconds,
      ),

    timelineID:
      clockID,
  };

  if (useSenderClock) {
    controlSetup.ptpTiming.setClock(
      channel.mediaClock,
    );
  }

  console.log(
    "[AirSpan] AirPlay media clock ready:",
    {
      received,
      processing,

      anchorSource:
        hasReceiverTimestamp
          ? "receiver"
          : useNtpTiming
            ? "local-ntp-wall-clock"
            : "local-wall-clock",

      timingProtocol:
        controlSetup.timingProtocol ||
        (useNtpTiming ? "NTP" : "PTP"),

      timelineID:
        `0x${clockID
          .toString(16)
          .toUpperCase()}`,
    },
  );

  airPlayDiagnostic(
    "ptp-clock-ready",
    {
      received,
      processing,
      anchorSource:
        hasReceiverTimestamp
          ? "receiver"
          : useNtpTiming
            ? "local-ntp-wall-clock"
            : "local-wall-clock",
      timingProtocol:
        controlSetup.timingProtocol ||
        (useNtpTiming ? "NTP" : "PTP"),
      rawClockIDType:
        typeof controlSetup.parsed
          ?.timingPeerInfo
          ?.ClockID,
      receiverClockID:
        receiverClockID.toString(),
      senderClockID:
        senderClockID.toString(),
      senderClockActive:
        useSenderClock,
      timelineID:
        clockID.toString(),
    },
  );
}
function updateAirPlayMediaClockFromHeaders(
  channel,
  headers,
) {
  const clock =
    channel.mediaClock;

  if (!clock) {
    return;
  }

  const received =
    Number(
      headers?.[
        "x-apple-requestreceivedtimestamp"
      ],
    );

  const processing =
    Number(
      headers?.[
        "x-apple-processingtime"
      ] || 0,
    );

  if (
    !Number.isFinite(
      received,
    )
  ) {
    return;
  }

  const now =
    performance.now();

  let timestamp =
    compactAirPlayMilliseconds(
      received + processing,
    );

  if (
    Number.isFinite(
      clock.anchorLocalMs,
    )
  ) {
    const elapsed =
      Math.max(
        0,
        now -
          clock.anchorLocalMs,
      );

    const projected =
      clock.anchorTimestamp +
      compactAirPlayMilliseconds(
        elapsed,
      );

    // Feedback timestamps describe an
    // earlier point at the receiver.
    // Never move the active media clock
    // backwards.
    if (
      timestamp <
      projected
    ) {
      timestamp =
        projected;
    }
  }

  clock.anchorLocalMs =
    now;

  clock.anchorTimestamp =
    timestamp;
}

function updateAirPlayMediaClockFromEvent(
  channel,
  eventBody,
) {
  if (
    !channel?.mediaClock ||
    eventBody?.type !==
      "updateTimingPeerInfo"
  ) {
    return;
  }

  // Native PTP sessions are anchored to AirSpan's advertised grandmaster.
  // A receiver may still emit updateTimingPeerInfo for its own clock; do not
  // replace the active sender timeline with that ID mid-stream.
  if (
    channel.session?.ptpTiming?.enabled ||
    channel.session?.timingProtocol ===
      "NTP"
  ) {
    return;
  }

  const timelineID =
    airPlayUint64(
      eventBody.value?.ClockID,
    );

  if (!timelineID) {
    console.warn(
      "[AirSpan] updateTimingPeerInfo omitted ClockID.",
    );
    return;
  }

  const clock =
    channel.mediaClock;

  const now =
    performance.now();

  if (
    Number.isFinite(
      clock.anchorLocalMs,
    )
  ) {
    clock.anchorTimestamp +=
      compactAirPlayMilliseconds(
        Math.max(
          0,
          now -
            clock.anchorLocalMs,
        ),
      );
  }

  const previousTimelineID =
    clock.timelineID;

  clock.anchorLocalMs = now;
  clock.timelineID = timelineID;

  console.log(
    "[AirSpan] AirPlay PTP timeline updated:",
    {
      previousTimelineID:
        `0x${previousTimelineID
          .toString(16)
          .toUpperCase()}`,

      timelineID:
        `0x${timelineID
          .toString(16)
          .toUpperCase()}`,
    },
  );

  airPlayDiagnostic(
    "ptp-timeline-updated",
    {
      previousTimelineID:
        previousTimelineID.toString(),
      timelineID:
        timelineID.toString(),
    },
  );
}
function getAirPlayMediaTimestamp(
  channel,
  biasMs = 100,
) {
  const clock =
    channel.mediaClock;

  if (!clock) {
    return {
      timestamp:
        compactAirPlayMilliseconds(
          performance.now() +
            biasMs,
        ),

      timelineID:
        0n,
    };
  }

  const elapsed =
    Math.max(
      0,
      performance.now() -
        clock.anchorLocalMs +
        biasMs,
    );

  return {
    timestamp:
      clock.anchorTimestamp +
      compactAirPlayMilliseconds(
        elapsed,
      ),

    timelineID:
      clock.timelineID,
  };
}
function getAirPlayMediaTimestampForCapture(
  channel,
  captureTimestampUs,
  biasMs = 75,
) {
  const captureWallClockMs =
    Number(
      captureTimestampUs,
    ) / 1000;

  if (
    !Number.isFinite(
      captureWallClockMs,
    )
  ) {
    return {
      ...getAirPlayMediaTimestamp(
        channel,
        biasMs,
      ),

      captureAgeMs:
        null,
    };
  }

  const captureAgeMs =
    Math.max(
      0,
      Date.now() -
        captureWallClockMs,
    );

  const clock =
    getAirPlayMediaTimestamp(
      channel,
      0,
    );

  let timestamp =
    clock.timestamp;

  const adjustmentMs =
    biasMs -
    captureAgeMs;

  if (
    adjustmentMs >= 0
  ) {
    timestamp +=
      compactAirPlayMilliseconds(
        adjustmentMs,
      );
  } else {
    const subtraction =
      compactAirPlayMilliseconds(
        -adjustmentMs,
      );

    timestamp =
      timestamp >
      subtraction
        ? timestamp -
          subtraction
        : 0n;
  }

  const video =
    channel.video;

  const lastTimestamp =
    video?.lastFrameTimestamp ||
    0n;

  if (
    timestamp <=
    lastTimestamp
  ) {
    timestamp =
      lastTimestamp + 1n;
  }

  if (video) {
    video.lastFrameTimestamp =
      timestamp;
  }

  return {
    timestamp,

    timelineID:
      clock.timelineID,

    captureAgeMs,
  };
}

function buildAirPlayAvcC(
  input,
) {
  const data =
    Buffer.from(input);

  if (
    data.length < 8 ||
    data[0] !== 1
  ) {
    throw new Error(
      "Invalid H.264 AVCDecoderConfigurationRecord.",
    );
  }

  let offset = 6;

  const spsCount =
    data[5] & 0x1f;

  let sps = null;

  for (
    let index = 0;
    index < spsCount;
    index += 1
  ) {
    if (
      offset + 2 >
      data.length
    ) {
      throw new Error(
        "Invalid H.264 SPS table.",
      );
    }

    const length =
      data.readUInt16BE(
        offset,
      );

    offset += 2;

    if (
      offset + length >
      data.length
    ) {
      throw new Error(
        "Invalid H.264 SPS length.",
      );
    }

    if (!sps) {
      sps =
        Buffer.from(
          data.subarray(
            offset,
            offset + length,
          ),
        );
    }

    offset += length;
  }

  if (
    offset >= data.length
  ) {
    throw new Error(
      "H.264 configuration has no PPS table.",
    );
  }

  const ppsCount =
    data[offset];

  offset += 1;

  let pps = null;

  for (
    let index = 0;
    index < ppsCount;
    index += 1
  ) {
    if (
      offset + 2 >
      data.length
    ) {
      throw new Error(
        "Invalid H.264 PPS table.",
      );
    }

    const length =
      data.readUInt16BE(
        offset,
      );

    offset += 2;

    if (
      offset + length >
      data.length
    ) {
      throw new Error(
        "Invalid H.264 PPS length.",
      );
    }

    if (!pps) {
      pps =
        Buffer.from(
          data.subarray(
            offset,
            offset + length,
          ),
        );
    }

    offset += length;
  }

  if (
    !sps ||
    sps.length < 4 ||
    !pps
  ) {
    throw new Error(
      "H.264 configuration did not contain SPS/PPS.",
    );
  }

  const spsLength =
    Buffer.alloc(2);

  spsLength.writeUInt16BE(
    sps.length,
  );

  const ppsLength =
    Buffer.alloc(2);

  ppsLength.writeUInt16BE(
    pps.length,
  );

  return Buffer.concat([
    Buffer.from([
      0x01,
      sps[1],
      sps[2],
      sps[3],
      0xff,
      0xe1,
    ]),

    spsLength,
    sps,

    Buffer.from([
      0x01,
    ]),

    ppsLength,
    pps,

    // Trailer observed in
    // real AirPlay H.264 senders.
    Buffer.from([
      0x02,
      0x00,
      0x00,
      0x00,
    ]),
  ]);
}


function getActiveAirPlayVideoChannel() {
  const channel =
    pendingAirPlayPairing
      ?.controlChannel;

  const socket =
    channel
      ?.video
      ?.socket;

  if (
    !channel ||
    !socket ||
    socket.destroyed
  ) {
    return null;
  }

  return channel;
}

function closeAirPlayChannel(
  channel,
  intentional = true,
) {
  if (!channel) {
    return;
  }

  if (intentional) {
    channel.airspanIntentionalClose =
      true;
  }

  try {
    channel.stopFeedback?.();
  } catch {}

  try {
    channel.session?.ntpTiming?.stop?.();
    channel.ntpTiming?.stop?.();
    (channel.session?.ptpTiming || channel.ptpTiming)?.stop?.();
  } catch {}

  for (const timer of [
    channel.video?.heartbeatTimer,
    channel.video?.statsTimer,
  ]) {
    if (timer) {
      clearInterval(timer);
      clearTimeout(timer);
    }
  }

  // Mark the audio setup before closing its UDP sockets. A timer callback can
  // already be queued when close() runs, and dgram reports that short race as
  // ERR_SOCKET_DGRAM_NOT_RUNNING unless sendAirPlayAudioSync sees this flag.
  if (channel.audioSetup) {
    channel.audioSetup.closed = true;
  }

  for (const socket of [
    channel.audioControlSocket,
    channel.audioDataSocket,
    channel.audioSetup?.controlSocket,
    channel.audioSetup?.dataSocket,
  ]) {
    try {
      socket?.close?.();
      socket?.destroy?.();
    } catch {}
  }

  for (const socket of [
    channel.eventChannel?.socket,
    channel.video?.socket,
    channel.socket,
  ]) {
    try {
      socket?.destroy?.();
      socket?.close?.();
    } catch {}
  }

  try {
    channel.agent?.destroy?.();
  } catch {}
}

function reportAirPlayConnectionLost(
  device,
  channel,
  reason,
) {
  if (
    !channel ||
    channel.airspanIntentionalClose ||
    channel.connectionLossReported
  ) {
    return;
  }

  channel.connectionLossReported =
    true;
  const activeDevice =
    device ||
    channel.airspanDevice ||
    lastAirPlayDevice;

  if (
    pendingAirPlayPairing
      ?.controlChannel === channel
  ) {
    pendingAirPlayPairing
      ?.agent
      ?.destroy?.();
    pendingAirPlayPairing = null;
    pendingAirPlayDevice = null;
  }

  if (activeDevice) {
    lastAirPlayDevice =
      activeDevice;
  }

  closeAirPlayChannel(
    channel,
    false,
  );

  const name =
    activeDevice?.name ||
    "The AirPlay receiver";
  const message =
    `${name} went offline. Reconnect when it is available.`;

  console.warn(
    "[AirSpan] AirPlay connection lost:",
    {
      device: name,
      reason:
        String(reason?.message || reason || "Connection closed"),
    },
  );
  setAirPlayConnectionState({
    status: "offline",
    deviceId:
      activeDevice?.id || null,
    name,
    message,
    connected: false,
    canReconnect: true,
  });
}

function monitorAirPlayConnection(
  device,
  channel,
) {
  channel.airspanDevice =
    device;

  if (
    channel.socket?.destroyed ||
    channel.video?.socket?.destroyed
  ) {
    reportAirPlayConnectionLost(
      device,
      channel,
      "A receiver socket closed during setup",
    );
    return false;
  }

  const reportClosed = () => {
    reportAirPlayConnectionLost(
      device,
      channel,
      "Connection closed",
    );
  };
  const reportError = (error) => {
    reportAirPlayConnectionLost(
      device,
      channel,
      error,
    );
  };

  for (const socket of [
    channel.socket,
    channel.eventChannel?.socket,
    channel.video?.socket,
  ]) {
    socket?.once?.(
      "close",
      reportClosed,
    );
    socket?.once?.(
      "error",
      reportError,
    );
  }

  for (const socket of [
    channel.audioControlSocket,
    channel.audioDataSocket,
    channel.audioSetup?.controlSocket,
    channel.audioSetup?.dataSocket,
  ]) {
    socket?.once?.(
      "error",
      reportError,
    );
  }

  return true;
}

async function disconnectActiveAirPlay(
  {
    notify = true,
    message = "AirPlay disconnected.",
  } = {},
) {
  const pairing =
    pendingAirPlayPairing;
  const channel =
    pairing?.controlChannel;
  const device =
    pairing?.device ||
    pendingAirPlayDevice ||
    lastAirPlayDevice;

  if (device) {
    lastAirPlayDevice = device;
  }

  if (channel) {
    channel.airspanIntentionalClose =
      true;

    if (
      !channel.socket?.destroyed &&
      channel.session?.uri
    ) {
      try {
        await Promise.race([
          sendEncryptedAirPlayRtspRequest(
            channel,
            "TEARDOWN",
            channel.session.uri,
          ),
          new Promise((_, reject) => {
            const timer =
              setTimeout(
                () =>
                  reject(
                    new Error(
                      "AirPlay TEARDOWN timed out.",
                    ),
                  ),
                1500,
              );
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        console.warn(
          "[AirSpan] AirPlay TEARDOWN did not complete:",
          error,
        );
      }
    }

    closeAirPlayChannel(channel);
  }

  pairing?.agent?.destroy?.();
  pendingAirPlayPairing = null;
  pendingAirPlayDevice = null;

  if (notify) {
    setAirPlayConnectionState({
      status: "disconnected",
      deviceId:
        device?.id || null,
      name:
        device?.name || null,
      message,
      connected: false,
      canReconnect:
        Boolean(device),
    });
  }

  return {
    ok: true,
    deviceId:
      device?.id || null,
    name:
      device?.name || null,
  };
}


function sendAirPlayCodecPacket(
  channel,
  description,
  width,
  height,
  captureTimestampUs,
) {
  const video =
    channel.video;

  const payload =
    buildAirPlayAvcC(
      description,
    );

  const header =
    Buffer.alloc(128);

  header.writeUInt32LE(
    payload.length,
    0,
  );

  // Codec configuration packet.
  header[4] = 0x01;
  header[5] = 0x00;

  // H.264 generic format description.
  header[6] = 0x16;
  header[7] = 0x01;

  const clock =
  getAirPlayMediaTimestampForCapture(
    channel,
    captureTimestampUs,
    75,
  );

video.pendingCodecTimestamp =
  clock.timestamp;

video.pendingCodecTimelineID =
  clock.timelineID;

  header.writeBigUInt64LE(
    clock.timestamp,
    8,
  );

  // Encoded size.
  header.writeFloatLE(
    width,
    16,
  );

  header.writeFloatLE(
    height,
    20,
  );

  // Source rectangle.
  header.writeFloatLE(
    width,
    40,
  );

  header.writeFloatLE(
    height,
    44,
  );

  // Destination rectangle.
  header.writeFloatLE(
    width,
    56,
  );

  header.writeFloatLE(
    height,
    60,
  );

  video.width =
    width;

  video.height =
    height;

  video.codecSent =
    true;

  video.socket.write(
    Buffer.concat([
      header,
      payload,
    ]),
  );

  airPlayDiagnostic(
    "video-codec-sent",
    {
      width,
      height,
      sourceBytes:
        Buffer.from(description).length,
      payloadBytes:
        payload.length,
      timestamp:
        clock.timestamp.toString(),
      timelineID:
        clock.timelineID.toString(),
    },
  );

  console.log(
  "[AirSpan] AirPlay H.264 codec packet sent:",
  {
    width,
    height,

    captureTimestampUs,

    captureAgeMs:
  Number.isFinite(
    Number(
      captureTimestampUs,
    ),
  )
    ? Math.max(
        0,
        Date.now() -
          Number(
            captureTimestampUs,
          ) /
            1000,
      )
    : null,

    timestamp:
      clock.timestamp.toString(),

    sourceBytes:
      Buffer.from(
        description,
      ).length,

    airPlayBytes:
      payload.length,
  },
);
}


function startAirPlayVideoHeartbeat(
  channel,
) {
  const video =
    channel.video;

  if (
    video.heartbeatTimer
  ) {
    return;
  }

  video.heartbeatTimer =
    setInterval(
      () => {
        if (
          !video.socket ||
          video.socket.destroyed
        ) {
          clearInterval(
            video.heartbeatTimer,
          );

          video.heartbeatTimer =
            null;

          return;
        }

        const header =
          Buffer.alloc(128);

        header[4] =
          0x02;

        header[6] =
          0x1e;

        video.socket.write(
          header,
        );
      },
      1000,
    );

  video.heartbeatTimer
    .unref?.();
}
function filterAirPlayH264VclPayload(
  input,
) {
  const data =
    Buffer.from(input);

  const output = [];
  const nalTypes = [];

  let offset = 0;
  let hasIdr = false;
  let vclCount = 0;

  while (offset < data.length) {
    if (
      offset + 4 >
      data.length
    ) {
      throw new Error(
        "Truncated AVCC NAL length.",
      );
    }

    const nalLength =
      data.readUInt32BE(
        offset,
      );

    offset += 4;

    if (
      nalLength <= 0 ||
      offset + nalLength >
        data.length
    ) {
      throw new Error(
        `Invalid AVCC NAL length ${nalLength}.`,
      );
    }

    const nal =
      data.subarray(
        offset,
        offset + nalLength,
      );

    offset += nalLength;

    if (!nal.length) {
      continue;
    }

    const nalType =
      nal[0] & 0x1f;

    nalTypes.push(
      nalType,
    );

    // AirPlay video packets should
    // contain only VCL NAL units.
    //
    // 1-4 = non-IDR slices
    // 5   = IDR slice
    if (
      nalType >= 1 &&
      nalType <= 5
    ) {
      const length =
        Buffer.alloc(4);

      length.writeUInt32BE(
        nal.length,
        0,
      );

      output.push(
        length,
        nal,
      );

      vclCount += 1;

      if (nalType === 5) {
        hasIdr = true;
      }
    }
  }

  return {
    payload:
      Buffer.concat(
        output,
      ),

    nalTypes,
    hasIdr,
    vclCount,
  };
}

function sendAirPlayVideoPacket(
  channel,
  data,
  keyFrame,
  captureTimestampUs,
) {
  const video =
    channel.video;

  if (!video.codecSent) {
    video.preCodecDrops =
      (video.preCodecDrops || 0) + 1;
    return;
  }

  if (
    video.socket
      .writableLength >
    2_000_000
  ) {
    video.droppedFrames =
      (video.droppedFrames || 0) +
      1;

    video.backpressureDrops =
      (video.backpressureDrops || 0) +
      1;

    return;
  }

  const parsedFrame =
  filterAirPlayH264VclPayload(
    data,
  );

if (
  !parsedFrame.payload.length
) {
  console.log(
    "[AirSpan] Skipping H.264 chunk with no VCL data:",
    {
      nalTypes:
        parsedFrame.nalTypes,
    },
  );

  return;
}

const plaintext =
  parsedFrame.payload;

const packetKeyFrame =
  parsedFrame.hasIdr;

  const header =
    Buffer.alloc(128);

  // ChaCha20-Poly1305 adds
  // a 16-byte authentication tag.
  header.writeUInt32LE(
    plaintext.length + 16,
    0,
  );

  header[4] =
    0x00;

 header[5] =
  packetKeyFrame
    ? 0x10
    : 0x00;

  let clock;

if (
  video.pendingCodecTimestamp !==
  undefined
) {
  clock = {
    timestamp:
      video.pendingCodecTimestamp,

    timelineID:
      video.pendingCodecTimelineID,
  };

  video.pendingCodecTimestamp =
    undefined;

  video.pendingCodecTimelineID =
    undefined;
} else {
  clock =
  getAirPlayMediaTimestampForCapture(
    channel,
    captureTimestampUs,
    75,
  );
}

const captureAgeMs =
  Number.isFinite(
    Number(
      captureTimestampUs,
    ),
  )
    ? Math.max(
        0,
        Date.now() -
          Number(
            captureTimestampUs,
          ) /
            1000,
      )
    : null;

  header.writeBigUInt64LE(
    clock.timestamp,
    8,
  );

  header.writeBigUInt64LE(
    clock.timelineID,
    40,
  );

  const counter =
  video.nonce || 0n;

const nonce =
  Buffer.alloc(12);

nonce.writeBigUInt64LE(
  counter,
  4,
);

const cipher =
  chacha20poly1305(
    new Uint8Array(
      video.videoDataKey,
    ),

    new Uint8Array(
      nonce,
    ),

    new Uint8Array(
      header,
    ),
  );

const encrypted =
  Buffer.from(
    cipher.encrypt(
      new Uint8Array(
        plaintext,
      ),
    ),
  );

  const writeAccepted =
    video.socket.write(
    Buffer.concat([
      header,
      encrypted,
    ]),
  );

  video.nonce =
    counter + 1n;

  video.frameSeq =
    (video.frameSeq || 0) +
    1;

  video.payloadBytes =
    (video.payloadBytes || 0) +
    plaintext.length;

  video.lastFrameAt =
    Date.now();

  video.lastCaptureTimestamp =
    captureTimestampUs;

  if (
    video.frameSeq <= 10 ||
    video.frameSeq % 300 === 0
  ) {
    airPlayDiagnostic(
      "video-frame-sent",
      {
        frame:
          video.frameSeq,
        keyFrame:
          packetKeyFrame,
        rendererKeyFrame:
          keyFrame,
        nalTypes:
          parsedFrame.nalTypes,
        plaintextBytes:
          plaintext.length,
        encryptedBytes:
          encrypted.length,
        writeAccepted,
        writableLength:
          video.socket.writableLength,
        bytesWritten:
          video.socket.bytesWritten,
        nonce:
          counter.toString(),
        timestamp:
          clock.timestamp.toString(),
        timelineID:
          clock.timelineID.toString(),
        captureAgeMs,
      },
    );
  }

  if (
    video.frameSeq <= 5
  ) {
    console.log(
      "[AirSpan] AirPlay H.264 video packet sent:",
      {
        frame:
          video.frameSeq,

        keyFrame:
  packetKeyFrame,

rendererKeyFrame:
  keyFrame,

nalTypes:
  parsedFrame.nalTypes,

vclCount:
  parsedFrame.vclCount,
        captureAgeMs,

        plaintextBytes:
          plaintext.length,

        encryptedBytes:
          encrypted.length,
          writableLength:
  video.socket
    .writableLength,

bytesWritten:
  video.socket
    .bytesWritten,

        nonce:
          counter.toString(),

        timestamp:
          clock.timestamp.toString(),

        timelineID:
          `0x${clock.timelineID
            .toString(16)
            .toUpperCase()}`,
      },
    );
  }

  if (
    video.frameSeq === 1
  ) {
    startAirPlayVideoHeartbeat(
      channel,
    );
  }
}
 
function startAirPlayFeedbackLoop(
  controlChannel,
) {
  let stopped = false;
  let running = false;

  async function sendFeedback() {
    if (
      stopped ||
      running ||
      controlChannel.socket.destroyed
    ) {
      return;
    }

    running = true;

    try {
      const response =
        await sendEncryptedAirPlayRtspRequest(
          controlChannel,
          "POST",
          "/feedback",
          Buffer.alloc(0),
        );
        updateAirPlayMediaClockFromHeaders(
  controlChannel,
  response.headers,
);

      console.log(
        "[AirSpan] AirPlay feedback:",
        {
          statusCode:
            response.statusCode,

          bytes:
            response.body.length,

          writeCounter:
            controlChannel.writeCounter,

          readCounter:
            controlChannel.readCounter,
        },
      );
    } catch (error) {
      console.error(
        "[AirSpan] AirPlay feedback failed:",
        error,
      );
    } finally {
      running = false;
    }
  }

  // Send one immediately.
  void sendFeedback();

  const timer =
    setInterval(
      () => {
        void sendFeedback();
      },
      2000,
    );

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
async function verifySavedAirPlayPairing(
  device,
  savedPairing,
) {
  const credentials =
    savedPairing?.credentials;

  if (
    !credentials?.controllerId ||
    !credentials?.controllerPrivateJwk ||
    !credentials?.accessoryIdentifier ||
    !credentials?.accessoryPublicKey
  ) {
    throw new Error(
      "Saved AirPlay credentials are incomplete.",
    );
  }

  const verifyAgent =
    new http.Agent({
      keepAlive: true,
      maxSockets: 1,
    });
  let controlChannel = null;

  try {
    // -------------------------
    // PAIR-VERIFY M1
    // -------------------------

    const {
      publicKey:
        verifyPublicKeyObject,
      privateKey:
        verifyPrivateKeyObject,
    } =
      generateKeyPairSync(
        "x25519",
      );

    const verifyPublicJwk =
      verifyPublicKeyObject.export({
        format: "jwk",
      });

    if (!verifyPublicJwk.x) {
      throw new Error(
        "Could not export X25519 public key.",
      );
    }

    const clientPublicKey =
      Buffer.from(
        verifyPublicJwk.x,
        "base64url",
      );

    const m1Body =
      encodeTlv8([
        [
          AIRPLAY_TLV.STATE,
          Buffer.from([0x01]),
        ],
        [
          AIRPLAY_TLV.PUBLIC_KEY,
          clientPublicKey,
        ],
      ]);

    console.log(
      "[AirSpan] Sending AirPlay pair-verify M1:",
      {
        device:
          device.name,

        publicKeyBytes:
          clientPublicKey.length,
      },
    );

    const m2Response =
      await postAirPlayPairVerify(
        device,
        verifyAgent,
        m1Body,
      );

    if (
      m2Response.statusCode < 200 ||
      m2Response.statusCode >= 300
    ) {
      throw new Error(
        `AirPlay pair-verify M1 failed with HTTP ${m2Response.statusCode}.`,
      );
    }

    // -------------------------
    // PAIR-VERIFY M2
    // -------------------------

    const outerM2 =
      decodeTlv8(
        m2Response.body,
      );

    const m2State =
      outerM2.get(
        AIRPLAY_TLV.STATE,
      )?.[0];

    const m2Error =
      outerM2.get(
        AIRPLAY_TLV.ERROR,
      )?.[0];

    if (m2Error !== undefined) {
      throw new Error(
        `Apple TV returned pair-verify error ${m2Error}.`,
      );
    }

    if (m2State !== 0x02) {
      throw new Error(
        `Expected pair-verify M2, received state ${m2State}.`,
      );
    }

    const serverPublicKey =
      outerM2.get(
        AIRPLAY_TLV.PUBLIC_KEY,
      );

    const encryptedM2 =
      outerM2.get(
        AIRPLAY_TLV.ENCRYPTED_DATA,
      );

    if (
      !serverPublicKey ||
      !encryptedM2
    ) {
      throw new Error(
        "AirPlay M2 is missing verification data.",
      );
    }

    if (
      serverPublicKey.length !== 32
    ) {
      throw new Error(
        `Unexpected Apple TV X25519 public key length: ${serverPublicKey.length}.`,
      );
    }

    const serverPublicKeyObject =
      createPublicKey({
        key: {
          kty: "OKP",
          crv: "X25519",
          x:
            serverPublicKey.toString(
              "base64url",
            ),
        },
        format: "jwk",
      });

    const sharedSecret =
      diffieHellman({
        privateKey:
          verifyPrivateKeyObject,

        publicKey:
          serverPublicKeyObject,
      });

    const verificationKey =
      hapHkdf(
        "Pair-Verify-Encrypt-Salt",
        "Pair-Verify-Encrypt-Info",
        sharedSecret,
      );

    const decryptedM2 =
      decryptHapPayload(
        verificationKey,
        "PV-Msg02",
        encryptedM2,
      );

    const innerM2 =
      decodeTlv8(
        decryptedM2,
      );

    const accessoryIdentifier =
      innerM2.get(
        AIRPLAY_TLV.IDENTIFIER,
      );

    const accessorySignature =
      innerM2.get(
        AIRPLAY_TLV.SIGNATURE,
      );

    if (
      !accessoryIdentifier ||
      !accessorySignature
    ) {
      throw new Error(
        "AirPlay M2 is missing accessory identity/signature.",
      );
    }

    const expectedIdentifier =
      Buffer.from(
        credentials
          .accessoryIdentifier,
      );

    if (
      !accessoryIdentifier.equals(
        expectedIdentifier,
      )
    ) {
      throw new Error(
        "Apple TV identifier does not match the saved pairing.",
      );
    }

    const accessoryLongTermRaw =
      Buffer.from(
        credentials
          .accessoryPublicKey,
        "base64",
      );

    const accessoryLongTermKey =
      createPublicKey({
        key: {
          kty: "OKP",
          crv: "Ed25519",

          x:
            accessoryLongTermRaw
              .toString(
                "base64url",
              ),
        },

        format: "jwk",
      });

    // Apple TV signs:
    //
    // server ephemeral key
    // + Apple TV identifier
    // + client ephemeral key

    const accessoryInfo =
      Buffer.concat([
        serverPublicKey,
        accessoryIdentifier,
        clientPublicKey,
      ]);

    const accessoryIsValid =
      cryptoVerify(
        null,
        accessoryInfo,
        accessoryLongTermKey,
        accessorySignature,
      );

    if (!accessoryIsValid) {
      throw new Error(
        "Apple TV pair-verify signature is invalid.",
      );
    }

    console.log(
      "[AirSpan] AirPlay pair-verify M2 authenticated:",
      {
        device:
          device.name,

        accessoryIdentifier:
          accessoryIdentifier
            .toString(),

        sharedSecretBytes:
          sharedSecret.length,
      },
    );

    // -------------------------
    // PAIR-VERIFY M3
    // -------------------------

    const controllerIdentifier =
      Buffer.from(
        credentials.controllerId,
      );

    const controllerPrivateKey =
      createPrivateKey({
        key:
          credentials
            .controllerPrivateJwk,

        format: "jwk",
      });

    // Controller signs:
    //
    // client ephemeral key
    // + controller identifier
    // + server ephemeral key

    const controllerInfo =
      Buffer.concat([
        clientPublicKey,
        controllerIdentifier,
        serverPublicKey,
      ]);

    const controllerSignature =
      cryptoSign(
        null,
        controllerInfo,
        controllerPrivateKey,
      );

    const innerM3 =
      encodeTlv8([
        [
          AIRPLAY_TLV.IDENTIFIER,
          controllerIdentifier,
        ],
        [
          AIRPLAY_TLV.SIGNATURE,
          controllerSignature,
        ],
      ]);

    const encryptedM3 =
      encryptHapPayload(
        verificationKey,
        "PV-Msg03",
        innerM3,
      );

    const outerM3 =
      encodeTlv8([
        [
          AIRPLAY_TLV.STATE,
          Buffer.from([0x03]),
        ],
        [
          AIRPLAY_TLV.ENCRYPTED_DATA,
          encryptedM3,
        ],
      ]);

    const m4Response =
      await postAirPlayPairVerify(
        device,
        verifyAgent,
        outerM3,
        true
      );

    if (
      m4Response.statusCode < 200 ||
      m4Response.statusCode >= 300
    ) {
      throw new Error(
        `AirPlay pair-verify M3 failed with HTTP ${m4Response.statusCode}.`,
      );
    }

    // -------------------------
    // PAIR-VERIFY M4
    // -------------------------

    const outerM4 =
      decodeTlv8(
        m4Response.body,
      );

    const m4State =
      outerM4.get(
        AIRPLAY_TLV.STATE,
      )?.[0];

    const m4Error =
      outerM4.get(
        AIRPLAY_TLV.ERROR,
      )?.[0];

    if (m4Error !== undefined) {
      throw new Error(
        `Apple TV rejected pair-verify with error ${m4Error}.`,
      );
    }

    if (m4State !== 0x04) {
      throw new Error(
        `Expected pair-verify M4, received state ${m4State}.`,
      );
    }
    const controlSocket =
  m4Response.socket;

if (
  !controlSocket ||
  controlSocket.destroyed
) {
  throw new Error(
    "Could not take ownership of the AirPlay control socket.",
  );
}
const controlWriteKey =
  hapHkdf(
    "Control-Salt",
    "Control-Write-Encryption-Key",
    sharedSecret,
  );

const controlReadKey =
  hapHkdf(
    "Control-Salt",
    "Control-Read-Encryption-Key",
    sharedSecret,
  );

console.log(
  "[AirSpan] AirPlay control encryption ready:",
  {
    device: device.name,
    writeKeyBytes:
      controlWriteKey.length,
    readKeyBytes:
      controlReadKey.length,
  },
);
 console.log(
  "[AirSpan] AirPlay pair-verify M4 verified:",
  {
    device:
      device.name,

    state:
      m4State,
  },
);

controlChannel =
  createAirPlayControlChannel(
    controlSocket,
    controlWriteKey,
    controlReadKey,
  );

try {
  await setupAirPlayFairPlay(
    controlChannel,
  );
} catch (error) {
  // Some receivers complete pair-verify and encrypted media setup without
  // exposing the optional FairPlay SAP endpoint. A 404 here must not throw
  // away an otherwise valid saved pairing and force PIN pairing again.
  if (
    Number(error?.statusCode) !==
    404
  ) {
    throw error;
  }

  console.warn(
    "[AirSpan] FairPlay SAP is not available on this receiver; continuing with saved pairing.",
    {
      device:
        device.name,
      statusCode:
        error.statusCode,
    },
  );
  airPlayDiagnostic(
    "fairplay-skipped",
    {
      device:
        device.name,
      statusCode:
        error.statusCode,
    },
  );
}

const encryptedInfo =
  await probeEncryptedAirPlayInfo(
    controlChannel,
  );

console.log(
  "[AirSpan] Encrypted AirPlay /info response:",
  {
    device:
      device.name,

    statusCode:
      encryptedInfo.statusCode,

    bytes:
      encryptedInfo.body.length,

    writeCounter:
      controlChannel.writeCounter,

    readCounter:
      controlChannel.readCounter,
  },
);

if (
  encryptedInfo.statusCode !== 200
) {
  throw new Error(
    `Encrypted AirPlay /info returned ${encryptedInfo.statusCode}.`,
  );
}

let parsedAirPlayInfo;

try {
  const parsed =
    parseBinaryPlist(
      encryptedInfo.body,
    );

  parsedAirPlayInfo =
    Array.isArray(parsed)
      ? parsed[0]
      : parsed;

  console.log(
    "[AirSpan] Parsed AirPlay receiver capabilities:",
    summarizeAirPlayInfo(
      parsedAirPlayInfo,
    ),
  );
} catch (error) {
  console.error(
    "[AirSpan] Could not parse AirPlay /info plist:",
    error,
  );

  throw error;
}

controlChannel.receiverInfo =
  parsedAirPlayInfo;

const controlSetup =
  await startEncryptedAirPlayControlSetup(
    device,
    controlChannel,
  );

if (
  controlSetup.response.statusCode !== 200
) {
  throw new Error(
    `AirPlay control SETUP returned ${controlSetup.response.statusCode}.`,
  );
}

controlChannel.session =
  controlSetup;

initializeAirPlayMediaClock(
  controlChannel,
  controlSetup,
);

console.log(
  "[AirSpan] Refreshing AirPlay /info after control SETUP...",
);

const postSetupInfoResponse =
  await probeEncryptedAirPlayInfo(
    controlChannel,
  );

if (
  postSetupInfoResponse.statusCode !== 200
) {
  throw new Error(
    `Post-SETUP AirPlay /info returned ${postSetupInfoResponse.statusCode}.`,
  );
}

const postSetupParsed =
  parseBinaryPlist(
    postSetupInfoResponse.body,
  );

const postSetupInfo =
  Array.isArray(postSetupParsed)
    ? postSetupParsed[0]
    : postSetupParsed;

console.log(
  "[AirSpan] Post-SETUP AirPlay receiver capabilities:",
  summarizeAirPlayInfo(
    postSetupInfo,
  ),
);

console.log(
  "[AirSpan] Post-SETUP screen details:",
  {
    displays:
      postSetupInfo?.displays,

    supportedFormats:
      postSetupInfo?.supportedFormats,

    playbackCapabilities:
      postSetupInfo?.playbackCapabilities,

    canRecordScreenStream:
      postSetupInfo?.canRecordScreenStream,

    receiverHDRCapability:
      postSetupInfo?.receiverHDRCapability,

    osBuildVersion:
      postSetupInfo?.osBuildVersion,

    writeCounter:
      controlChannel.writeCounter,

    readCounter:
      controlChannel.readCounter,
  },
);

controlChannel.receiverInfo =
  postSetupInfo;
  const eventPort =
  Number(
    controlSetup.parsed
      ?.eventPort || 0,
  );

if (!eventPort) {
  throw new Error(
    "AirPlay control SETUP did not return an eventPort.",
  );
}

const eventChannel =
  await connectAirPlayEventChannel(
    device,
    eventPort,
    sharedSecret,
    controlChannel,
  );

controlChannel.eventChannel =
  eventChannel;

const recordResponse =
  await startAirPlayRecord(
    controlChannel,
    controlSetup,
  );

if (
  recordResponse.statusCode !== 200
) {
  throw new Error(
    `AirPlay RECORD returned ${recordResponse.statusCode}.`,
  );
}

controlChannel.recordStarted =
  true;

await setAirPlayTimingPeers(
  device,
  controlChannel,
  controlSetup,
);

await setupAirPlaySilentScreenAudio(
  device,
  controlChannel,
  controlSetup,
  sharedSecret,
);

const videoSetup =
  await setupAirPlayVideoStream(
    device,
    controlChannel,
    sharedSecret,
  );

const videoDataSocket =
  await connectAirPlayVideoDataChannel(
    device,
    videoSetup,
  );

controlChannel.video = {
  ...videoSetup,

  socket:
    videoDataSocket,

  nonce:
    0n,

  frameSeq:
    0,
    lastFrameTimestamp:
  0n,

pendingCodecTimestamp:
  undefined,

pendingCodecTimelineID:
  undefined,

  codecSent:
    false,

  droppedFrames:
    0,

  ipcFrames:
    0,

  preCodecDrops:
    0,

  backpressureDrops:
    0,

  payloadBytes:
    0,

  lastFrameAt:
    0,

  lastCaptureTimestamp:
    0,

  heartbeatTimer:
    null,

  statsTimer:
    null,
};

controlChannel.video.statsTimer =
  setInterval(
    () => {
      const video =
        controlChannel.video;

      if (
        !video ||
        video.socket.destroyed
      ) {
        return;
      }

      airPlayDiagnostic(
        "video-stats",
        {
          ipcFrames:
            video.ipcFrames,
          sentFrames:
            video.frameSeq,
          payloadBytes:
            video.payloadBytes,
          preCodecDrops:
            video.preCodecDrops,
          backpressureDrops:
            video.backpressureDrops,
          codecSent:
            video.codecSent,
          nonce:
            video.nonce.toString(),
          writableLength:
            video.socket.writableLength,
          writableNeedDrain:
            video.socket.writableNeedDrain,
          bytesWritten:
            video.socket.bytesWritten,
          lastFrameAgeMs:
            video.lastFrameAt
              ? Date.now() -
                video.lastFrameAt
              : null,
          audioPackets:
            controlChannel.audioSetup?.packetsSent || 0,
          audioPayloadBytes:
            controlChannel.audioSetup?.payloadBytes || 0,
          audioSyncPackets:
            controlChannel.audioSetup?.syncPackets || 0,
          audioRemoteDataPort:
            controlChannel.audioSetup?.remoteDataPort || null,
          audioRemoteControlPort:
            controlChannel.audioSetup?.remoteControlPort || null,
        },
      );
    },
    10000,
  );

controlChannel.video.statsTimer
  .unref?.();

videoDataSocket.once(
  "close",
  () => {
    clearInterval(
      controlChannel.video
        ?.statsTimer,
    );

    airPlayDiagnostic(
      "video-socket-closed",
      {
        ipcFrames:
          controlChannel.video
            ?.ipcFrames,
        sentFrames:
          controlChannel.video
            ?.frameSeq,
      },
    );
  },
);
controlChannel.stopFeedback =
  startAirPlayFeedbackLoop(
    controlChannel,
  );
return {
  ok: true,

  agent:
    verifyAgent,

  sharedSecret,

  verificationKey,

  controlChannel,
};

  } catch (error) {
    closeAirPlayChannel(
      controlChannel,
    );
    verifyAgent.destroy();
    throw error;
  }
}

function startAirPlayDiscovery() {
  console.log("[AirSpan] Starting AirPlay discovery...");

  airPlayBonjour = new Bonjour();

  airPlayBrowser = airPlayBonjour.find({
    type: "airplay",
    protocol: "tcp",
  });

  airPlayBrowser.on("up", (service) => {
  const device = normalizeAirPlayDevice(service);

  airPlayDevices.set(device.id, device);

  console.log(
    "[AirSpan] AirPlay device found:",
    device,
  );

  sendAirPlayDevices();

  if (
    airPlayConnectionState.status ===
      "offline" &&
    isSameAirPlayDevice(
      device,
      lastAirPlayDevice,
    )
  ) {
    lastAirPlayDevice = device;
    setAirPlayConnectionState({
      status: "disconnected",
      deviceId: device.id,
      name: device.name,
      message:
        `${device.name} is back online. Select Reconnect when ready.`,
      connected: false,
      canReconnect: true,
    });
  }
});

  airPlayBrowser.on("down", (service) => {
  const device = normalizeAirPlayDevice(service);

  airPlayDevices.delete(device.id);

  console.log(
    "[AirSpan] AirPlay device disappeared:",
    device.name,
  );

  sendAirPlayDevices();

  const activeDevice =
    pendingAirPlayPairing?.device ||
    pendingAirPlayDevice ||
    lastAirPlayDevice;

  if (
    isSameAirPlayDevice(
      device,
      activeDevice,
    )
  ) {
    const channel =
      pendingAirPlayPairing
        ?.controlChannel;

    if (channel) {
      reportAirPlayConnectionLost(
        activeDevice,
        channel,
        "Receiver disappeared from AirPlay discovery",
      );
    } else if (
      [
        "connecting",
        "pairing",
      ].includes(
        airPlayConnectionState.status,
      )
    ) {
      pendingAirPlayPairing
        ?.agent
        ?.destroy?.();
      pendingAirPlayPairing = null;
      pendingAirPlayDevice = null;
      lastAirPlayDevice =
        activeDevice;
      setAirPlayConnectionState({
        status: "offline",
        deviceId:
          activeDevice?.id || null,
        name:
          activeDevice?.name || device.name,
        message:
          `${activeDevice?.name || device.name} went offline during connection.`,
        connected: false,
        canReconnect: true,
      });
    }
  }
});
}
function pickLanAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== 'IPv4') continue;
      candidates.push(entry.address);
    }
  }
const signalRooms = new Map();

function getSignalRoom(code) {
  let room = signalRooms.get(code);

  if (!room) {
    room = {
      offer: null,
      answer: null,
      hostCandidates: [],
      viewerCandidates: [],
      viewerReady: false,
      updatedAt: Date.now(),
    };

    signalRooms.set(code, room);
  }

  room.updatedAt = Date.now();
  return room;
}

function sendSignalJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });

  res.end(JSON.stringify(body));
}

async function readSignalJson(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(
    Buffer.concat(chunks).toString('utf8')
  );
}

async function trySignal(req, res) {
  const url = new URL(
    req.url || '/',
    `http://127.0.0.1:${PORT}`
  );

  if (!url.pathname.startsWith('/airspan/signal/')) {
    return false;
  }

  const parts = url.pathname
    .split('/')
    .filter(Boolean);

  const code = (parts[2] || '').toUpperCase();
  const action = parts[3] || '';

  if (!/^[A-Z2-9]{5}$/.test(code)) {
    sendSignalJson(res, 400, {
      error: 'Invalid room code',
    });

    return true;
  }

  const room = getSignalRoom(code);

  // -------------------------
  // GET CURRENT ROOM STATE
  // -------------------------

  if (
    req.method === 'GET' &&
    action === 'state'
  ) {
    sendSignalJson(res, 200, room);
    return true;
  }

  if (req.method !== 'POST') {
    sendSignalJson(res, 405, {
      error: 'Method not allowed',
    });

    return true;
  }

  const body = await readSignalJson(req);

  // -------------------------
  // MAC IS WAITING
  // -------------------------

  if (action === 'viewer-ready') {
    room.viewerReady = true;
  }

  // -------------------------
  // NEW PC SHARE SESSION
  // -------------------------

  else if (action === 'reset') {
    room.offer = null;
    room.answer = null;
    room.hostCandidates = [];
    room.viewerCandidates = [];
  }

  // -------------------------
  // PC WEBRTC OFFER
  // -------------------------

  else if (action === 'offer') {
    room.offer = body.description ?? null;
    room.answer = null;
  }

  // -------------------------
  // MAC WEBRTC ANSWER
  // -------------------------

  else if (action === 'answer') {
    room.answer = body.description ?? null;
  }

  // -------------------------
  // ICE CANDIDATE
  // -------------------------

  else if (action === 'ice') {
    const candidate = body.candidate;

    if (candidate) {
      if (body.side === 'host') {
        room.hostCandidates.push(candidate);
      } else if (body.side === 'viewer') {
        room.viewerCandidates.push(candidate);
      } else {
        sendSignalJson(res, 400, {
          error: 'Invalid ICE side',
        });

        return true;
      }
    }
  }

  // -------------------------
  // CLOSE ROOM
  // -------------------------

  else if (action === 'close') {
    signalRooms.delete(code);

    sendSignalJson(res, 200, {
      ok: true,
    });

    return true;
  }

  else {
    sendSignalJson(res, 404, {
      error: 'Unknown signaling action',
    });

    return true;
  }

  room.updatedAt = Date.now();

  sendSignalJson(res, 200, {
    ok: true,
  });

  return true;
}
  // Prefer typical private-network addresses.
  return candidates.find((ip) => /^10\./.test(ip))
    || candidates.find((ip) => /^192\.168\./.test(ip))
    || candidates.find((ip) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip))
    || candidates[0]
    || '127.0.0.1';
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
  })[ext] || 'application/octet-stream';
}

function safeStaticPath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, `http://127.0.0.1:${PORT}`).pathname);
  } catch {
    return null;
  }
  const relative = pathname.replace(/^\/+/, '');
  const full = path.resolve(STATIC_ROOT, relative);
  if (full !== STATIC_ROOT && !full.startsWith(STATIC_ROOT + path.sep)) return null;
  return full;
}

async function tryStatic(req, res) {
  const pathname = new URL(req.url || '/', `http://127.0.0.1:${PORT}`).pathname;
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) return false;

  let filePath = safeStaticPath(req.url || '/');
  if (!filePath) {
    res.writeHead(400);
    res.end('Bad Request');
    return true;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('Not a file');
  } catch {
    if (path.extname(pathname)) {
      res.writeHead(404);
      res.end('Not Found');
      return true;
    }

    filePath = path.join(STATIC_ROOT, 'index.html');
  }

  try {
    const isVersionedAsset = pathname.startsWith('/assets/');
    const isHtml = path.extname(filePath).toLowerCase() === '.html';

    res.writeHead(200, {
      'content-type': contentType(filePath),
      'cache-control': isVersionedAsset
        ? 'public, max-age=31536000, immutable'
        : isHtml
          ? 'no-store'
          : 'public, max-age=300',
    });

    if (req.method === 'HEAD') {
      res.end();
    } else {
      createReadStream(filePath).pipe(res);
    }

    return true;
  } catch {
    return false;
  }
}
const signalRooms = new Map();

function getSignalRoom(code) {
  let room = signalRooms.get(code);

  if (!room) {
    room = {
      offer: null,
      answer: null,
      hostCandidates: [],
      viewerCandidates: [],
      viewerReady: false,
      updatedAt: Date.now(),
    };

    signalRooms.set(code, room);
  }

  room.updatedAt = Date.now();
  return room;
}

function sendSignalJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });

  res.end(JSON.stringify(body));
}

async function readSignalJson(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(
    Buffer.concat(chunks).toString('utf8')
  );
}

async function trySignal(req, res) {
  const url = new URL(
    req.url || '/',
    `http://127.0.0.1:${PORT}`
  );

  if (!url.pathname.startsWith('/airspan/signal/')) {
    return false;
  }

  const parts = url.pathname.split('/').filter(Boolean);

  const code = (parts[2] || '').toUpperCase();
  const action = parts[3] || '';

  if (!/^[A-Z2-9]{5}$/.test(code)) {
    sendSignalJson(res, 400, {
      error: 'Invalid room code',
    });

    return true;
  }

  const room = getSignalRoom(code);

  if (req.method === 'GET' && action === 'state') {
    sendSignalJson(res, 200, room);
    return true;
  }

  if (req.method !== 'POST') {
    sendSignalJson(res, 405, {
      error: 'Method not allowed',
    });

    return true;
  }

  const body = await readSignalJson(req);

  if (action === 'viewer-ready') {
    room.viewerReady = true;
  } else if (action === 'reset') {
    room.offer = null;
    room.answer = null;
    room.hostCandidates = [];
    room.viewerCandidates = [];
  } else if (action === 'offer') {
    room.offer = body.description ?? null;
    room.answer = null;
  } else if (action === 'answer') {
    room.answer = body.description ?? null;
  } else if (action === 'ice') {
    const candidate = body.candidate;

    if (candidate) {
      if (body.side === 'host') {
        room.hostCandidates.push(candidate);
      } else if (body.side === 'viewer') {
        room.viewerCandidates.push(candidate);
      } else {
        sendSignalJson(res, 400, {
          error: 'Invalid ICE side',
        });

        return true;
      }
    }
  } else if (action === 'close') {
    signalRooms.delete(code);

    sendSignalJson(res, 200, {
      ok: true,
    });

    return true;
  } else {
    sendSignalJson(res, 404, {
      error: 'Unknown signaling action',
    });

    return true;
  }

  room.updatedAt = Date.now();

  sendSignalJson(res, 200, {
    ok: true,
  });

  return true;
}

async function startServer() {
  server = http.createServer(async (req, res) => {
  try {
    if (await trySignal(req, res)) return;
    if (await tryStatic(req, res)) return;
    res.writeHead(404);
    res.end('Not Found');
    } catch (error) {
      console.error('[AirSpan] server error', error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('AirSpan server error');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', resolve);
  });
}

async function waitForServer(url) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('AirSpan local server did not become ready.');
}

async function createWindow() {
  const lanIp = pickLanAddress();
  const pairingOrigin = `http://${lanIp}:${PORT}`;
  ipcMain.removeHandler(
  "airspan:get-airplay-devices",
);

ipcMain.handle(
  "airspan:get-airplay-devices",
  () => getAirPlayDeviceSummaries(),
);
ipcMain.removeHandler(
  "airspan:get-airplay-state",
);
ipcMain.handle(
  "airspan:get-airplay-state",
  () => airPlayConnectionState,
);
ipcMain.removeHandler(
  "airspan:export-diagnostics",
);
ipcMain.handle(
  "airspan:export-diagnostics",
  () => exportAirSpanDiagnostics(),
);
ipcMain.removeHandler("airspan:connect-airplay-device");
ipcMain.removeAllListeners(
  "airspan:airplay-video-codec",
);

ipcMain.on(
  "airspan:airplay-video-codec",
  (_event, payload) => {
    try {
      const channel =
        getActiveAirPlayVideoChannel();

      if (!channel) {
        return;
      }

      sendAirPlayCodecPacket(
  channel,
  payload.data,

  Number(
    payload.width,
  ),

  Number(
    payload.height,
  ),

  Number(
    payload.timestamp,
  ),
);
    } catch (error) {
      console.error(
        "[AirSpan] Could not send AirPlay codec packet:",
        error,
      );
    }
  },
);


ipcMain.removeAllListeners(
  "airspan:airplay-video-frame",
);

ipcMain.on(
  "airspan:airplay-video-frame",
  (_event, payload) => {
    try {
      const channel =
        getActiveAirPlayVideoChannel();

      if (!channel) {
        return;
      }

      channel.video.ipcFrames =
        (channel.video.ipcFrames || 0) +
        1;

      sendAirPlayVideoPacket(
  channel,
  payload.data,

  Boolean(
    payload.keyFrame,
  ),

  Number(
    payload.timestamp,
  ),
);
    } catch (error) {
      console.error(
        "[AirSpan] Could not send AirPlay video packet:",
        error,
      );
    }
  },
);

ipcMain.removeAllListeners(
  "airspan:airplay-audio-frame",
);

ipcMain.on(
  "airspan:airplay-audio-frame",
  (_event, payload) => {
    try {
      const channel =
        getActiveAirPlayVideoChannel();

      if (!channel || !payload?.data) {
        return;
      }

      sendAirPlayAudioPacket(
        channel,
        payload.data,
        Number(payload.timestamp),
      );
    } catch (error) {
      console.error(
        "[AirSpan] Could not send AirPlay audio packet:",
        error,
      );
    }
  },
);

ipcMain.handle(
  "airspan:connect-airplay-device",
  async (_event, device) => {
    if (!device) {
      throw new Error("No AirPlay device was supplied.");
    }

    const ipv4 = (device.addresses || []).find(
      (address) =>
        typeof address === "string" &&
        /^\d+\.\d+\.\d+\.\d+$/.test(address),
    );

    const address = ipv4 || device.host;

    if (
      pendingAirPlayPairing &&
      !pendingAirPlayPairing.verified &&
      !pendingAirPlayPairing.credentials &&
      isSameAirPlayDevice(
        device,
        pendingAirPlayPairing.device,
      )
    ) {
      setAirPlayConnectionState({
        status: "pairing",
        deviceId: device.id,
        name: device.name,
        message:
          `Enter the code shown on ${device.name}.`,
        connected: false,
        canReconnect: false,
        paired: false,
      });

      return {
        ok: true,
        id: device.id,
        name: device.name,
        address,
        port: device.port,
        requiresPin: true,
        paired: false,
        pairingInProgress: true,
      };
    }

    console.log(
      "[AirSpan] Selected AirPlay device:",
      {
        id: device.id,
        name: device.name,
        address,
        port: device.port,
        model: device.model,
      },
    );
    setAirPlayConnectionState({
      status: "connecting",
      deviceId: device.id,
      name: device.name,
      message:
        `Connecting to ${device.name}...`,
      connected: false,
      canReconnect: false,
      paired: false,
    });
    await disconnectActiveAirPlay({
      notify: false,
    });
    lastAirPlayDevice = device;

    try {
const savedPairing =
  await getSavedAirPlayPairing(device);

setAirPlayConnectionState({
  paired:
    Boolean(savedPairing),
});

console.log(
  "[AirSpan] Saved AirPlay pairing:",
  savedPairing
    ? "found"
    : "not found",
);
    const info = await getAirPlayInfo(device);

    console.log(
      "[AirSpan] Receiver capability probe:",
      info,
    );

if (savedPairing) {
  try {
    const verified =
      await verifySavedAirPlayPairing(
        device,
        savedPairing,
      );

    pendingAirPlayDevice =
      device;

    pendingAirPlayPairing = {
      device,

      agent:
        verified.agent,

      credentials:
        savedPairing.credentials,

      verifySharedSecret:
  verified.sharedSecret,

verificationKey:
  verified.verificationKey,

controlChannel:
  verified.controlChannel,

verified: true,
    };

    const videoTarget =
  getAirPlayVideoTarget(
    verified.controlChannel.receiverInfo,
  );

console.log(
  "[AirSpan] Saved AirPlay pairing verified:",
  device.name,
);

console.log(
  "[AirSpan] AirPlay negotiated video target:",
  videoTarget,
);

setAirPlayConnectionState({
  status: "connected",
  deviceId: device.id,
  name: device.name,
  message:
    `Connected to ${device.name}`,
  connected: true,
  canReconnect: false,
  paired: true,
});
if (
  !monitorAirPlayConnection(
    device,
    verified.controlChannel,
  )
) {
  throw new Error(
    "The receiver went offline during setup.",
  );
}

return {
  ok: true,
  id: device.id,
  name: device.name,
  address,
  port: device.port,
  info,

  videoTarget,

  paired: true,
  verified: true,
  requiresPin: false,
};
  } catch (error) {
    console.error(
      "[AirSpan] Saved AirPlay pairing verification failed:",
      error,
    );

    const verificationMessage =
      String(
        error?.message || error,
      );
    const pairingWasRejected =
      /pair-verify|saved AirPlay credentials|identifier does not match|signature is invalid|rejected pair-verify/i
        .test(
          verificationMessage,
        );

    if (!pairingWasRejected) {
      throw error;
    }

    console.log(
      "[AirSpan] Falling back to PIN pairing.",
    );
  }
}

const pairingAgent =
  new http.Agent({
    keepAlive: true,
    maxSockets: 1,
  });

try {
  const pairing =
    await startAirPlayPinPairing(
      device,
      pairingAgent,
    );

  console.log(
    "[AirSpan] PIN pairing started:",
    pairing,
  );

  if (!pairing.ok) {
    throw new Error(
      `Apple TV rejected pair-pin-start with HTTP ${pairing.statusCode}.`,
    );
  }

  const setupM2 =
    await startAirPlayPairSetupM1(
      device,
      pairingAgent,
    );

  pendingAirPlayDevice = device;

  pendingAirPlayPairing = {
    device,
    agent: pairingAgent,
    salt: setupM2.salt,
    serverPublicKey:
      setupM2.serverPublicKey,
  };

  setAirPlayConnectionState({
    status: "pairing",
    deviceId: device.id,
    name: device.name,
    message:
      `Enter the code shown on ${device.name}.`,
    connected: false,
    canReconnect: false,
    paired: false,
  });

  return {
    ok: true,
    id: device.id,
    name: device.name,
    address,
    port: device.port,
    info,
    pairing,
    requiresPin: true,
    paired: false,
  };
} catch (error) {
  pairingAgent.destroy();
  throw error;
}
    } catch (error) {
      if (
        !(
          airPlayConnectionState
            .status === "offline" &&
          airPlayConnectionState
            .deviceId === device.id
        )
      ) {
        const message =
          String(
            error?.message || error,
          );
        const unavailable =
          /timed out|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|socket closed|went offline/i
            .test(message);

        setAirPlayConnectionState({
          status:
            unavailable
              ? "offline"
              : "error",
          deviceId: device.id,
          name: device.name,
          message:
            unavailable
              ? `${device.name} is unavailable. Check that it is online, then reconnect.`
              : `Could not connect to ${device.name}: ${message}`,
          connected: false,
          canReconnect: true,
        });
      }

      throw error;
    }
  },
);

ipcMain.removeHandler(
  "airspan:disconnect-airplay-device",
);
ipcMain.handle(
  "airspan:disconnect-airplay-device",
  async () =>
    disconnectActiveAirPlay(),
);

ipcMain.removeHandler(
  "airspan:forget-airplay-device",
);
ipcMain.handle(
  "airspan:forget-airplay-device",
  async (_event, deviceId) => {
    const id =
      String(deviceId || "");
    const device =
      airPlayDevices.get(id) ||
      (
        pendingAirPlayDevice?.id === id
          ? pendingAirPlayDevice
          : null
      ) ||
      (
        lastAirPlayDevice?.id === id
          ? lastAirPlayDevice
          : null
      );

    if (!device) {
      throw new Error(
        "That AirPlay receiver is no longer available.",
      );
    }

    const activeDevice =
      pendingAirPlayPairing?.device ||
      pendingAirPlayDevice;
    if (
      isSameAirPlayDevice(
        device,
        activeDevice,
      )
    ) {
      await disconnectActiveAirPlay({
        notify: false,
      });
    }

    const removed =
      await forgetSavedAirPlayPairing(
        device,
      );

    if (
      isSameAirPlayDevice(
        device,
        lastAirPlayDevice,
      )
    ) {
      lastAirPlayDevice = null;
      setAirPlayConnectionState({
        status: "disconnected",
        deviceId: null,
        name: null,
        message:
          removed
            ? `Forgot ${device.name}. It will require a code next time.`
            : `${device.name} was not saved as a paired receiver.`,
        connected: false,
        canReconnect: false,
        paired: false,
      });
    }

    return {
      ok: true,
      removed:
        removed > 0,
      deviceId: device.id,
      name: device.name,
    };
  },
);

ipcMain.removeHandler(
  "airspan:submit-airplay-pin",
);

ipcMain.handle(
  "airspan:submit-airplay-pin",
  async (_event, pin) => {
    if (pendingAirPlayPinSubmission) {
      return pendingAirPlayPinSubmission;
    }

    if (!pendingAirPlayDevice) {
      throw new Error(
        "No AirPlay device is awaiting pairing.",
      );
    }

    if (
      pendingAirPlayPairing
        ?.credentials
    ) {
      return {
        ok: true,
        device:
          pendingAirPlayDevice.name,
        readyForPairSetup: false,
        srpAuthenticated: true,
        paired: true,
        alreadyCompleted: true,
      };
    }

    const cleanPin = String(pin || "")
      .replace(/\D/g, "");

    if (
      cleanPin.length < 4 ||
      cleanPin.length > 8
    ) {
      throw new Error(
        "Enter the code shown on the AirPlay device.",
      );
    }

    const submission =
      (async () => {
        console.log(
          "[AirSpan] Received AirPlay pairing code for:",
          pendingAirPlayDevice.name,
        );
        airPlayDiagnostic(
          "pin-submit",
          {
            device:
              pendingAirPlayDevice.name,
            digits:
              cleanPin.length,
          },
        );

        const srpResult =
          await finishAirPlayPairSetupM3(
            cleanPin,
          );

        if (!srpResult.ok) {
          throw new Error(
            "AirPlay SRP authentication failed.",
          );
        }

        const finalPairing =
          await finishAirPlayPairSetupM5M6();

        const pairedDevice =
          pendingAirPlayDevice;

        airPlayDiagnostic(
          "pin-pairing-complete",
          {
            device:
              pairedDevice.name,
          },
        );

        setAirPlayConnectionState({
          status: "disconnected",
          deviceId:
            pairedDevice.id,
          name:
            pairedDevice.name,
          message:
            `Paired with ${pairedDevice.name}. Select Reconnect to start mirroring.`,
          connected: false,
          canReconnect: true,
          paired: true,
        });

        return {
          ok: finalPairing.ok,
          device:
            pairedDevice.name,
          readyForPairSetup: false,
          srpAuthenticated: true,
          paired: true,
        };
      })();

    pendingAirPlayPinSubmission =
      submission;

    try {
      return await submission;
    } finally {
      if (
        pendingAirPlayPinSubmission ===
        submission
      ) {
        pendingAirPlayPinSubmission =
          null;
      }
    }
  },
);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 700,
    backgroundColor: '#0b0c0d',
    autoHideMenuBar: true,
    title: 'AirSpan',
    icon: path.join(APP_ROOT, 'build', 'airspan.ico'),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.on(
    "console-message",
    (...args) => {
      const details =
        args.length === 1 &&
        typeof args[0] === "object"
          ? args[0]
          : {
              level:
                args[1],
              message:
                args[2],
              lineNumber:
                args[3],
              sourceId:
                args[4],
            };

      const message =
        String(
          details?.message || "",
        );

      if (
        message.includes(
          "[AirSpan]",
        )
      ) {
        airPlayDiagnostic(
          "renderer-console",
          {
            level:
              details?.level,
            message,
            lineNumber:
              details?.lineNumber,
            sourceId:
              details?.sourceId,
          },
        );
      }
    },
  );

  mainWindow.webContents.on(
    "render-process-gone",
    (_event, details) => {
      airPlayDiagnostic(
        "renderer-gone",
        details,
      );
    },
  );

  mainWindow.on(
    "unresponsive",
    () => {
      airPlayDiagnostic(
        "window-unresponsive",
      );
    },
  );

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
  console.error('[AirSpan] page load failed', code, description, validatedURL);
});

// The query moves existing installs off the formerly cacheable root URL.
// HTML is now served with no-store, so subsequent rebuilds update in place.
await mainWindow.loadURL(`http://127.0.0.1:${PORT}/?desktop=1`);

mainWindow.on('closed', () => {
  mainWindow = null;
});
}
app.whenReady().then(async () => {
  await migrateLegacyAirPlayPairings();
  startAirPlayDiscovery();
  ipcMain.removeHandler("airspan:get-pairing-origin");

ipcMain.handle(
  "airspan:get-pairing-origin",
  () => {
    const lanIp = pickLanAddress();
    return `http://${lanIp}:${PORT}`;
  },
);

  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
        });

        console.log(
          '[AirSpan] screen sources:',
          sources.map((source) => ({
            id: source.id,
            name: source.name,
          })),
        );

        if (!sources.length) {
          callback({});
          return;
        }

        callback({
          video: sources[0],
          audio: "loopback",
        });
      } catch (error) {
        console.error(
          '[AirSpan] display capture failed:',
          error,
        );

        callback({});
      }
    },
  );

  await startServer();

  const localUrl = `http://127.0.0.1:${PORT}/`;

  await waitForServer(localUrl);
  await createWindow();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  try {
    airPlayBrowser?.stop();
    airPlayBonjour?.destroy();
  } catch (error) {
    console.error(
      '[AirSpan] Failed to stop AirPlay discovery:',
      error,
    );
  }

  try {
    server?.close();
  } catch (error) {
    console.error(
      '[AirSpan] Failed to stop local server:',
      error,
    );
  }
});
