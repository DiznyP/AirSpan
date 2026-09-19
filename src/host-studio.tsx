import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FileArchive,
  Link2,
  MonitorUp,
  Radio,
  ShieldCheck,
  Sparkles,
  Tv,
  Unplug,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { useDisplaySession } from "./lib/use-display-session";
import QRCode from "qrcode";
import "./host-studio.css";

// Local desktop-host UI components.
export function PairingCode({ code }: { code: string }) {
  return (
    <div className="room-code" aria-label={`Display code ${code}`}>
      <span>Display code</span>
      {code}
    </div>
  );
}
type AirPlayDevice = {
  id: string;
  name: string;
  host: string;
  port: number;
  addresses: string[];
  model: string;
  manufacturer: string;
  paired?: boolean;
};
type AirPlayConnectionState = {
  status:
    | "disconnected"
    | "connecting"
    | "pairing"
    | "connected"
    | "offline"
    | "error";
  deviceId: string | null;
  name: string | null;
  message: string;
  connected: boolean;
  canReconnect: boolean;
  paired: boolean;
};
type AirPlayVideoTarget = {
  width: number;
  height: number;
  maxFPS: number;

  displayUUID?: string;
  hdr?: string;
  receiverName?: string;
  receiverModel?: string;
};
type DiagnosticsExportResult = {
  ok: boolean;
  canceled: boolean;
  filePath?: string;
  fileName?: string;
  bytes?: number;
  eventCount?: number;
};
export function QrPanel({ value }: { value: string }) {
  const [qrSrc, setQrSrc] = useState<string>("");

  useEffect(() => {
    let active = true;

    async function generateQr() {
      try {
        const dataUrl = await QRCode.toDataURL(value, {
          width: 320,
          margin: 1,
          errorCorrectionLevel: "M",
        });

        if (active) {
          setQrSrc(dataUrl);
        }
      } catch (error) {
        console.error("[AirSpan] QR generation failed:", error);
      }
    }

    void generateQr();

    return () => {
      active = false;
    };
  }, [value]);

  return (
    <div className="qr-frame">
      {qrSrc ? (
        <img
          src={qrSrc}
          alt="AirSpan connection QR code"
        />
      ) : (
        <div className="qr-loading">
          Generating QR code...
        </div>
      )}
    </div>
  );
}

export function Button({ children, onClick, size, className = "", variant }: any) {
  const isDanger = variant === "danger";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`button ${isDanger ? "button-danger" : "button-primary"} ${size === "lg" ? "button-large" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

type QualityId = "sharp" | "cinema";

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = new Uint32Array(5);

  crypto.getRandomValues(random);

  return Array.from(random)
    .map((value) => chars[value % chars.length])
    .join("");
}
function makeEven(value: number) {
  return Math.max(
    2,
    Math.floor(value / 2) * 2,
  );
}


function fitVideoSize(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number,
) {
  const scale =
    Math.min(
      1,
      maxWidth / sourceWidth,
      maxHeight / sourceHeight,
    );

  return {
    width:
      makeEven(
        sourceWidth * scale,
      ),

    height:
      makeEven(
        sourceHeight * scale,
      ),
  };
}


function getAvcCodec(
  width: number,
  height: number,
  fps: number,
) {
  const pixels =
    width * height;

  // 4K60
  if (
    width >= 3840 &&
    height >= 2160 &&
    fps > 30
  ) {
    // High Profile, Level 5.2
    return "avc1.640034";
  }

  // 4K30 / 1440p class
  if (
    pixels >
    1920 * 1080
  ) {
    // High Profile, Level 5.1
    return "avc1.640033";
  }

  // 1080p60
  if (fps > 30) {
    // High Profile, Level 4.2
    return "avc1.64002A";
  }

  // 1080p30 and below
  // High Profile, Level 4.1
  return "avc1.640029";
}


function getVideoBitrate(
  width: number,
  height: number,
  fps: number,
) {
  const calculated =
    Math.round(
      width *
      height *
      fps *
      0.07,
    );

  return Math.max(
    4_000_000,
    Math.min(
      calculated,
      35_000_000,
    ),
  );
}


async function chooseAirPlayH264Config(
  receiver:
    AirPlayVideoTarget,

  captureWidth: number,
  captureHeight: number,
  captureFPS: number,
) {
  const receiverFPS =
    Math.max(
      1,
      Math.min(
        60,
        receiver.maxFPS || 30,
      ),
    );

  const sourceFPS =
    Math.max(
      1,
      Math.min(
        receiverFPS,
        captureFPS || receiverFPS,
      ),
    );

  const candidates: Array<{
    width: number;
    height: number;
    framerate: number;
  }> = [];

  const seen =
    new Set<string>();

  function addCandidate(
    maxWidth: number,
    maxHeight: number,
    fps: number,
  ) {
    const availableWidth =
      Math.min(
        receiver.width,
        maxWidth,
      );

    const availableHeight =
      Math.min(
        receiver.height,
        maxHeight,
      );

    const fitted =
      fitVideoSize(
        captureWidth,
        captureHeight,
        availableWidth,
        availableHeight,
      );

    const framerate =
      Math.max(
        1,
        Math.min(
          fps,
          sourceFPS,
          receiverFPS,
        ),
      );

    const key =
      `${fitted.width}x${fitted.height}@${framerate}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    candidates.push({
      ...fitted,
      framerate,
    });
  }

  // First try the highest resolution
  // both the source and receiver can use.
  addCandidate(
    receiver.width,
    receiver.height,
    sourceFPS,
  );

  addCandidate(
    receiver.width,
    receiver.height,
    30,
  );

  // Then safe fallbacks.
  addCandidate(
    1920,
    1080,
    60,
  );

  addCandidate(
    1920,
    1080,
    30,
  );

  addCandidate(
    1280,
    720,
    60,
  );

  addCandidate(
    1280,
    720,
    30,
  );

  for (
    const candidate
    of candidates
  ) {
    const codec =
      getAvcCodec(
        candidate.width,
        candidate.height,
        candidate.framerate,
      );

    const bitrate =
      getVideoBitrate(
        candidate.width,
        candidate.height,
        candidate.framerate,
      );

    const accelerationModes = [
      "prefer-hardware",
      "prefer-software",
    ] as const;

    for (
      const hardwareAcceleration
      of accelerationModes
    ) {
      const config = {
        codec,

        width:
          candidate.width,

        height:
          candidate.height,

        bitrate,

        framerate:
          candidate.framerate,

        hardwareAcceleration,

        latencyMode:
          "realtime" as const,

        avc: {
          format:
            "avc" as const,
        },
      };

      try {
        const support =
          await VideoEncoder
            .isConfigSupported(
              config,
            );

        console.log(
          "[AirSpan] H.264 candidate:",
          {
            supported:
              support.supported,

            codec,

            width:
              candidate.width,

            height:
              candidate.height,

            framerate:
              candidate.framerate,

            bitrate,

            hardwareAcceleration,
          },
        );

        if (support.supported) {
          return config;
        }
      } catch (error) {
        console.warn(
          "[AirSpan] H.264 candidate failed:",
          {
            codec,
            width:
              candidate.width,
            height:
              candidate.height,
            framerate:
              candidate.framerate,
            error,
          },
        );
      }
    }
  }

  return null;
}
function copyCodecDescription(
  value: any,
) {
  if (!value) {
    return null;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(
      value,
    ).slice();
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).slice();
  }

  return null;
}


