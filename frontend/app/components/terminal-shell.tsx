"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { engineBoundary } from "../engine-boundary";

const navigation = [
  { href: "/", label: "Market Overview", icon: "⌘" },
  { href: "/signals", label: "Signal Center", icon: "↗" },
  { href: "/chart", label: "Chart", icon: "▥" },
  { href: "/strategies", label: "Strategies", icon: "≋" },
  { href: "/backtester", label: "Backtester", icon: "∿" },
];

export function TerminalShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="terminal-shell">
      <aside className={`terminal-sidebar ${menuOpen ? "is-open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark">αFX</div>
          <div>
            <strong>MDTAlphaFX</strong>
            <span>v2 · operator console</span>
          </div>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          {navigation.map((item) => {
            const active =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                href={item.href}
                key={item.href}
                className={active ? "active" : ""}
                onClick={() => setMenuOpen(false)}
              >
                <span className="nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                {item.label}
                <span className="nav-arrow" aria-hidden="true">
                  ›
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-spacer" />
        <div className="engine-status">
          <div className="status-line">
            <span className="status-dot warning" />
            {engineBoundary.statusLabel}
          </div>
          <dl>
            <div>
              <dt>Data</dt>
              <dd>{engineBoundary.dataSource}</dd>
            </div>
            <div>
              <dt>Execution</dt>
              <dd>{engineBoundary.execution}</dd>
            </div>
            <div>
              <dt>Config</dt>
              <dd>{engineBoundary.configVersion}</dd>
            </div>
          </dl>
        </div>
      </aside>

      <div className="terminal-workspace">
        <header className="mobile-header">
          <button
            className="menu-button"
            type="button"
            aria-label="Toggle navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            {menuOpen ? "×" : "☰"}
          </button>
          <div className="mobile-brand">αFX <strong>MDTAlphaFX</strong></div>
          <span className="mode-badge">SIM</span>
        </header>

        <div className="simulation-banner">
          <span>{engineBoundary.interfaceLabel}</span>
          Generated values are for UI development only. No live price feed, strategy
          modules, or order routing is connected.
        </div>

        <main className="terminal-main">{children}</main>
      </div>

      {menuOpen ? (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          type="button"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  subtitle,
  className = "",
  children,
  action,
}: {
  title?: string;
  subtitle?: string;
  className?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className={`panel ${className}`}>
      {title ? (
        <header className="panel-header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function RegimeBadge({ regime }: { regime: string }) {
  return (
    <span className={`regime-badge regime-${regime.toLowerCase()}`}>
      {regime.replace("_NEWS", "")}
    </span>
  );
}

export function ScoreBar({
  value,
  label = "Score",
}: {
  value: number;
  label?: string;
}) {
  const tone = value >= 80 ? "high" : value >= 70 ? "mid" : "low";
  return (
    <div className="score-bar">
      <div>
        <span>{label}</span>
        <strong className={`score-${tone}`}>{value}</strong>
      </div>
      <div className="score-track" aria-label={`${label}: ${value} out of 100`}>
        <span className={tone} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
