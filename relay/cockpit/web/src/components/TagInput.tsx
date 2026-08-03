// A tag/chip input for editing a list of values (e.g. a tool card's required
// params). Type + Enter (or comma) adds a removable chip; Backspace on an
// empty input pops the last one; pasting "a, b" splits into chips. Duplicates
// are skipped and empties dropped. Controlled — the parent owns the array.
import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  "aria-label"?: string;
}

export default function TagInput({ value, onChange, placeholder, "aria-label": ariaLabel }: TagInputProps) {
  const [text, setText] = useState("");

  const commit = (raw: string) => {
    const tags = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (tags.length === 0) return;
    setText("");
    // de-dupe against what's already committed
    const fresh = tags.filter((t) => !value.includes(t));
    if (fresh.length > 0) onChange([...value, ...fresh]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(text);
    } else if (e.key === "Backspace" && text === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 bg-primary/5 border border-outline rounded px-2 py-1.5 min-h-[38px] focus-within:border-primary/50">
      {value.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 bg-surface border border-outline rounded px-1.5 py-0.5 text-label-sm text-on-surface"
        >
          {t}
          <button
            type="button"
            aria-label={`remove ${t}`}
            onClick={() => onChange(value.filter((x) => x !== t))}
            className="text-on-surface-variant hover:text-on-surface transition-colors"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(text)}
        placeholder={value.length === 0 ? placeholder : ""}
        aria-label={ariaLabel}
        className="flex-1 min-w-[120px] bg-transparent outline-none text-body-medium text-on-surface placeholder:text-on-surface-variant"
      />
    </div>
  );
}