async function startH264EncoderProbe(
  stream: MediaStream,
  config: any,
) {
  const track =
    stream.getVideoTracks()[0];

  if (!track) {
    throw new Error(
      "No video track is available for H.264 encoding.",
    );
  }
  const desktopBridge =
  (
    window as any
  ).airspanDesktop as {
    sendAirPlayVideoCodec?: (
  payload: {
    data: Uint8Array;
    width: number;
    height: number;
    timestamp: number;
  },
) => void;

    sendAirPlayVideoFrame?: (
      payload: {
        data: Uint8Array;
        keyFrame: boolean;
        timestamp: number;
      },
    ) => void;
  };

  const targetWidth =
    Number(config.width);

  const targetHeight =
    Number(config.height);

  const targetFPS =
    Math.max(
      1,
      Number(config.framerate) || 30,
    );

  type TrackProcessorLike = {
    readable: ReadableStream<VideoFrame>;
  };

  type TrackProcessorConstructor =
    new (options: {
      track: MediaStreamTrack;
    }) => TrackProcessorLike;

  const TrackProcessor =
    (
      window as typeof window & {
        MediaStreamTrackProcessor?:
          TrackProcessorConstructor;
      }
    ).MediaStreamTrackProcessor;

  let trackReader:
    ReadableStreamDefaultReader<VideoFrame> |
    null = null;

  if (TrackProcessor) {
    try {
      const processor =
        new TrackProcessor({
          track,
        });

      trackReader =
        processor.readable.getReader();
    } catch (error) {
      console.warn(
        "[AirSpan] MediaStreamTrackProcessor setup failed; using video fallback:",
        error,
      );
    }
  }

  let sourceVideo:
    HTMLVideoElement | null = null;

  if (!trackReader) {
    sourceVideo =
      document.createElement(
        "video",
      );

    sourceVideo.muted = true;
    sourceVideo.playsInline = true;
    sourceVideo.srcObject = stream;

    // Keep the fallback element connected and renderable. Chromium can
    // stop advancing a detached MediaStream video after its first frame.
    Object.assign(
      sourceVideo.style,
      {
        position: "fixed",
        width: "1px",
        height: "1px",
        left: "0",
        top: "0",
        opacity: "0.001",
        pointerEvents: "none",
      },
    );

    sourceVideo.setAttribute(
      "aria-hidden",
      "true",
    );

    document.body.appendChild(
      sourceVideo,
    );

    if (
      sourceVideo.readyState <
      HTMLMediaElement.HAVE_METADATA
    ) {
      await new Promise<void>(
        (resolve) => {
          sourceVideo?.addEventListener(
            "loadedmetadata",
            () => resolve(),
            {
              once: true,
            },
          );
        },
      );
    }

    await sourceVideo.play();
  }

  const canvas =
    document.createElement(
      "canvas",
    );

  canvas.width =
    targetWidth;

  canvas.height =
    targetHeight;

  const context =
    canvas.getContext(
      "2d",
      {
        alpha: false,
      },
    );

  if (!context) {
    throw new Error(
      "Could not create the H.264 scaling canvas.",
    );
  }

  let stopped = false;

  let frameTimerID = 0;

  let framePumpPromise:
    Promise<void> | null = null;

  let inputCount = 0;
  let outputCount = 0;
  let sourceFrameCount = 0;
  let queueSkipCount = 0;
  let encodeErrorCount = 0;
  let ipcFrameCount = 0;
  let lastInputTimestamp = 0;
  let lastOutputTimestamp = 0;
  let statsTimerID = 0;

  let decoderConfigLogged =
    false;

  const encoder =
    new VideoEncoder({
      output(
        chunk,
        metadata,
      ) {
        outputCount += 1;
        lastOutputTimestamp =
          Number(chunk.timestamp) || 0;

        if (
          !decoderConfigLogged &&
          metadata?.decoderConfig
            ?.description
        ) {
          const description =
            copyCodecDescription(
              metadata
                .decoderConfig
                .description,
            );

          if (description) {
            decoderConfigLogged =
              true;
desktopBridge
  ?.sendAirPlayVideoCodec?.({
    data:
      description,

    width:
      targetWidth,

    height:
      targetHeight,

    timestamp:
      chunk.timestamp,
  });
            console.log(
              "[AirSpan] H.264 codec data:",
              {
                bytes:
                  description
                    .byteLength,

                firstByte:
                  description[0],

                codec:
                  metadata
                    .decoderConfig
                    .codec,

                codedWidth:
                  metadata
                    .decoderConfig
                    .codedWidth,

                codedHeight:
                  metadata
                    .decoderConfig
                    .codedHeight,
              },
            );
          }
        }
const encodedData =
  new Uint8Array(
    chunk.byteLength,
  );

chunk.copyTo(
  encodedData,
);

desktopBridge
  ?.sendAirPlayVideoFrame?.({
    data:
      encodedData,

    keyFrame:
      chunk.type === "key",

    timestamp:
      chunk.timestamp,
  });
        ipcFrameCount += 1;
        if (outputCount <= 5) {
          console.log(
            "[AirSpan] H.264 encoded frame:",
            {
              number:
                outputCount,

              type:
                chunk.type,

              bytes:
                chunk.byteLength,

              timestamp:
                chunk.timestamp,
            },
          );
        }
      },

      error(error) {
        encodeErrorCount += 1;
        console.error(
          "[AirSpan] H.264 encoder error:",
          error,
        );
      },
    });

  encoder.configure(
    config,
  );

  console.log(
    "[AirSpan] H.264 encoder configured:",
    {
      codec:
        config.codec,

      width:
        targetWidth,

      height:
        targetHeight,

      framerate:
        targetFPS,

      bitrate:
        config.bitrate,

      hardwareAcceleration:
        config.hardwareAcceleration,
    },
  );

  const frameIntervalMs =
    1000 / targetFPS;

  const frameIntervalUs =
    frameIntervalMs * 1000;

  const encodeSource = (
    source: CanvasImageSource,
  ) => {
    if (stopped || encoder.state !== "configured") {
      return false;
    }

    if (encoder.encodeQueueSize > 2) {
      queueSkipCount += 1;
      return false;
    }

    let frame:
      VideoFrame | null = null;

    try {
      context.drawImage(
        source,
        0,
        0,
        targetWidth,
        targetHeight,
      );

      const timestamp =
        Math.round(
          (
            performance.timeOrigin +
            performance.now()
          ) * 1000,
        );

      frame =
        new VideoFrame(
          canvas,
          {
            timestamp,
          },
        );

      // Keyframe immediately, then
      // approximately every two seconds.
      const keyFrame =
        inputCount === 0 ||
        inputCount %
          Math.max(
            1,
            Math.round(
              targetFPS * 2,
            ),
          ) ===
            0;

      encoder.encode(
        frame,
        {
          keyFrame,
        },
      );

      inputCount += 1;
      lastInputTimestamp = timestamp;
      return true;
    } catch (error) {
      encodeErrorCount += 1;
      console.error(
        "[AirSpan] Could not encode H.264 frame:",
        error,
      );

      return false;
    } finally {
      frame?.close();
    }
  };

  if (trackReader) {
    const reader = trackReader;

    framePumpPromise =
      (async () => {
        let lastSourceTimestamp =
          Number.NEGATIVE_INFINITY;

        while (!stopped) {
          let result:
            ReadableStreamReadResult<VideoFrame>;

          try {
            result =
              await reader.read();
          } catch (error) {
            if (!stopped) {
              console.error(
                "[AirSpan] Could not read captured video frame:",
                error,
              );
            }

            break;
          }

          if (result.done) {
            break;
          }

          const sourceFrame =
            result.value;

          sourceFrameCount += 1;

          try {
            const sourceTimestamp =
              Number(
                sourceFrame.timestamp,
              );

            if (
              Number.isFinite(
                sourceTimestamp,
              ) &&
              sourceTimestamp -
                lastSourceTimestamp <
                frameIntervalUs * 0.9
            ) {
              continue;
            }

            if (
              encodeSource(
                sourceFrame,
              ) &&
              Number.isFinite(
                sourceTimestamp,
              )
            ) {
              lastSourceTimestamp =
                sourceTimestamp;
            }
          } finally {
            sourceFrame.close();
          }
        }
      })();

    console.log(
      "[AirSpan] H.264 track-driven frame pump started.",
    );
  } else if (sourceVideo) {
    const pumpFallbackFrame = () => {
      if (stopped) {
        return;
      }

      frameTimerID =
        window.setTimeout(
          pumpFallbackFrame,
          frameIntervalMs,
        );

      encodeSource(
        sourceVideo,
      );
    };

    pumpFallbackFrame();

    console.log(
      "[AirSpan] H.264 video-element fallback frame pump started.",
    );
  }

  statsTimerID =
    window.setInterval(
      () => {
        console.log(
          "[AirSpan][renderer-video-stats] " +
            JSON.stringify({
              sourceFrameCount,
              inputCount,
              outputCount,
              ipcFrameCount,
              queueSkipCount,
              encodeErrorCount,
              encoderState:
                encoder.state,
              encodeQueueSize:
                encoder.encodeQueueSize,
              lastInputTimestamp,
              lastOutputTimestamp,
              trackReadyState:
                track.readyState,
              trackMuted:
                track.muted,
              trackEnabled:
                track.enabled,
              sourceReadyState:
                sourceVideo?.readyState ?? null,
              sourceCurrentTime:
                sourceVideo?.currentTime ?? null,
              sourcePaused:
                sourceVideo?.paused ?? null,
              sourceEnded:
                sourceVideo?.ended ?? null,
              documentVisibility:
                document.visibilityState,
            }),
        );
      },
      10000,
    );

  return () => {
    if (stopped) {
      return;
    }

    stopped = true;

    try {
      if (frameTimerID) {
        window.clearTimeout(
          frameTimerID,
        );
      }

      if (statsTimerID) {
        window.clearInterval(
          statsTimerID,
        );
      }
    } catch {
      // Ignore callback cleanup errors.
    }

    try {
      void trackReader
        ?.cancel()
        .catch(() => {
          // The reader may already be closed by the ended track.
        });
    } catch {
      // Ignore reader cleanup errors.
    }

    void framePumpPromise
      ?.catch(() => {
        // Individual reader failures are logged by the frame pump.
      });

    if (sourceVideo) {
      sourceVideo.pause();
      sourceVideo.srcObject = null;
      sourceVideo.remove();
    }

    try {
      if (
        encoder.state !==
        "closed"
      ) {
        encoder.close();
      }
    } catch {
      // Ignore shutdown errors.
    }

    console.log(
      "[AirSpan] H.264 encoder stopped.",
    );
  };
}

