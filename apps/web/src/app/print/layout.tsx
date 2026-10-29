// Bare layout for printable pages (no sidebar).
export default function PrintLayout({ children }: LayoutProps<'/print'>) {
  return <main className="mx-auto max-w-5xl bg-white p-6 print:max-w-none print:p-0">{children}</main>;
}
