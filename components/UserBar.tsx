/**
 * Плашка текущего пользователя с кнопкой выхода.
 * Серверный компонент: получает только имя/email — никаких токенов.
 */
export function UserBar({ email, name }: { email: string; name?: string }) {
  return (
    <div className="user-bar">
      <span>
        {name ? `${name} — ` : ""}
        <code>{email}</code>
      </span>
      <form action="/api/auth/signout" method="post">
        <button type="submit" className="button secondary">
          Выйти
        </button>
      </form>
    </div>
  );
}
