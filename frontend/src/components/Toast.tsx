import { CircleCheck, CircleAlert, X } from "lucide-react";
import { useEffect } from "react";

interface ToastProps {
  message: string;
  kind?: "success" | "error" | "info";
  onClose: () => void;
}

export function Toast({ message, kind = "info", onClose }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 4200);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);

  const Icon = kind === "error" ? CircleAlert : CircleCheck;
  return (
    <div className={`toast toast-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <Icon size={18} aria-hidden="true" />
      <span>{message}</span>
      <button type="button" aria-label="Dismiss notification" onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  );
}