const AIRSPAN_AUDIO_WORKLET_SOURCE = String.raw`
class AirSpanAudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 0;
    this.samples = new Float32Array(1024 * 2);
  }

  flush() {
    if (!this.frames) return;
    const output = this.frames === 1024
      ? this.samples
      : this.samples.slice(0, this.frames * 2);
    this.port.postMessage(output, [output.buffer]);
    this.frames = 0;
    this.samples = new Float32Array(1024 * 2);
  }

  process(inputs) {
    const input = inputs[0];
    const left = input && input[0];
    if (!left) return true;
    const right = input[1] || left;

    for (let index = 0; index < left.length; index += 1) {
      const offset = this.frames * 2;
      this.samples[offset] = left[index];
      this.samples[offset + 1] = right[index];
      this.frames += 1;
      if (this.frames === 1024) this.flush();
    }
    return true;
  }
}

registerProcessor("airspan-audio-capture", AirSpanAudioCaptureProcessor);
`;

async function startAirPlayAudioCapture(
  stream: MediaStream,
) {
  const track =
    stream.getAudioTracks()[0];

  if (!track) {
    console.warn(
      "[AirSpan] No system-audio track was returned by display capture.",
    );
    return null;
  }

  const desktopBridge =
    (
      window as any
    ).airspanDesktop as {
      sendAirPlayAudioFrame?: (
        payload: {
          data: Uint8Array;
          timestamp: number;
        },
      ) => void;
    };

  const sendAirPlayAudioFrame =
    desktopBridge?.sendAirPlayAudioFrame;

  if (!sendAirPlayAudioFrame) {
    console.warn(
      "[AirSpan] AirPlay audio bridge is unavailable.",
    );
    return null;
  }

  let context: AudioContext;
  try {
    context = new AudioContext({
      sampleRate: 44100,
    });
  } catch {
    context = new AudioContext();
  }

  const sourceStream =
    new MediaStream([track]);
  const source =
    context.createMediaStreamSource(
      sourceStream,
    );
  const silentGain =
    context.createGain();

  const outputFrames = 352;
  const outputRate = 44100;
  const inputRate =
    context.sampleRate || outputRate;
  const sourceStep =
    inputRate / outputRate;
  const left: number[] = [];
  const right: number[] = [];
  let sourcePosition = 0;
  let stopped = false;
  let sentFrames = 0;
  let capturedInputFrames = 0;
  let firstFrameAt = 0;

  const appendInput = (
    inputLeft: Float32Array,
    inputRight: Float32Array,
  ) => {
    capturedInputFrames +=
      inputLeft.length;

    for (
      let index = 0;
      index < inputLeft.length;
      index += 1
    ) {
      left.push(inputLeft[index]);
      right.push(
        inputRight[index] ??
          inputLeft[index],
      );
    }
  };

  const emitFrames = () => {
    while (
      left.length - sourcePosition >=
      1 + (outputFrames - 1) * sourceStep
    ) {
      const pcm =
        new Uint8Array(
          outputFrames * 2 * 2,
        );
      const pcmView =
        new DataView(
          pcm.buffer,
        );

      for (
        let frame = 0;
        frame < outputFrames;
        frame += 1
      ) {
        const position =
          sourcePosition +
          frame * sourceStep;
        const index =
          Math.floor(position);
        const fraction =
          position - index;
        const leftA =
          left[index] || 0;
        const leftB =
          left[index + 1] ?? leftA;
        const rightA =
          right[index] ?? leftA;
        const rightB =
          right[index + 1] ?? rightA;
        const leftSample =
          leftA +
          (leftB - leftA) * fraction;
        const rightSample =
          rightA +
          (rightB - rightA) * fraction;
        const leftValue = Math.max(
          -32768,
          Math.min(
            32767,
            Math.round(
              leftSample < 0
                ? leftSample * 32768
                : leftSample * 32767,
            ),
          ),
        );
        const rightValue = Math.max(
          -32768,
          Math.min(
            32767,
            Math.round(
              rightSample < 0
                ? rightSample * 32768
                : rightSample * 32767,
            ),
          ),
        );
        const offset = frame * 4;
        pcmView.setInt16(
          offset,
          leftValue,
          true,
        );
        pcmView.setInt16(
          offset + 2,
          rightValue,
          true,
        );
      }

      sendAirPlayAudioFrame({
        data: pcm,
        timestamp: Math.round(
          (
            performance.timeOrigin +
            performance.now()
          ) * 1000,
        ),
      });
      sentFrames += 1;
      if (sentFrames === 1) {
        firstFrameAt =
          performance.now();
      }
      sourcePosition +=
        outputFrames * sourceStep;

      const consumed =
        Math.max(
          0,
          Math.floor(sourcePosition) - 1,
        );
      if (consumed > 0) {
        left.splice(0, consumed);
        right.splice(0, consumed);
        sourcePosition -= consumed;
      }

      if (
        sentFrames === 1 ||
        sentFrames % 500 === 0
      ) {
        const wallDurationMs =
          firstFrameAt
            ? performance.now() -
              firstFrameAt
            : 0;
        const audioDurationMs =
          Math.max(
            0,
            sentFrames - 1,
          ) *
          outputFrames /
          outputRate *
          1000;

        console.log(
          "[AirSpan][renderer-audio-stats] " +
            JSON.stringify({
              sentFrames,
              capturedInputFrames,
              queuedInputFrames:
                Math.max(
                  0,
                  left.length -
                    sourcePosition,
                ),
              inputRate,
              wallDurationMs:
                Math.round(
                  wallDurationMs,
                ),
              audioDurationMs:
                Math.round(
                  audioDurationMs,
                ),
              pacingDriftMs:
                Math.round(
                  wallDurationMs -
                    audioDurationMs,
                ),
            }),
        );
      }
    }
  };

  let processor:
    | AudioWorkletNode
    | ScriptProcessorNode;
  let processorNeedsOutputConnection =
    true;
  let workletUrl = "";
  let captureMode =
    "audio-worklet";

  try {
    if (
      !context.audioWorklet ||
      !("AudioWorkletNode" in window)
    ) {
      throw new Error(
        "AudioWorklet is unavailable.",
      );
    }

    workletUrl =
      URL.createObjectURL(
        new Blob(
          [
            AIRSPAN_AUDIO_WORKLET_SOURCE,
          ],
          {
            type:
              "text/javascript",
          },
        ),
      );

    await context.audioWorklet.addModule(
      workletUrl,
    );

    const worklet =
      new AudioWorkletNode(
        context,
        "airspan-audio-capture",
        {
          numberOfInputs: 1,
          // A zero-output worklet is registered by Chromium as an
          // automatic-pull node. That keeps it on the real audio clock even
          // though AirSpan deliberately does not play the captured audio
          // through the host speakers. Routing an all-zero signal to the
          // normal destination instead causes Chromium's 30-second silent
          // sink optimization to reduce the callback cadence.
          numberOfOutputs: 0,
        },
      );

    worklet.port.onmessage =
      (event) => {
        if (stopped) {
          return;
        }

        const samples =
          event.data instanceof
          Float32Array
            ? event.data
            : new Float32Array(
                event.data,
              );
        const frameCount =
          Math.floor(
            samples.length / 2,
          );
        const inputLeft =
          new Float32Array(
            frameCount,
          );
        const inputRight =
          new Float32Array(
            frameCount,
          );

        for (
          let index = 0;
          index < frameCount;
          index += 1
        ) {
          inputLeft[index] =
            samples[index * 2];
          inputRight[index] =
            samples[
              index * 2 + 1
            ];
        }

        appendInput(
          inputLeft,
          inputRight,
        );
        emitFrames();
      };

    processor = worklet;
    processorNeedsOutputConnection =
      false;
  } catch (workletError) {
    captureMode =
      "script-processor-fallback";

    console.warn(
      "[AirSpan] AudioWorklet capture unavailable; using the compatibility fallback:",
      workletError,
    );

    const scriptProcessor =
      context.createScriptProcessor(
        512,
        2,
        2,
      );

    scriptProcessor.onaudioprocess =
      (event) => {
        if (stopped) {
          return;
        }

        const input =
          event.inputBuffer;
        const inputLeft =
          input.getChannelData(0);
        const inputRight =
          input.numberOfChannels > 1
            ? input.getChannelData(1)
            : inputLeft;

        appendInput(
          inputLeft,
          inputRight,
        );
        emitFrames();
      };

    processor =
      scriptProcessor;
  } finally {
    if (workletUrl) {
      URL.revokeObjectURL(
        workletUrl,
      );
    }
  }

  source.connect(processor);
  if (
    processorNeedsOutputConnection
  ) {
    // ScriptProcessorNode is only a compatibility fallback and must remain
    // connected to the destination in order to receive callbacks.
    silentGain.gain.value = 0;
    processor.connect(silentGain);
    silentGain.connect(
      context.destination,
    );
  }
  await context.resume();

  console.log(
    "[AirSpan] AirPlay audio capture started: " +
      JSON.stringify({
        inputRate,
        outputRate,
        trackLabel:
          track.label,
        captureMode,
        automaticPull:
          !processorNeedsOutputConnection,
      }),
  );

  return () => {
    if (stopped) {
      return;
    }

    stopped = true;
    if (
      processor instanceof
      AudioWorkletNode
    ) {
      processor.port.onmessage =
        null;
    } else {
      processor.onaudioprocess =
        null;
    }
    try {
      source.disconnect();
      if (
        processorNeedsOutputConnection
      ) {
        processor.disconnect();
        silentGain.disconnect();
      }
    } catch {
      // The graph may already have been torn down by Chromium.
    }
    void context.close().catch(() => {
      // Ignore close races during display-track shutdown.
    });
    console.log(
      "[AirSpan] AirPlay audio capture stopped:",
      { sentFrames },
    );
  };
}

