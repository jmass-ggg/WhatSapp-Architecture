import { Search, X } from "lucide-react";
import { useId } from "react";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  className?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  className = "",
}: SearchInputProps) {
  const inputId = useId();
  return (
    <label className={`search-input ${className}`.trim()} htmlFor={inputId}>
      <Search size={17} aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <input
        id={inputId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
      />
      {value && (
        <button
          type="button"
          className="search-clear"
          aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => onChange("")}
        >
          <X size={14} />
        </button>
      )}
    </label>
  );
}
