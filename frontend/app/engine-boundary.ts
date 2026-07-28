export const engineBoundary = Object.freeze({
  mode: "SIMULATION",
  interfaceLabel: "SIMULATION INTERFACE",
  connected: false,
  statusLabel: "ENGINE DISCONNECTED",
  dataSource: "SIM SNAPSHOT",
  execution: "OFF",
  configVersion: "ffc670e8179c",
  liveApiBaseUrl: null,
});

export type EngineBoundary = typeof engineBoundary;