export function HostStudio() {
  const [code, setCode] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualityId>("sharp");
  const [audio, setAudio] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [airPlayDevices, setAirPlayDevices] =
  useState<AirPlayDevice[]>([]);
  const [connectingAirPlayId, setConnectingAirPlayId] =
  useState<string | null>(null);
  const [airPlayStatus, setAirPlayStatus] =
  useState<string>("");
  const [isExportingDiagnostics, setIsExportingDiagnostics] =
    useState(false);
  const [diagnosticsStatus, setDiagnosticsStatus] =
    useState("");
  const [airPlayConnection, setAirPlayConnection] =
    useState<AirPlayConnectionState>({
      status: "disconnected",
      deviceId: null,
      name: null,
      message: "Select an AirPlay receiver.",
      connected: false,
      canReconnect: false,
      paired: false,
    });
  const [airPlayPin, setAirPlayPin] =
  useState("");
  const airPlayPinValueRef =
    useRef("");
  const [showAirPlayPin, setShowAirPlayPin] =
  useState(false);
  const [isSubmittingAirPlayPin, setIsSubmittingAirPlayPin] =
    useState(false);
  const [airPlayPairingDeviceId, setAirPlayPairingDeviceId] =
    useState<string | null>(null);
  const [
  airPlayVideoTarget,
  setAirPlayVideoTarget,
] =
  useState<AirPlayVideoTarget | null>(
    null,
  );
  const h264StopRef =
  useRef<
    (() => void) | null
  >(null);
  const airPlayAudioStopRef =
    useRef<
      (() => void) | null
    >(null);
  const airPlayConnectAttemptRef =
    useRef(0);
  const airPlayPinSubmissionRef =
    useRef(false);
  const airPlayPinInputRef =
    useRef<HTMLInputElement | null>(null);
  useEffect(() => {
  return () => {
    h264StopRef.current?.();
    h264StopRef.current =
      null;
    airPlayAudioStopRef.current?.();
    airPlayAudioStopRef.current =
      null;
  };
}, []);
  useEffect(() => {
    airPlayPinValueRef.current =
      airPlayPin;
  }, [airPlayPin]);
  useEffect(() => {
    if (
      !showAirPlayPin &&
      airPlayConnection.status !==
        "pairing"
    ) {
      return;
    }

    const focusTimer =
      window.setTimeout(() => {
        airPlayPinInputRef.current?.focus();
        airPlayPinInputRef.current?.select();
      }, 0);

    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [
    showAirPlayPin,
    airPlayConnection.status,
  ]);
  useEffect(() => {
    if (
      airPlayConnection.status !==
        "pairing"
    ) {
      return;
    }

    // A previous attempt may have left the renderer's submit guard set while
    // the receiver starts a fresh PIN session. Reset it at the pairing
    // boundary so the new code box is always editable.
    airPlayPinSubmissionRef.current =
      false;
    setIsSubmittingAirPlayPin(false);
  }, [
    airPlayConnection.status,
    airPlayConnection.deviceId,
  ]);
  useEffect(() => {
    if (
      airPlayConnection.status !==
        "pairing"
    ) {
      return;
    }

    // Keep pairing usable even when Chromium refuses to give the input a
    // mouse focus after the receiver was forgotten. Digits typed anywhere in
    // the pairing window are routed to the active code field; Enter submits.
    const handlePairingKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (
        isSubmittingAirPlayPin ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (
          event.target instanceof
            HTMLInputElement
        )
      ) {
        return;
      }

      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        const next =
          `${airPlayPinValueRef.current}${event.key}`
            .slice(0, 8);
        airPlayPinValueRef.current =
          next;
        setAirPlayPin(next);
        return;
      }

      if (event.key === "Backspace") {
        event.preventDefault();
        const next =
          airPlayPinValueRef.current.slice(
            0,
            -1,
          );
        airPlayPinValueRef.current =
          next;
        setAirPlayPin(next);
        return;
      }

      if (
        event.key === "Enter" &&
        airPlayPinValueRef.current.length >= 4
      ) {
        event.preventDefault();
        void submitAirPlayPin(
          airPlayPinValueRef.current,
        );
      }
    };

    window.addEventListener(
      "keydown",
      handlePairingKeyDown,
    );
    return () => {
      window.removeEventListener(
        "keydown",
        handlePairingKeyDown,
      );
    };
  }, [
    airPlayConnection.status,
    isSubmittingAirPlayPin,
  ]);
  const session = useDisplaySession({
  room: code ?? "",
  role: "host",
  enabled: Boolean(code),
});
useEffect(() => {
  const bridge = (
    window as Window & {
      airspanDesktop?: {
        getAirPlayDevices?: () =>
          Promise<AirPlayDevice[]>;

        getAirPlayState?: () =>
          Promise<AirPlayConnectionState>;

        onAirPlayDevices?: (
          callback: (
            devices: AirPlayDevice[],
          ) => void,
        ) => () => void;

        onAirPlayState?: (
          callback: (
            state: AirPlayConnectionState,
          ) => void,
        ) => () => void;
      };
    }
  ).airspanDesktop;

  void bridge
    ?.getAirPlayDevices?.()
    .then((devices) => {
      setAirPlayDevices(devices);
    })
    .catch((error) => {
      console.error(
        "[AirSpan] Failed to get AirPlay devices:",
        error,
      );
    });

  void bridge
    ?.getAirPlayState?.()
    .then((state) => {
      setAirPlayConnection(state);
      setAirPlayStatus(
        state.message,
      );
      if (
        state.status === "pairing" &&
        state.deviceId
      ) {
        setShowAirPlayPin(true);
        setAirPlayPairingDeviceId(
          state.deviceId,
        );
      }
    })
    .catch((error) => {
      console.error(
        "[AirSpan] Failed to get AirPlay connection state:",
        error,
      );
    });

  const unsubscribe =
    bridge?.onAirPlayDevices?.((devices) => {
      setAirPlayDevices(devices);
    });
  const unsubscribeState =
    bridge?.onAirPlayState?.((state) => {
      setAirPlayConnection(state);
      setAirPlayStatus(
        state.message,
      );
      if (
        state.status === "pairing" &&
        state.deviceId
      ) {
        setShowAirPlayPin(true);
        setAirPlayPairingDeviceId(
          state.deviceId,
        );
      } else if (
        state.status !== "connecting"
      ) {
        setShowAirPlayPin(false);
        setAirPlayPairingDeviceId(null);
      }

      if (
        [
          "disconnected",
          "offline",
          "error",
        ].includes(state.status)
      ) {
        h264StopRef.current?.();
        h264StopRef.current =
          null;
        airPlayAudioStopRef.current?.();
        airPlayAudioStopRef.current =
          null;
        setAirPlayVideoTarget(null);
      }
    });

  return () => {
    unsubscribe?.();
    unsubscribeState?.();
  };
}, []);

