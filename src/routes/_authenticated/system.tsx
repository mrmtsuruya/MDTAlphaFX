import { createFileRoute } from "@tanstack/react-router";
import { Cpu, HardDrive, MemoryStick, Wifi, Thermometer } from "lucide-react";

export const Route = createFileRoute("/_authenticated/system")({
  head: () => ({
    meta: [
      { title: "System Monitor — MDTAlphaFX" },
      { name: "description", content: "Local system telemetry — CPU, GPU, memory, disk, network." },
      { property: "og:title", content: "System Monitor — MDTAlphaFX" },
      { property: "og:description", content: "Local system telemetry — CPU, GPU, memory, disk, network." },
    ],
  }),
  component: System,
});

function bar(label: string, value: number, tone: "long" | "short" | "accent" | "warn", extra?: string) {
  const color = { long: "bg-neon-long", short: "bg-neon-short", accent: "bg-neon-accent", warn: "bg-neon-warn" }[tone];
  return (
    <div className="rounded-lg border border-cyber-border bg-cyber-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase text-muted-foreground">{label}</span>
        <span className="font-mono text-xs text-white">{value}% {extra}</span>
      </div>
      <div className="mt-3 h-2 rounded bg-cyber-border overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function System() {
  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// SYSTEM_MONITOR</div>
        <h1 className="text-2xl font-bold text-white">System Monitor</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Local hardware telemetry preview. Browsers can't read CPU/GPU temps directly — this UI mocks the layout. A tiny native agent (Python/Rust) posting to a local endpoint or an OS-level webhook can populate real values.
        </p>
      </header>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {bar("CPU LOAD", 42, "accent")}
        {bar("CPU TEMP", 58, "warn", "°C")}
        {bar("MEMORY", 67, "accent", "· 21.4GB/32GB")}
        {bar("GPU LOAD", 24, "accent")}
        {bar("GPU TEMP", 51, "warn", "°C")}
        {bar("VRAM", 38, "accent")}
        {bar("DISK C:", 71, "warn", "· 710/1000GB")}
        {bar("NETWORK ▲", 12, "long", "· 1.2 MB/s")}
        {bar("NETWORK ▼", 34, "long", "· 3.4 MB/s")}
      </div>

      <div className="rounded-lg border border-cyber-border bg-cyber-surface p-4">
        <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
          <Cpu className="size-3" /> CPU: AMD Ryzen 9 7950X · <Thermometer className="size-3" /> 58°C · <MemoryStick className="size-3" /> DDR5 32GB · <HardDrive className="size-3" /> NVMe 2TB · <Wifi className="size-3" /> 1Gbps
        </div>
      </div>
    </div>
  );
}
