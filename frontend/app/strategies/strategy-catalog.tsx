"use client";

import { useMemo, useState } from "react";
import { strategyModules } from "../data";

const pillars = ["All", "SMC / ICT", "Price action", "Trend & momentum", "Volatility"] as const;

export function StrategyCatalog() {
  const [pillar, setPillar] = useState<(typeof pillars)[number]>("All");
  const [query, setQuery] = useState("");

  const filtered = useMemo(
    () =>
      strategyModules.filter((module) => {
        const matchesPillar = pillar === "All" || module.pillar === pillar;
        const matchesQuery =
          !query ||
          module.name.toLowerCase().includes(query.toLowerCase()) ||
          module.detects.toLowerCase().includes(query.toLowerCase());
        return matchesPillar && matchesQuery;
      }),
    [pillar, query],
  );

  return (
    <>
      <div className="catalog-toolbar">
        <div className="filter-tabs">
          {pillars.map((item) => (
            <button
              type="button"
              className={pillar === item ? "active" : ""}
              onClick={() => setPillar(item)}
              key={item}
            >
              {item}
            </button>
          ))}
        </div>
        <label className="search-field">
          <span>Search</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a module…"
          />
        </label>
      </div>

      <div className="strategy-grid">
        {filtered.map((module) => (
          <article className="strategy-card" key={module.id}>
            <div className="strategy-card-top">
              <span className="module-id">{String(module.id).padStart(2, "0")}</span>
              <span className="stage-badge">STAGE 2 PENDING</span>
            </div>
            <h2>{module.name}</h2>
            <p>{module.detects}</p>
            <div className="strategy-meta">
              <span>{module.pillar}</span>
              <span>Cluster {module.cluster}</span>
            </div>
            <div className="module-foot">
              <span className="status-dot warning" />
              Interface reserved · no detector implementation
            </div>
          </article>
        ))}
      </div>

      {!filtered.length ? (
        <div className="empty-state">
          <strong>No modules match that filter.</strong>
          <button type="button" onClick={() => { setPillar("All"); setQuery(""); }}>
            Reset filters
          </button>
        </div>
      ) : null}
    </>
  );
}