function stopAirPlayMedia() {
  h264StopRef.current?.();
  h264StopRef.current =
    null;
  airPlayAudioStopRef.current?.();
  airPlayAudioStopRef.current =
    null;
}

async function startAirPlayMediaForStream(
  stream: MediaStream,
  target: AirPlayVideoTarget | null,
) {
  stopAirPlayMedia();

  if (!target) {
    return;
  }

  try {
    airPlayAudioStopRef.current =
      await startAirPlayAudioCapture(
        stream,
      );
  } catch (error) {
    airPlayAudioStopRef.current =
      null;
    console.error(
      "[AirSpan] Could not start AirPlay audio capture:",
      error,
    );
  }

  const video =
    stream.getVideoTracks()[0];

  if (
    !video ||
    video.readyState !== "live"
  ) {
    throw new Error(
      "The shared screen is no longer available.",
    );
  }

  if (!("VideoEncoder" in window)) {
    throw new Error(
      "WebCodecs VideoEncoder is unavailable.",
    );
  }

  const settings =
    video.getSettings();
  const captureWidth =
    Math.floor(
      settings.width || 1920,
    );
  const captureHeight =
    Math.floor(
      settings.height || 1080,
    );
  const captureFPS =
    Math.floor(
      settings.frameRate || 60,
    );

  console.log(
    "[AirSpan] Choosing AirPlay H.264 mode:",
    {
      receiver: target,
      capture: {
        width: captureWidth,
        height: captureHeight,
        fps: captureFPS,
      },
    },
  );

  const selectedConfig =
    await chooseAirPlayH264Config(
      target,
      captureWidth,
      captureHeight,
      captureFPS,
    );

  if (!selectedConfig) {
    throw new Error(
      "No compatible H.264 configuration was found for this receiver.",
    );
  }

  console.log(
    "[AirSpan] Selected H.264 configuration:",
    selectedConfig,
  );
  h264StopRef.current =
    await startH264EncoderProbe(
      stream,
      selectedConfig,
    );
}

async function connectAirPlayDevice(
  device: AirPlayDevice,
): Promise<AirPlayVideoTarget | null> {
  const attempt =
    airPlayConnectAttemptRef.current + 1;
  airPlayConnectAttemptRef.current =
    attempt;
  stopAirPlayMedia();
  setConnectingAirPlayId(device.id);
  setAirPlayVideoTarget(null);
  setShowAirPlayPin(false);
  setAirPlayPairingDeviceId(null);
  setAirPlayPin("");

  setAirPlayStatus(
    `Connecting to ${device.name}...`,
  );

  const bridge = (
    window as Window & {
      airspanDesktop?: {
        connectAirPlayDevice?: (
          device: AirPlayDevice,
        ) => Promise<{
  ok: boolean;
  name: string;
  address: string;
  port: number;

  requiresPin?: boolean;
  verified?: boolean;

  videoTarget?:
    AirPlayVideoTarget | null;
        }>;
      };
    }
  ).airspanDesktop;
  let requestStarted = false;

  try {
    if (!bridge?.connectAirPlayDevice) {
      throw new Error(
        "AirPlay connection bridge is unavailable.",
      );
    }

    requestStarted = true;
    const result =
      await bridge.connectAirPlayDevice(device);

    if (
      attempt !==
      airPlayConnectAttemptRef.current
    ) {
      return null;
    }

  if (
  result.ok &&
  result.requiresPin === false
) {
  setAirPlayStatus(
    `Connected to ${result.name}`,
  );

  setShowAirPlayPin(false);
  setAirPlayPairingDeviceId(null);
  setAirPlayPin("");

  const videoTarget =
    result.videoTarget ?? null;
  setAirPlayVideoTarget(
    videoTarget,
  );

console.log(
  "[AirSpan] Receiver video target:",
  result.videoTarget,
);

  if (
    preview &&
    sharing &&
    videoTarget
  ) {
    try {
      await startAirPlayMediaForStream(
        preview,
        videoTarget,
      );
    } catch (error) {
      console.error(
        "[AirSpan] Could not move the active share to the new receiver:",
        error,
      );
      setAirPlayStatus(
        `Connected to ${result.name}, but the active share could not be moved. Stop and restart sharing.`,
      );
    }
  }

  return videoTarget;
}

if (result.ok) {
  setAirPlayStatus(
    `Enter the code shown on ${result.name}`,
  );

  setShowAirPlayPin(true);
  setAirPlayPairingDeviceId(device.id);
  setAirPlayPin("");
}

return null;
  } catch (error) {
    console.error(
      "[AirSpan] AirPlay selection failed:",
      error,
    );

    if (
      attempt ===
        airPlayConnectAttemptRef.current &&
      !requestStarted
    ) {
      setAirPlayStatus(
        `Could not connect to ${device.name}`,
      );
    }
    return null;
  } finally {
    if (
      attempt ===
      airPlayConnectAttemptRef.current
    ) {
      setConnectingAirPlayId(null);
    }
  }
}

