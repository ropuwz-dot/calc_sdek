import { NextRequest, NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import { loadCatalog, searchProducts } from "@/lib/catalog";
import type { ProductSuggestion } from "@/lib/types";

/** Поиск товара по части артикула или наименования. */
export async function GET(request: NextRequest) {
  const user = await requireSheetsUser();
  if (!user.ok) {
    return NextResponse.json(
      { ok: false, message: user.message },
      { status: user.status }
    );
  }

  const q = request.nextUrl.searchParams.get("q") ?? "";
  if (q.trim().length < 2) {
    return NextResponse.json({ ok: true, products: [] });
  }

  const result = await loadCatalog(user.accessToken);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, message: result.message },
      { status: 502 }
    );
  }

  const products: ProductSuggestion[] = searchProducts(result.catalog, q).map(
    (p) => ({
      article: p.article,
      name: p.name,
      unitDataComplete:
        p.lengthCm !== null &&
        p.widthCm !== null &&
        p.heightCm !== null &&
        p.weightKg !== null &&
        p.lengthCm > 0 &&
        p.widthCm > 0 &&
        p.heightCm > 0 &&
        p.weightKg > 0,
      ruleQtys: (result.catalog.rules[p.article] ?? [])
        .map((r) => r.qty)
        .sort((a, b) => a - b),
    })
  );

  return NextResponse.json({ ok: true, products });
}
