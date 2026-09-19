import {
  useEffect,
  useRef,
  useState,
} from "react";

type SignalState = {
  offer: RTCSessionDescriptionInit | null;
  answer: RTCSessionDescriptionInit | null;
  hostCandidates: RTCIceCandidateInit[];
  viewerCandidates: RTCIceCandidateInit[];
  viewerReady: boolean;
};

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302",
    },
  ],
};

function candidateKey(
  candidate: RTCIceCandidateInit,
) {
  return [
    candidate.candidate,
    candidate.sdpMid,
    candidate.sdpMLineIndex,
  ].join("|");
}

async function postSignal(
  room: string,
  action: string,
  data: Record<string, unknown> = {},
) {
  const response = await fetch(
    `/airspan/signal/${encodeURIComponent(room)}/${action}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(
      `Signaling ${action} failed: ${response.status}`
    );
  }
}

async function getSignalState(
  room: string,
): Promise<SignalState> {
  const response = await fetch(
    `/airspan/signal/${encodeURIComponent(room)}/state`,
    {
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(
      `Could not read signaling state: ${response.status}`
    );
  }

  return response.json();
}

export function DisplayReceiver({
  code,
}: {
  code: string;
}) {
  const room =
    code.toUpperCase();

  const videoRef =
    useRef<HTMLVideoElement | null>(
      null
    );

  const [stream, setStream] =
    useState<MediaStream | null>(
      null
    );

  const [status, setStatus] =
    useState("Waiting for PC…");

  const [error, setError] =
    useState<string | null>(
      null
    );

  useEffect(() => {
    let active = true;

    let peer:
      | RTCPeerConnection
      | null = null;

    let currentOfferSdp = "";

    const seenHostCandidates =
      new Set<string>();

    async function createPeerForOffer(
      offer:
        RTCSessionDescriptionInit,
    ) {
      if (!active) {
        return;
      }

      if (peer) {
        peer.close();
      }

      seenHostCandidates.clear();

      const nextPeer =
        new RTCPeerConnection(
          RTC_CONFIG
        );

      peer = nextPeer;

      setStatus(
        "Connecting to PC…"
      );

      // -------------------------
      // SEND MAC ICE TO PC
      // -------------------------

      nextPeer.onicecandidate =
        (event) => {
          if (!event.candidate) {
            return;
          }

          void postSignal(
            room,
            "ice",
            {
              side: "viewer",
              candidate:
                event.candidate.toJSON(),
            },
          ).catch(console.error);
        };

      // -------------------------
      // RECEIVE SCREEN STREAM
      // -------------------------

      nextPeer.ontrack =
        (event) => {
          const remoteStream =
            event.streams[0] ??
            new MediaStream(
              [event.track]
            );

          if (!active) {
            return;
          }

          setStream(
            remoteStream
          );

          setStatus(
            "Connected"
          );
        };

      nextPeer.onconnectionstatechange =
        () => {
          if (!active) {
            return;
          }

          console.log(
            "[AirSpan Display] connection:",
            nextPeer.connectionState
          );

          if (
            nextPeer.connectionState ===
            "connected"
          ) {
            setStatus(
              "Connected"
            );
          } else if (
            nextPeer.connectionState ===
              "failed" ||
            nextPeer.connectionState ===
              "disconnected"
          ) {
            setStatus(
              "Connection lost"
            );
          }
        };

      // -------------------------
      // ACCEPT PC OFFER
      // -------------------------

      await nextPeer.setRemoteDescription(
        offer
      );

      const answer =
        await nextPeer.createAnswer();

      await nextPeer.setLocalDescription(
        answer
      );

      await postSignal(
        room,
        "answer",
        {
          description:
            nextPeer.localDescription,
        },
      );

      currentOfferSdp =
        offer.sdp ?? "";
    }

    async function poll() {
      try {
        const state =
          await getSignalState(
            room
          );

        if (!active) {
          return;
        }

        // New host share started.
        if (
          state.offer &&
          state.offer.sdp &&
          state.offer.sdp !==
            currentOfferSdp
        ) {
          await createPeerForOffer(
            state.offer
          );
        }

        // -------------------------
        // RECEIVE PC ICE
        // -------------------------

        if (
          peer &&
          peer.remoteDescription
        ) {
          for (
            const candidate
            of state.hostCandidates || []
          ) {
            const key =
              candidateKey(
                candidate
              );

            if (
              seenHostCandidates.has(
                key
              )
            ) {
              continue;
            }

            try {
              await peer.addIceCandidate(
                candidate
              );

              seenHostCandidates.add(
                key
              );
            } catch (error) {
              console.warn(
                "[AirSpan Mac] ICE candidate failed",
                error
              );
            }
          }
        }
      } catch (err) {
        console.error(
          "[AirSpan Mac] signaling error",
          err
        );

        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : "Connection error"
          );
        }
      }
    }

    void postSignal(
      room,
      "viewer-ready"
    )
      .then(() => {
        setStatus(
          "Waiting for PC to share…"
        );
      })
      .catch((err) => {
        setError(
          err instanceof Error
            ? err.message
            : "Could not join room"
        );
      });

    void poll();

    const timer =
      window.setInterval(
        () => {
          void poll();
        },
        350,
      );

    return () => {
      active = false;

      window.clearInterval(
        timer
      );

      peer?.close();
    };
  }, [room]);

  useEffect(() => {
    const video =
      videoRef.current;

    if (
      !video ||
      !stream
    ) {
      return;
    }

    video.srcObject =
      stream;

    void video
      .play()
      .catch(() => {});
  }, [stream]);

  async function enterFullscreen() {
    try {
      await videoRef.current
        ?.requestFullscreen();
    } catch {
      // Ignore unsupported fullscreen.
    }
  }

  return (
    <main
      style={{
        margin: 0,
        minHeight: "100vh",
        background: "#000",
        color: "#fff",
        fontFamily:
          "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          padding:
            "12px 18px",
          display: "flex",
          justifyContent:
            "space-between",
          alignItems: "center",
          background: "#111",
        }}
      >
        <div>
          <strong>
            AirSpan Display
          </strong>

          <div
            style={{
              color: "#aaa",
              fontSize: "12px",
              marginTop: "3px",
            }}
          >
            Room {room} · {status}
          </div>
        </div>

        {stream && (
          <button
            onClick={
              enterFullscreen
            }
            style={{
              border: 0,
              borderRadius:
                "8px",
              padding:
                "8px 14px",
              cursor:
                "pointer",
            }}
          >
            Full screen
          </button>
        )}
      </header>

      <section
        style={{
          flex: 1,
          display: "flex",
          alignItems:
            "center",
          justifyContent:
            "center",
          background: "#000",
        }}
      >
        {stream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            style={{
              display:
                "block",
              width: "100%",
              height:
                "calc(100vh - 64px)",
              objectFit:
                "contain",
              background:
                "#000",
            }}
          />
        ) : (
          <div
            style={{
              textAlign:
                "center",
              padding: "40px",
            }}
          >
            <h2>
              {status}
            </h2>

            <p
              style={{
                color: "#999",
              }}
            >
              Keep this page
              open while
              AirSpan connects.
            </p>

            {error && (
              <p
                style={{
                  color:
                    "#ef4444",
                }}
              >
                {error}
              </p>
            )}
          </div>
        )}
      </section>
    </main>
  );
}