import { FormEvent, useState } from "react";
import { CURRENCIES } from "../types";
import { createLead } from "../api";
import type { ApiError } from "../types";

export function LeadForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [source, setSource] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("");
  const [error, setError] = useState<string>("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await createLead({
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        source: source.trim() || undefined,
        amount: amount ? Number(amount) : undefined,
        currency: currency || undefined,
      });
      setName("");
      setEmail("");
      setPhone("");
      setSource("");
      setAmount("");
      setCurrency("");
      onCreated();
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.errors ? JSON.stringify(apiErr.errors) : apiErr.error ?? "failed to create lead");
    }
  }

  return (
    <section className="card">
      <h2>New lead</h2>
      <form onSubmit={handleSubmit}>
        <div className="field-row">
          <label>
            Name <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Source
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="facebook / google / manual"
            />
          </label>
        </div>
        <div className="field-row">
          <label>
            Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Phone <input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
        </div>
        <div className="field-row">
          <label>
            Amount
            <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label>
            Currency
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="">—</option>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit">Create lead</button>
        {error && <span className="error">{error}</span>}
      </form>
    </section>
  );
}