async function disconnectAirPlayDevice() {
  const bridge = (
    window as Window & {
      airspanDesktop?: {
        disconnectAirPlayDevice?: () =>
          Promise<{
            ok: boolean;
            name: string | null;
          }>;
      };
    }
  ).airspanDesktop;

  airPlayConnectAttemptRef.current += 1;
  stopAirPlayMedia();
  setAirPlayVideoTarget(null);
  setConnectingAirPlayId(null);
  setShowAirPlayPin(false);
  setAirPlayStatus(
    `Disconnecting from ${airPlayConnection.name || "AirPlay receiver"}...`,
  );

  try {
    if (!bridge?.disconnectAirPlayDevice) {
      throw new Error(
        "AirPlay disconnect bridge is unavailable.",
      );
    }

    await bridge.disconnectAirPlayDevice();
  } catch (error) {
    console.error(
      "[AirSpan] AirPlay disconnect failed:",
      error,
    );
    setAirPlayStatus(
      "Could not disconnect cleanly. The receiver may already be offline.",
    );
  }
}

async function forgetAirPlayDevice(
  device: Pick<
    AirPlayDevice,
    "id" | "name"
  >,
) {
  const confirmed =
    window.confirm(
      `Forget ${device.name}? You will need to enter its AirPlay code again next time.`,
    );

  if (!confirmed) {
    return;
  }

  const bridge = (
    window as Window & {
      airspanDesktop?: {
        forgetAirPlayDevice?: (
          deviceId: string,
        ) => Promise<{
          ok: boolean;
          removed: boolean;
          name: string;
        }>;
      };
    }
  ).airspanDesktop;

  try {
    if (!bridge?.forgetAirPlayDevice) {
      throw new Error(
        "AirPlay pairing management is unavailable.",
      );
    }

    if (
      airPlayConnection.deviceId ===
      device.id
    ) {
      stopAirPlayMedia();
      setAirPlayVideoTarget(null);
    }

    const result =
      await bridge.forgetAirPlayDevice(
        device.id,
      );

    setAirPlayDevices(
      (devices) =>
        devices.map((item) =>
          item.id === device.id
            ? {
                ...item,
                paired: false,
              }
            : item,
        ),
    );
    setShowAirPlayPin(false);
    setAirPlayPairingDeviceId(null);
    setAirPlayPin("");
    setAirPlayStatus(
      result.removed
        ? `Forgot ${result.name}.`
        : `${result.name} was not saved as paired.`,
    );
  } catch (error) {
    console.error(
      "[AirSpan] Could not forget AirPlay receiver:",
      error,
    );
    setAirPlayStatus(
      `Could not forget ${device.name}.`,
    );
  }
}

async function submitAirPlayPin(
  pinOverride?: string,
) {
  if (airPlayPinSubmissionRef.current) {
    return;
  }

  airPlayPinSubmissionRef.current =
    true;

  const bridge = (
    window as Window & {
      airspanDesktop?: {
        submitAirPlayPin?: (
          pin: string,
        ) => Promise<{
          ok: boolean;
          device: string;
          readyForPairSetup: boolean;
        }>;
      };
    }
  ).airspanDesktop;

  try {
    if (!airPlayPairingDeviceId) {
      throw new Error(
        "Select the AirPlay device you want to pair first.",
      );
    }

    if (!bridge?.submitAirPlayPin) {
      throw new Error(
        "AirPlay pairing bridge unavailable.",
      );
    }

    setAirPlayStatus(
      "Checking AirPlay code...",
    );
    setIsSubmittingAirPlayPin(true);

    const result =
      await bridge.submitAirPlayPin(
        pinOverride ?? airPlayPin,
      );

    if (result.ok) {
      setAirPlayStatus(
        `Paired with ${result.device}. Select Reconnect to start mirroring.`,
      );
      setShowAirPlayPin(false);
      setAirPlayPairingDeviceId(null);
      setAirPlayPin("");
    }
  } catch (error) {
    console.error(
      "[AirSpan] AirPlay PIN submission failed:",
      error,
    );

    setAirPlayStatus(
      "Could not submit AirPlay code.",
    );
  } finally {
    airPlayPinSubmissionRef.current =
      false;
    setIsSubmittingAirPlayPin(false);
  }
}


useEffect(() => {
  const roomCode = makeRoomCode();

  console.log(
    "[AirSpan] New pairing code:",
    roomCode,
  );

  setCode(roomCode);
}, []);
  const [pairingOrigin, setPairingOrigin] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const desktopBridge = (window as Window & { airspanDesktop?: { getPairingOrigin?: () => Promise<string> }; }).airspanDesktop;
    void (async () => {
      try {
        const origin = await desktopBridge?.getPairingOrigin?.();
        if (active && origin) setPairingOrigin(origin);
      } catch {
        // Browser/PWA mode has no Electron bridge.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const joinUrl = useMemo(() => {
    if (typeof window === "undefined" || !code) return "";
    const origin = pairingOrigin || window.location.origin;
    return `${origin}/display/${code}`;
  }, [code, pairingOrigin]);

  useEffect(() => {
    return () => {
      preview?.getTracks().forEach((t) => t.stop());
    };
  }, [preview]);

  const connectedDisplays = session.peers.filter(
    (p) => p.connectionState === "connected" && p.name === "display",
  );

  async function startShare() {
  setError(null);

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
  video: true,
  audio,
});

    console.log(
      "[AirSpan] Display capture tracks:",
      stream.getTracks().map((track) => ({
        kind: track.kind,
        label: track.label,
        readyState: track.readyState,
        settings: track.getSettings(),
      })),
    );

    const video = stream.getVideoTracks()[0];

    // A receiver may close its media socket after Stop sharing even though
    // the user is still paired with it. Reconnect the selected paired device
    // before starting the next media session so audio gets fresh sockets and
    // a new clock mapping instead of silently sending into a dead channel.
    let mediaTarget = airPlayVideoTarget;
    if (
      !mediaTarget &&
      airPlayConnection.paired &&
      !airPlayConnection.connected &&
      [
        "disconnected",
        "offline",
        "error",
      ].includes(airPlayConnection.status) &&
      activeAirPlayDevice
    ) {
      try {
        mediaTarget =
          await connectAirPlayDevice(
            activeAirPlayDevice,
          );
      } catch (error) {
        console.error(
          "[AirSpan] Could not reconnect AirPlay before sharing:",
          error,
        );
      }
    }

    if (mediaTarget) {
      try {
        await startAirPlayMediaForStream(
          stream,
          mediaTarget,
        );
      } catch (error) {
        console.error(
          "[AirSpan] Could not start AirPlay media:",
          error,
        );
        setAirPlayStatus(
          "The screen share started, but AirPlay media could not start. Reconnect the receiver and try again.",
        );
      }
    } else {
      console.log(
        "[AirSpan] No AirPlay video target selected; skipping H.264 probe.",
      );
    }

