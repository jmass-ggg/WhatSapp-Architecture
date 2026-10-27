import type { PropsWithChildren } from "react";

interface AppLayoutProps extends PropsWithChildren {
  className?: string;
}

export function AppLayout({ children, className = "" }: AppLayoutProps) {
  return <main className={`app-frame ${className}`.trim()}>{children}</main>;
}
