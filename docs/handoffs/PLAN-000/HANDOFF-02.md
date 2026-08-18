# PLAN-000 — Handoff 02

## Powód rewizji

Pierwsza próba uruchomienia Claude Code komendą `continue` nie rozpoczęła RA-001,
ponieważ Claude Code automatycznie ładuje `CLAUDE.md`, a repozytorium posiadało
dotąd wyłącznie natywne dla Codex `AGENTS.md`.

## Zmiana

- dodano root `CLAUDE.md` importujący `AGENTS.md`;
- zapisano wprost, że `continue` jest komendą repozytoryjnego workflow i nie
  wymaga poprzedniej historii chatu;
- wskazano dokumenty do odczytania oraz początkowy task RA-001;
- zaznaczono, że brak uwierzytelnienia opcjonalnego MCP nie blokuje RA-001;
- README opisuje kompatybilny bootstrap Claude Code.

## Oczekiwane zachowanie

W nowej sesji Claude Code uruchomionej w katalogu RemoteAgent wiadomość
`continue` prowadzi do odczytania trwałego stanu, oznaczenia RA-001 jako
`IN_PROGRESS` i rozpoczęcia implementacji repo foundation.

