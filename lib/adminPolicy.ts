import "server-only";

export const DIAGNOSTICS_ADMIN_EMAIL = "rop.uwz@gmail.com";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isDiagnosticsAdmin(email: string | null | undefined): boolean {
  return typeof email === "string" && normalizeEmail(email) === DIAGNOSTICS_ADMIN_EMAIL;
}
