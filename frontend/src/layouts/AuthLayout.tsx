import { useState } from "react";
import type { PropsWithChildren } from "react";

import { InfoModal } from "../components/InfoModal";

const footerCopy: Record<string, string> = {
  "Privacy Policy":
    "The LumaChat frontend is a prototype. Privacy policy content and production data-retention details have not been published yet.",
  "Terms of Service":
    "Terms of Service content has not been published yet. Do not use this prototype for sensitive or production communication.",
  Help: "For now, use the project's README and development notes for setup help. A support channel is not configured.",
};

export function AuthLayout({ children }: PropsWithChildren) {
  const [modal, setModal] = useState<string | null>(null);
  return (
    <main className="auth-page">
      <div className="auth-glow auth-glow-one" aria-hidden="true" />
      <div className="auth-glow auth-glow-two" aria-hidden="true" />
      <div className="auth-shell">
        <div className="auth-main">{children}</div>
        <footer className="auth-footer">
          <span>© {new Date().getFullYear()} LumaChat</span>
          <nav aria-label="Footer">
            {Object.keys(footerCopy).map((label) => (
              <button
                type="button"
                key={label}
                onClick={() => setModal(label)}
                className="text-link footer-link"
              >
                {label}
              </button>
            ))}
          </nav>
        </footer>
      </div>
      {modal && (
        <InfoModal
          title={modal}
          onClose={() => setModal(null)}
        >
          {footerCopy[modal]}
        </InfoModal>
      )}
    </main>
  );
}
