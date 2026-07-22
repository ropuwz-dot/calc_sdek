import { isDiagnosticsAdmin } from "@/lib/adminPolicy";

export function AdminDiagnosticsButton({ email }: { email: string }) {
  if (!isDiagnosticsAdmin(email)) return null;

  return (
    <div className="admin-diagnostics-action">
      <a href="/admin/diagnostics" className="button">
        Диагностика ошибок
      </a>
    </div>
  );
}