if (video) {
  try {
    
  } catch {
    // Cursor constraint is optional.
  }

  video.addEventListener(
  "ended",
  () => {
    stopAirPlayMedia();

    session.stopShare();

    setSharing(false);
    setPreview(null);
  },
);
}

    setPreview(stream);
    await session.share(stream, quality);
    setSharing(true);
  } catch (err) {
    console.error("[AirSpan] Screen capture failed:", err);
    stopAirPlayMedia();

    const name = err instanceof Error ? err.name : "";

    if (name === "NotAllowedError") {
      setError("Screen sharing was blocked.");
    } else if (name === "NotFoundError") {
      setError("No screen or window was available to capture.");
    } else if (name === "NotSupportedError") {
      setError(
        "Screen capture is not supported by this Electron configuration."
      );
    } else {
      setError(
        err instanceof Error
          ? `Could not start capture: ${err.message}`
          : "Could not start capture."
      );
    }
  }
}

  function stop() {
  stopAirPlayMedia();

  session.stopShare();

  preview
    ?.getTracks()
    .forEach(
      (track) =>
        track.stop(),
    );

  setPreview(null);
  setSharing(false);
}

  async function changeQuality(id: QualityId) {
    setQuality(id);
    if (sharing) await session.applyQuality(id);
  }

  async function exportDiagnostics() {
    const bridge = (
      window as Window & {
        airspanDesktop?: {
          exportDiagnostics?: () => Promise<DiagnosticsExportResult>;
        };
      }
    ).airspanDesktop;

    if (!bridge?.exportDiagnostics) {
      setDiagnosticsStatus("Diagnostic export is unavailable.");
      return;
    }

    setIsExportingDiagnostics(true);
    setDiagnosticsStatus("");
    try {
      const result = await bridge.exportDiagnostics();
      if (!result.canceled && result.ok) {
        setDiagnosticsStatus(`Saved ${result.fileName || "diagnostics ZIP"}.`);
      }
    } catch (exportError) {
      console.error("[AirSpan] Diagnostic export failed:", exportError);
      setDiagnosticsStatus("Could not export diagnostics.");
    } finally {
      setIsExportingDiagnostics(false);
    }
  }

  const activeAirPlayDevice =
    airPlayDevices.find(
      (device) =>
        device.id ===
        airPlayConnection.deviceId,
    );
  const airPlayStateLabel =
    airPlayConnection.status.charAt(0).toUpperCase() +
    airPlayConnection.status.slice(1);
  const isAirPlayBusy =
    connectingAirPlayId !== null ||
    ["connecting", "pairing"].includes(airPlayConnection.status) ||
    isSubmittingAirPlayPin;
  const headerStatusTitle = airPlayConnection.connected
    ? airPlayConnection.name || "AirPlay connected"
    : airPlayConnection.status === "offline"
      ? "Receiver offline"
      : airPlayConnection.status === "error"
        ? "Connection needs attention"
        : "Ready to connect";
  const headerStatusDetail = airPlayConnection.connected
    ? sharing
      ? "Screen and audio are live"
      : "Connected and ready to share"
    : airPlayConnection.message || "Choose an AirPlay receiver";

  return (
    <div className="airspan-app">
      <header className="app-header">
        <div className="brand" aria-label="AirSpan">
          <div className="brand-mark">
            <Radio size={21} strokeWidth={2.2} />
          </div>
          <div className="brand-copy">
            <strong>AirSpan</strong>
            <span>Wireless display studio</span>
          </div>
        </div>

        <nav className="sidebar-steps" aria-label="Streaming workflow">
          <div
            className={`sidebar-step ${airPlayConnection.connected ? "is-complete" : "is-current"}`}
          >
            <span className="sidebar-step-icon">
              {airPlayConnection.connected ? <Check size={15} /> : <Tv size={15} />}
            </span>
            <span>
              <strong>Connect</strong>
              <small>Choose a receiver</small>
            </span>
          </div>
          <div
            className={`sidebar-step ${sharing ? "is-complete" : airPlayConnection.connected ? "is-current" : ""}`}
          >
            <span className="sidebar-step-icon">
              {sharing ? <Check size={15} /> : <MonitorUp size={15} />}
            </span>
            <span>
              <strong>Share</strong>
              <small>Select your screen</small>
            </span>
          </div>
          <div className={`sidebar-step ${sharing ? "is-current" : ""}`}>
            <span className="sidebar-step-icon">
              <Sparkles size={15} />
            </span>
            <span>
              <strong>Enjoy</strong>
              <small>Watch on the big screen</small>
            </span>
          </div>
        </nav>

        <div className="sidebar-support">
          <span className="sidebar-section-label">Support</span>
          <button
            type="button"
            className="sidebar-export-button"
            disabled={isExportingDiagnostics}
            onClick={() => {
              void exportDiagnostics();
            }}
          >
            <span className="sidebar-export-icon">
              <FileArchive size={16} />
            </span>
            <span>
              <strong>
                {isExportingDiagnostics ? "Creating ZIP…" : "Export diagnostics"}
              </strong>
              <small>Redacted support bundle</small>
            </span>
          </button>
          {diagnosticsStatus && (
            <span className="sidebar-export-status" role="status">
              {diagnosticsStatus}
            </span>
          )}
        </div>

        <div
          className="header-status"
          data-state={airPlayConnection.status}
          title={airPlayConnection.message}
        >
          <div className="header-status-icon">
            {airPlayConnection.connected ? (
              <Wifi size={15} />
            ) : ["offline", "error"].includes(airPlayConnection.status) ? (
              <WifiOff size={15} />
            ) : (
              <Radio size={15} />
            )}
          </div>
          <div className="header-status-copy">
            <strong>{headerStatusTitle}</strong>
            <span>{headerStatusDetail}</span>
          </div>
        </div>
      </header>

      <main className="airspan-workspace">
        <div className="workspace-topbar">
          <div>
            <p className="eyebrow">Control center</p>
            <h1>Cast your PC</h1>
            <p>Connect a receiver and start sharing in just a few clicks.</p>
          </div>
          <div className="privacy-note">
            <ShieldCheck size={16} />
            Streams stay on your local network
          </div>
        </div>

        <section className="panel stream-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Screen stream</p>
              <h2>{sharing ? "Your screen is live" : "Share this screen"}</h2>
              <p>
                {sharing
                  ? `Sending video${audio ? " and system audio" : ""} to ${airPlayConnection.name || "your connected display"}.`
                  : "Choose what to share, then AirSpan sends it directly to your receiver."}
              </p>
            </div>
            <div className={`status-badge ${sharing ? "is-live" : ""}`}>
              <i aria-hidden="true" />
              {sharing ? "Live" : "Not sharing"}
            </div>
          </div>

          <div className="preview-stage">
            {preview ? (
              <video
                autoPlay
                muted
                playsInline
                ref={(element) => {
                  if (element && element.srcObject !== preview) {
                    element.srcObject = preview;
                  }
                }}
              />
            ) : (
              <div className="preview-empty">
                <div className="preview-empty-icon">
                  <MonitorUp size={30} />
                </div>
                <h3>Your preview will appear here</h3>
                <p>
                  Share an entire display or a single window. Nothing is sent
                  until you choose what to share.
                </p>
              </div>
            )}

            <div className="preview-corner">
              {airPlayConnection.connected ? (
                <>
                  <Tv size={13} />
                  {airPlayConnection.name}
                </>
              ) : (
                <>
                  <Unplug size={13} />
                  No receiver
                </>
              )}
            </div>
          </div>

          <div className="stream-toolbar">
            <div className="stream-preferences">
              <div>
                <span className="control-group-label">Picture</span>
                <div className="segmented-control" aria-label="Picture quality">
                  <button
                    type="button"
                    className={quality === "sharp" ? "is-active" : ""}
                    aria-pressed={quality === "sharp"}
                    onClick={() => {
                      void changeQuality("sharp");
                    }}
                  >
                    Sharp
                  </button>
                  <button
                    type="button"
                    className={quality === "cinema" ? "is-active" : ""}
                    aria-pressed={quality === "cinema"}
                    onClick={() => {
                      void changeQuality("cinema");
                    }}
                  >
                    Smooth
                  </button>
                </div>
              </div>

              <div>
                <span className="control-group-label">System audio</span>
                <button
                  type="button"
                  className="icon-toggle"
                  aria-label={audio ? "Turn system audio off" : "Turn system audio on"}
                  aria-pressed={audio}
                  title={sharing ? "Stop sharing to change audio capture" : undefined}
                  disabled={sharing}
                  onClick={() => {
                    setAudio((enabled) => !enabled);
                  }}
                >
                  {audio ? <Volume2 size={17} /> : <VolumeX size={17} />}
                </button>
              </div>
            </div>

            {sharing ? (
              <Button variant="danger" onClick={stop} size="lg">
                <X size={17} />
                Stop sharing
              </Button>
            ) : (
              <Button onClick={startShare} size="lg">
                <MonitorUp size={17} />
                Share screen
              </Button>
            )}
          </div>

          {error && (
            <div className="error-banner" role="alert">
              <CircleAlert size={16} />
              <span>{error}</span>
            </div>
          )}
        </section>

        <aside className="control-rail">
          <section className="panel receiver-panel">
            <div className="panel-heading panel-heading-compact">
              <div>
                <p className="eyebrow">AirPlay</p>
                <h2>Receivers</h2>
              </div>
              <span className="device-count" title="Available receivers">
                {airPlayDevices.length}
              </span>
            </div>

            {airPlayConnection.name && (
              <div
                className="active-receiver"
                data-state={airPlayConnection.status}
              >
                <div className="receiver-title-row">
                  <div className="receiver-icon">
                    <Tv size={18} />
                  </div>
                  <div className="receiver-identity">
                    <strong>{airPlayConnection.name}</strong>
                    <span>{airPlayConnection.message}</span>
                  </div>
                  <span className="state-pill">
                    {airPlayConnection.connected && <Check size={11} />}
                    {airPlayStateLabel}
                  </span>
                </div>

                <div className="receiver-actions">
                  {airPlayConnection.connected ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => {
                        void disconnectAirPlayDevice();
                      }}
                    >
                      <Unplug size={15} />
                      Disconnect
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={
                        airPlayConnection.status === "connecting" ||
                        (airPlayConnection.status !== "pairing" &&
                          !activeAirPlayDevice)
                      }
                      onClick={() => {
                        if (airPlayConnection.status === "pairing") {
                          setShowAirPlayPin(true);
                          const enteredPin = window.prompt(
                            `Enter the code shown on ${airPlayConnection.name || "the AirPlay device"}.`,
                            airPlayPin,
                          );
                          if (enteredPin !== null) {
                            setAirPlayPin(enteredPin);
                            void submitAirPlayPin(enteredPin);
                          } else {
                            window.setTimeout(() => {
                              airPlayPinInputRef.current?.focus();
                              airPlayPinInputRef.current?.select();
                            }, 0);
                          }
                        } else if (activeAirPlayDevice) {
                          void connectAirPlayDevice(activeAirPlayDevice);
                        }
                      }}
                    >
                      <Wifi size={15} />
                      {airPlayConnection.status === "pairing"
                        ? "Enter code"
                        : activeAirPlayDevice
                          ? "Reconnect"
                          : "Receiver unavailable"}
                    </button>
                  )}

                  {airPlayConnection.paired &&
                    airPlayConnection.deviceId && (
                      <button
                        type="button"
                        className="button button-secondary danger-link"
                        onClick={() => {
                          void forgetAirPlayDevice({
                            id: airPlayConnection.deviceId as string,
                            name:
                              airPlayConnection.name || "AirPlay receiver",
                          });
                        }}
                      >
                        Forget
                      </button>
                    )}
                </div>

                {airPlayConnection.connected && (
                  <div className="volume-note">
                    <Volume2 size={13} />
                    Adjust playback volume on the receiver.
                  </div>
                )}
              </div>
            )}

            <p className="devices-label">
              {airPlayConnection.name ? "Other available devices" : "Available devices"}
            </p>

            <div className="device-list">
              {airPlayDevices.length === 0 ? (
                <div className="empty-devices">
                  <div className="search-wave">
                    <Radio size={16} />
                  </div>
                  <span>Searching automatically for nearby AirPlay devices…</span>
                </div>
              ) : (
                airPlayDevices.map((device) => {
                  const isCurrent =
                    airPlayConnection.deviceId === device.id;
                  const isConnected =
                    isCurrent && airPlayConnection.connected;
                  const isThisConnecting =
                    connectingAirPlayId === device.id ||
                    (isCurrent &&
                      airPlayConnection.status === "connecting");

                  return (
                    <div
                      key={device.id}
                      className={`device-row ${isConnected ? "is-connected" : ""}`}
                    >
                      <button
                        type="button"
                        className="device-select"
                        disabled={isAirPlayBusy || isConnected}
                        onClick={() => {
                          void connectAirPlayDevice(device);
                        }}
                      >
                        <span className="device-icon">
                          <Tv size={16} />
                        </span>
                        <span className="device-copy">
                          <span className="device-name-line">
                            <span className="device-name">
                              {isThisConnecting ? "Connecting…" : device.name}
                            </span>
                            {device.paired && (
                              <span className="paired-badge">Paired</span>
                            )}
                          </span>
                          <span className="device-meta">
                            {isConnected
                              ? "Currently connected"
                              : airPlayConnection.connected
                                ? "Select to switch"
                                : device.manufacturer ||
                                  device.model ||
                                  "AirPlay receiver"}
                          </span>
                        </span>
                        {!isConnected && (
                          <ChevronRight
                            className="device-chevron"
                            size={15}
                          />
                        )}
                      </button>

                      {device.paired && !isCurrent && (
                        <button
                          type="button"
                          className="forget-icon-button"
                          disabled={isAirPlayBusy}
                          aria-label={`Forget ${device.name}`}
                          title={`Forget ${device.name}`}
                          onClick={() => {
                            void forgetAirPlayDevice(device);
                          }}
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {airPlayStatus && !airPlayConnection.name && (
              <div className="status-note">
                <Radio size={14} />
                <span>{airPlayStatus}</span>
              </div>
            )}
          </section>

          <section className="panel display-panel">
            <div className="panel-heading panel-heading-compact">
              <div>
                <p className="eyebrow">Browser display</p>
                <h2>Connect another screen</h2>
              </div>
              {connectedDisplays.length > 0 && (
                <span className="state-pill">
                  <Check size={11} />
                  Connected
                </span>
              )}
            </div>

            <div className="display-connect-grid">
              {joinUrl ? (
                <QrPanel value={joinUrl} />
              ) : (
                <div className="qr-frame">
                  <Link2 size={22} color="#45617f" />
                </div>
              )}

              <div className="display-connect-copy">
                {code ? (
                  <PairingCode code={code} />
                ) : (
                  <div className="room-code">
                    <span>Display code</span>
                    •••••
                  </div>
                )}
                {joinUrl && (
                  <div className="address-row">
                    <span className="address-value">{joinUrl}</span>
                    <button
                      type="button"
                      className="copy-button"
                      aria-label="Copy display address"
                      title="Copy address"
                      onClick={() => {
                        void navigator.clipboard.writeText(joinUrl);
                      }}
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                )}
              </div>
            </div>

            <p className="display-help">
              Scan from another device, or open the address there and enter
              the five-character code.
            </p>
          </section>
        </aside>
      </main>

      {(showAirPlayPin || airPlayConnection.status === "pairing") && (
        <div
          className="pairing-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="airplay-pin-title"
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
        >
          <div
            className="pairing-dialog"
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="pairing-icon">
              <ShieldCheck size={22} />
            </div>
            <h2 id="airplay-pin-title">
              Pair with {airPlayConnection.name || "AirPlay device"}
            </h2>
            <p>
              Enter the code shown on your receiver. You can also type the
              digits immediately and press Enter.
            </p>

            <input
              ref={airPlayPinInputRef}
              className="pairing-input"
              value={airPlayPin}
              onChange={(event) => {
                setAirPlayPin(
                  event.target.value.replace(/\D/g, "").slice(0, 8),
                );
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  airPlayPin.length >= 4 &&
                  !isSubmittingAirPlayPin
                ) {
                  event.preventDefault();
                  void submitAirPlayPin();
                }
              }}
              disabled={isSubmittingAirPlayPin}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              aria-label="AirPlay pairing code"
              placeholder="0000"
              autoFocus
            />

            <div className="pairing-actions">
              <button
                type="button"
                className="button button-ghost"
                disabled={isSubmittingAirPlayPin}
                onClick={() => {
                  void disconnectAirPlayDevice();
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={
                  airPlayPin.length < 4 || isSubmittingAirPlayPin
                }
                onClick={() => {
                  void submitAirPlayPin();
                }}
              >
                {isSubmittingAirPlayPin ? (
                  <>
                    <Sparkles size={15} />
                    Pairing…
                  </>
                ) : (
                  <>
                    <ShieldCheck size={15} />
                    Pair receiver
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
