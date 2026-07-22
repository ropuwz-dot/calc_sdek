import assert from "node:assert/strict";
import test from "node:test";

import { AdminDiagnosticsButton } from "../components/AdminDiagnosticsButton";

test("shows a prominent diagnostics button for rop.uwz@gmail.com", () => {
  const element = AdminDiagnosticsButton({ email: " ROP.UWZ@GMAIL.COM " });

  assert.notEqual(element, null);
  assert.equal(element?.props.className, "admin-diagnostics-action");

  const link = element?.props.children;
  assert.equal(link.props.href, "/admin/diagnostics");
  assert.equal(link.props.className, "button");
  assert.equal(link.props.children, "Диагностика ошибок");
});

test("does not show the diagnostics button to other users", () => {
  assert.equal(AdminDiagnosticsButton({ email: "manager@example.com" }), null);
});
