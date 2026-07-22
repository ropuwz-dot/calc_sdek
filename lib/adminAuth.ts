import "server-only";

import { isDiagnosticsAdmin } from "@/lib/adminPolicy";
import { readSession } from "@/lib/session";

export type DiagnosticsAdminResult =
  | { ok: true; email: string; name?: string }
  | { ok: false; status: 401 | 404; message: string };

export async function requireDiagnosticsAdmin(): Promise<DiagnosticsAdminResult> {
  const session = await readSession();
  if (!session) {
    return { ok: false, status: 401, message: "Требуется вход через Google." };
  }
  if (!isDiagnosticsAdmin(session.email)) {
    return { ok: false, status: 404, message: "Страница не найдена." };
  }
  return { ok: true, email: session.email, name: session.name };
}
