import { useState } from "react";
import { STATUSES } from "../types";
import type { ApiError, ConversionEvent, Lead, LeadStatus } from "../types";
import { changeLeadStatus, deleteLead, fetchConversionEvent } from "../api";

interface Props {
  leads: Lead[];
  onChanged: () => void;
  onShowConversion: (event: ConversionEvent) => void;
}

export function LeadsTable({ leads, onChanged, onShowConversion }: Props) {
  const [pendingStatus, setPendingStatus] = useState<Record<number, LeadStatus>>({});

  function selectedStatus(lead: Lead): LeadStatus {
    return pendingStatus[lead.id] ?? lead.status;
  }

  async function handleSetStatus(lead: Lead) {
    const status = selectedStatus(lead);
    try {
      const result = await changeLeadStatus(lead.id, status);
      onChanged();
      if (result.conversionEvent) {
        onShowConversion(result.conversionEvent);
      }
    } catch (err) {
      const apiErr = err as ApiError;
      alert(`Could not change status: ${apiErr.error}${apiErr.errors ? "\n" + JSON.stringify(apiErr.errors, null, 2) : ""}`);
    }
  }

  async function handleDelete(lead: Lead) {
    if (!confirm(`Delete lead #${lead.id}?`)) return;
    await deleteLead(lead.id);
    onChanged();
  }

  async function handleShowConversion(leadId: number) {
    const event = await fetchConversionEvent(leadId);
    if (event) onShowConversion(event);
  }

  return (
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Name</th>
          <th>Contact</th>
          <th>Source</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {leads.map((lead) => (
          <tr key={lead.id}>
            <td>{lead.id}</td>
            <td>{lead.name}</td>
            <td>{[lead.email, lead.phone].filter(Boolean).join(" / ") || "—"}</td>
            <td>{lead.source ?? "—"}</td>
            <td>{lead.amount != null ? `${lead.amount} ${lead.currency ?? ""}`.trim() : "—"}</td>
            <td>
              <span className={`status-badge status-${lead.status}`}>{lead.status}</span>
            </td>
            <td className="row-actions">
              <select
                value={selectedStatus(lead)}
                onChange={(e) =>
                  setPendingStatus((prev) => ({ ...prev, [lead.id]: e.target.value as LeadStatus }))
                }
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button onClick={() => handleSetStatus(lead)}>Set status</button>
              {lead.status === "converted" && (
                <button className="secondary" onClick={() => handleShowConversion(lead.id)}>
                  Conversion
                </button>
              )}
              <button className="secondary" onClick={() => handleDelete(lead)}>
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
