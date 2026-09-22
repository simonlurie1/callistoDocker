import { useCallback, useEffect, useState } from "react";
import { LeadForm } from "./components/LeadForm";
import { LeadsTable } from "./components/LeadsTable";
import { Filters } from "./components/Filters";
import { ConversionDetail } from "./components/ConversionDetail";
import { fetchLeads } from "./api";
import type { ApiError, ConversionEvent, Lead } from "./types";

export default function App() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [appliedFilters, setAppliedFilters] = useState({ status: "", source: "" });
  const [selectedEvent, setSelectedEvent] = useState<ConversionEvent | null>(null);
  const [loadError, setLoadError] = useState("");

  const reload = useCallback(async () => {
    try {
      setLeads(await fetchLeads(appliedFilters));
      setLoadError("");
    } catch (err) {
      const apiErr = err as ApiError;
      setLoadError(apiErr.error ?? "could not load leads (is the api running?)");
    }
  }, [appliedFilters]);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <>
      <header>
        <h1>Callisto Mini CRM</h1>
        <p className="subtitle">Leads &amp; conversion tracking</p>
      </header>

      <main>
        <LeadForm onCreated={reload} />

        <section className="card">
          <h2>Leads</h2>
          <Filters
            status={status}
            source={source}
            onStatusChange={setStatus}
            onSourceChange={setSource}
            onApply={() => setAppliedFilters({ status, source })}
            onClear={() => {
              setStatus("");
              setSource("");
              setAppliedFilters({ status: "", source: "" });
            }}
            onRefresh={reload}
          />
          {loadError && <p className="error">{loadError}</p>}
          <LeadsTable leads={leads} onChanged={reload} onShowConversion={setSelectedEvent} />
        </section>

        <ConversionDetail event={selectedEvent} />
      </main>
    </>
  );
}
