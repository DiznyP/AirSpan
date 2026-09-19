const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("airspanDesktop", {
  getPairingOrigin: () =>
    ipcRenderer.invoke("airspan:get-pairing-origin"),

  getAirPlayDevices: () =>
    ipcRenderer.invoke("airspan:get-airplay-devices"),

  getAirPlayState: () =>
    ipcRenderer.invoke("airspan:get-airplay-state"),

  exportDiagnostics: () =>
    ipcRenderer.invoke("airspan:export-diagnostics"),

  connectAirPlayDevice: (device) =>
    ipcRenderer.invoke(
      "airspan:connect-airplay-device",
      device,
    ),
    submitAirPlayPin: (pin) =>
  ipcRenderer.invoke(
    "airspan:submit-airplay-pin",
    pin,
  ),
  disconnectAirPlayDevice: () =>
    ipcRenderer.invoke(
      "airspan:disconnect-airplay-device",
    ),
  forgetAirPlayDevice: (deviceId) =>
    ipcRenderer.invoke(
      "airspan:forget-airplay-device",
      deviceId,
    ),
sendAirPlayVideoCodec: (payload) => {
  ipcRenderer.send(
    "airspan:airplay-video-codec",
    payload,
  );
},

sendAirPlayVideoFrame: (payload) => {
  ipcRenderer.send(
    "airspan:airplay-video-frame",
    payload,
  );
},

sendAirPlayAudioFrame: (payload) => {
  ipcRenderer.send(
    "airspan:airplay-audio-frame",
    payload,
  );
},
  onAirPlayDevices: (callback) => {
    const listener = (_event, devices) => {
      callback(devices);
    };

    ipcRenderer.on(
      "airspan:airplay-devices",
      listener,
    );

    return () => {
      ipcRenderer.removeListener(
        "airspan:airplay-devices",
        listener,
      );
    };
  },
  onAirPlayState: (callback) => {
    const listener = (_event, state) => {
      callback(state);
    };

    ipcRenderer.on(
      "airspan:airplay-state",
      listener,
    );

    return () => {
      ipcRenderer.removeListener(
        "airspan:airplay-state",
        listener,
      );
    };
  },
});
