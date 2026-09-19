import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type QualityId = "sharp" | "cinema";

type DisplaySessionOptions = {
  room: string;
  role: "host";
  enabled: boolean;
};

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

function candidateKey(candidate: RTCIceCandidateInit) {
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

export function useDisplaySession({
  room,
  role: _role,
  enabled,
}: DisplaySessionOptions) {
  const peerRef =
    useRef<RTCPeerConnection | null>(null);

  const pollTimerRef =
    useRef<number | null>(null);

  const pollingRef = useRef(false);

  const seenViewerCandidates =
    useRef(new Set<string>());

  const [connectionState, setConnectionState] =
    useState<string>("new");

  const [stats] = useState({
    rttMs: 0,
    bitrateKbps: 0,
  });

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(
        pollTimerRef.current
      );

      pollTimerRef.current = null;
    }

    pollingRef.current = false;
  }, []);

  const pollSignalState =
    useCallback(async () => {
      if (
        !enabled ||
        !room ||
        pollingRef.current
      ) {
        return;
      }

      const peer = peerRef.current;

      if (!peer || peer.signalingState === "closed") {
        return;
      }

      pollingRef.current = true;

      try {
        const state =
          await getSignalState(room);

        // -------------------------
        // RECEIVE ANSWER FROM MAC
        // -------------------------

        if (
          state.answer &&
          !peer.remoteDescription &&
          peer.signalingState ===
            "have-local-offer"
        ) {
          await peer.setRemoteDescription(
            state.answer
          );

          console.log(
            "[AirSpan WebRTC] Mac answer received"
          );
        }

        // -------------------------
        // RECEIVE MAC ICE
        // -------------------------

        if (peer.remoteDescription) {
          for (
            const candidate
            of state.viewerCandidates || []
          ) {
            const key =
              candidateKey(candidate);

            if (
              seenViewerCandidates.current.has(
                key
              )
            ) {
              continue;
            }

            try {
              await peer.addIceCandidate(
                candidate
              );

              seenViewerCandidates.current.add(
                key
              );
            } catch (error) {
              console.warn(
                "[AirSpan WebRTC] Could not add viewer ICE candidate",
                error
              );
            }
          }
        }
      } catch (error) {
        console.warn(
          "[AirSpan WebRTC] Signaling poll failed",
          error
        );
      } finally {
        pollingRef.current = false;
      }
    }, [enabled, room]);

  const applyQuality =
    useCallback(
      async (quality: QualityId) => {
        const peer = peerRef.current;

        if (!peer) {
          return;
        }

        const sender =
          peer
            .getSenders()
            .find(
              (item) =>
                item.track?.kind === "video"
            );

        const track = sender?.track;

        if (!track) {
          return;
        }

        try {
          track.contentHint =
            quality === "cinema"
              ? "motion"
              : "detail";

          await track.applyConstraints({
            frameRate:
              quality === "cinema"
                ? {
                    ideal: 60,
                    max: 60,
                  }
                : {
                    ideal: 30,
                    max: 30,
                  },
          });
        } catch (error) {
          console.warn(
            "[AirSpan WebRTC] Quality change failed",
            error
          );
        }
      },
      [],
    );

  const stopShare =
    useCallback(() => {
      stopPolling();

      const peer = peerRef.current;

      if (peer) {
        peer.onicecandidate = null;
        peer.onconnectionstatechange = null;
        peer.close();
      }

      peerRef.current = null;

      seenViewerCandidates.current.clear();

      setConnectionState("closed");

      if (room) {
        void postSignal(
          room,
          "reset"
        ).catch(() => {});
      }
    }, [room, stopPolling]);

  const share =
    useCallback(
      async (
        stream: MediaStream,
        quality: QualityId,
      ) => {
        if (!enabled || !room) {
          throw new Error(
            "No AirSpan room is active."
          );
        }

        // Close an existing WebRTC connection
        // without stopping the captured MediaStream.
        stopPolling();

        if (peerRef.current) {
          peerRef.current.close();
          peerRef.current = null;
        }

        seenViewerCandidates.current.clear();

        await postSignal(
          room,
          "reset"
        );

        const peer =
          new RTCPeerConnection(
            RTC_CONFIG
          );

        peerRef.current = peer;

        setConnectionState("connecting");

        // -------------------------
        // SEND WINDOWS SCREEN
        // -------------------------

        for (
          const track
          of stream.getTracks()
        ) {
          peer.addTrack(
            track,
            stream
          );
        }

        // -------------------------
        // SEND PC ICE TO MAC
        // -------------------------

        peer.onicecandidate = (
          event
        ) => {
          if (!event.candidate) {
            return;
          }

          void postSignal(
            room,
            "ice",
            {
              side: "host",
              candidate:
                event.candidate.toJSON(),
            },
          ).catch((error) => {
            console.warn(
              "[AirSpan WebRTC] Could not send host ICE",
              error
            );
          });
        };

        peer.onconnectionstatechange =
          () => {
            console.log(
              "[AirSpan WebRTC] PC connection:",
              peer.connectionState
            );

            setConnectionState(
              peer.connectionState
            );
          };

        // -------------------------
        // CREATE OFFER
        // -------------------------

        const offer =
          await peer.createOffer();

        await peer.setLocalDescription(
          offer
        );

        await postSignal(
          room,
          "offer",
          {
            description:
              peer.localDescription,
          },
        );

        console.log(
          "[AirSpan WebRTC] Offer created for",
          room
        );

        await applyQuality(
          quality
        );

        // -------------------------
        // WAIT FOR MAC ANSWER
        // -------------------------

        pollTimerRef.current =
          window.setInterval(
            () => {
              void pollSignalState();
            },
            350,
          );

        void pollSignalState();
      },
      [
        applyQuality,
        enabled,
        pollSignalState,
        room,
        stopPolling,
      ],
    );

  useEffect(() => {
    return () => {
      stopPolling();

      if (peerRef.current) {
        peerRef.current.close();
        peerRef.current = null;
      }
    };
  }, [stopPolling]);

  return {
    peers:
      connectionState === "connected"
        ? [
            {
              connectionState:
                "connected",
              name: "display",
            },
          ]
        : [],
    stats,
    connectionState,
    share,
    stopShare,
    applyQuality,
  };
}