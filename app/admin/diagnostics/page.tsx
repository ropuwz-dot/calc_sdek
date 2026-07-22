import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { UserBar } from "@/components/UserBar";
import { requireDiagnosticsAdmin } from "@/lib/adminAuth";
import { getRecentCarrierDiagnostics, runAllCarrierDiagnostics } from "@/lib/runCarrierDiagnostics";
import DiagnosticsPanel from "./DiagnosticsPanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Диагностика перевозчиков",
  robots: { index: false, follow: false },
};

export default async function DiagnosticsPage() {
  const admin = await requireDiagnosticsAdmin();
  if (!admin.ok) notFound();
  const checks = await runAllCarrierDiagnostics();
  const events = getRecentCarrierDiagnostics(100);

  return (
    <main>
      <h1>Диагностика перевозчиков</h1>
      <p className="subtitle">
        <Link href="/">← На главную</Link>
        {" · "}закрытая административная страница
      </p>
      <UserBar email={admin.email} name={admin.name} />
      <DiagnosticsPanel initialChecks={checks} initialEvents={events} />
    </main>
  );
}
