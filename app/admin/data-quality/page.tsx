import Link from "next/link";
import { readSession } from "@/lib/session";
import { getValidAccessToken } from "@/lib/googleAuth";
import { loadCatalog, type CatalogIssue } from "@/lib/catalog";
import { UserBar } from "@/components/UserBar";

export const dynamic = "force-dynamic";

function IssueTable({ issues }: { issues: CatalogIssue[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Лист</th>
            <th>Строка</th>
            <th>Проблема</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue, i) => (
            <tr key={i}>
              <td>{issue.sheet}</td>
              <td>{issue.rowNumber}</td>
              <td style={{ whiteSpace: "normal" }}>{issue.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function DataQualityPage() {
  const session = await readSession();
  if (!session) {
    return (
      <main>
        <h1>Качество данных справочника</h1>
        <p className="subtitle">
          <Link href="/">← На главную</Link>
        </p>
        <div className="card">
          <h2>Вы не авторизованы</h2>
          <a href="/api/auth/signin" className="button">
            Войти через Google
          </a>
        </div>
      </main>
    );
  }

  const accessToken = await getValidAccessToken(session);
  if (!accessToken) {
    return (
      <main>
        <h1>Качество данных справочника</h1>
        <p className="subtitle">
          <Link href="/">← На главную</Link>
        </p>
        <UserBar email={session.email} name={session.name} />
        <div className="card">
          <h2>Сессия истекла</h2>
          <a href="/api/auth/signin" className="button">
            Войти через Google
          </a>
        </div>
      </main>
    );
  }

  const result = await loadCatalog(accessToken, { fresh: true });

  return (
    <main>
      <h1>Качество данных справочника</h1>
      <p className="subtitle">
        <Link href="/">← На главную</Link>
        {" · "}
        <Link href="/admin/google-sheets-check">диагностика доступа</Link>
      </p>
      <UserBar email={session.email} name={session.name} />

      {!result.ok ? (
        <div className="card">
          <h2>
            Не удалось прочитать таблицу{" "}
            <span className="status error">ошибка</span>
          </h2>
          <div className="error-message">{result.message}</div>
        </div>
      ) : (
        <>
          <div className="card">
            <h2>Таблица «{result.catalog.spreadsheetTitle}»</h2>
            <div className="stat-grid">
              <div className="stat">
                <div className="stat-value">{result.catalog.stats.productCount}</div>
                <div className="stat-label">товаров в справочнике</div>
              </div>
              <div className="stat">
                <div className="stat-value">{result.catalog.stats.productsComplete}</div>
                <div className="stat-label">с полными данными (ДШВ + вес)</div>
              </div>
              <div className="stat">
                <div className="stat-value">{result.catalog.stats.productsWithoutWeight}</div>
                <div className="stat-label">без веса</div>
              </div>
              <div className="stat">
                <div className="stat-value">{result.catalog.stats.productsWithoutDims}</div>
                <div className="stat-label">без ДШВ</div>
              </div>
              <div className="stat">
                <div className="stat-value">{result.catalog.stats.ruleCount}</div>
                <div className="stat-label">правил групповой упаковки</div>
              </div>
              <div className="stat">
                <div className="stat-value">{result.catalog.stats.articlesWithRules}</div>
                <div className="stat-label">артикулов с правилами</div>
              </div>
              <div className="stat">
                <div className="stat-value">{result.catalog.stats.packingOnlyArticles}</div>
                <div className="stat-label">артикулов только в упаковке (нет в справочнике)</div>
              </div>
              <div className="stat">
                <div className="stat-value">{result.catalog.stats.compositeArticleCount}</div>
                <div className="stat-label">составных артикулов</div>
              </div>
              <div className="stat">
                <div className="stat-value">{result.catalog.stats.compositePlaceCount}</div>
                <div className="stat-label">мест в составе комплектов</div>
              </div>
            </div>
            <p className="meta-line">
              Найдено блоков: справочник — {result.catalog.stats.catalogBlocks},
              групповая упаковка — {result.catalog.stats.packingBlocks},
              расчётные/тестовые (пропущены) —{" "}
              {result.catalog.stats.skippedCalcBlocks}.
            </p>
          </div>

          <div className="card">
            <h2>
              Дубли артикулов{" "}
              <span
                className={`status ${result.catalog.duplicateArticles.length === 0 ? "ok" : "error"}`}
              >
                {result.catalog.duplicateArticles.length}
              </span>
            </h2>
            {result.catalog.duplicateArticles.length > 0 ? (
              <div className="chip-list">
                {result.catalog.duplicateArticles.map((a) => (
                  <span key={a} className="chip empty">
                    {a}
                  </span>
                ))}
              </div>
            ) : (
              <p className="meta-line">Дублей не найдено.</p>
            )}
          </div>

          <div className="card">
            <h2>
              Проблемные строки{" "}
              <span
                className={`status ${result.catalog.issues.length === 0 ? "ok" : "error"}`}
              >
                {result.catalog.issues.length}
              </span>
            </h2>
            {result.catalog.issues.length > 0 ? (
              <IssueTable issues={result.catalog.issues} />
            ) : (
              <p className="meta-line">Проблем не найдено.</p>
            )}
          </div>

          <div className="card">
            <h2>
              Подозрительные значения{" "}
              <span
                className={`status ${result.catalog.suspicious.length === 0 ? "ok" : "error"}`}
              >
                {result.catalog.suspicious.length}
              </span>
            </h2>
            <p className="meta-line">
              Нулевые/отрицательные значения, габариты больше 5 м, вес больше
              2 т, упаковки больше 10 000 шт.
            </p>
            {result.catalog.suspicious.length > 0 ? (
              <IssueTable issues={result.catalog.suspicious} />
            ) : (
              <p className="meta-line">Подозрительных значений не найдено.</p>
            )}
          </div>
        </>
      )}
    </main>
  );
}
