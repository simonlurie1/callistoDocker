import { STATUSES } from "../types";

interface Props {
  status: string;
  source: string;
  onStatusChange: (v: string) => void;
  onSourceChange: (v: string) => void;
  onApply: () => void;
  onClear: () => void;
  onRefresh: () => void;
}

export function Filters({ status, source, onStatusChange, onSourceChange, onApply, onClear, onRefresh }: Props) {
  return (
    <div className="filters">
      <label>
        Status
        <select value={status} onChange={(e) => onStatusChange(e.target.value)}>
          <option value="">all</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label>
        Source
        <input value={source} onChange={(e) => onSourceChange(e.target.value)} placeholder="facebook" />
      </label>
      <button onClick={onApply}>Apply</button>
      <button type="button" className="secondary" onClick={onClear}>
        Clear
      </button>
      <button type="button" className="secondary" onClick={onRefresh}>
        Refresh
      </button>
    </div>
  );
}
