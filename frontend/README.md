# Openhouse · Direct Inventory — frontend

Revamped frontend for the Direct Inventory portal. React 18 + Vite + hand-written
CSS (no UI library). Premium real-estate look, orange (`#fa541c`) / black / white,
left-sidebar navigation, and a persisted light/dark theme toggle.

## Run

```bash
npm install
npm run dev      # http://localhost:5174
```

The backend is built later. Until then the app ships with a **mock data layer**
so every screen is browsable:

- On the login screen, use **"continue as (demo)"** to enter as Admin / Manager / RM.
- All `/api/...` calls resolve from `src/api/mock.js`.

Flip to the real API by setting `VITE_USE_MOCKS=false` in `.env` (see `.env.example`).
Even with mocks off, a failed network call falls back to mocks during local dev.

## Stack

- **React 18 + react-router-dom v6** — SPA, role-guarded routes.
- **@react-oauth/google** — Google sign-in (same as the old portal).
- **Plain CSS** — one design-system file, `src/styles.css`, themed via CSS
  variables on `[data-theme]`.

## Structure

```
src/
  api/        client.js (fetch + mock fallback), mock.js (in-memory backend)
  contexts/   AuthContext (incl. dev sign-in), ThemeContext (light/dark)
  utils/      format.js (stages, prices, dates), reportFilters.js (date presets, CSV)
  components/ Layout (sidebar+topbar), InventoryBoard/InventoryTable, ExpandPanel,
              NoteThread, FilterPanel, AddInventoryModal, NotificationBell,
              CardDetailModal, SearchableMultiSelect, UserEditModal,
              UserReportAnalytics, Placeholder, icons
  pages/      Home, Leads, FollowUps, Pipeline, PostToken, Rejected,
              Report, ReportDetail, Users, Logs, Login
```

## Pages (sidebar)

| Page        | Status      | Notes |
|-------------|-------------|-------|
| Home        | ✅ built     | Board view (4 quadrants: Leads / Follow Ups / Pipeline / Post Token) + Table view toggle (default Board). Table view = full inventory board with search, filters, stage pills, and click-to-expand rows. |
| Leads       | ✅ built     | Split view: **Unacted** (status `lead`, NEW badge if added today; columns Star / Society / Link / Action [Qualified \| Reject→reason]) and **Qualified** (status `qualified`; columns Society/BHK/Floor/Area/Asking/OH Price/Variation). Draggable divider (25–75%). Row click → expand Property / Seller / Notes. |
| Follow Ups  | 🚧 placeholder | Flow to be defined. |
| Pipeline    | 🚧 placeholder | Flow to be defined. |
| Post Token  | 🚧 placeholder | Pulled from a separate DB table later. |
| Rejected    | ✅ functional | Inventory board scoped to rejected leads. |
| Report      | ✅ built     | Same flow as the old "User Report" (per-user summary + analytics tab). Admin/Manager only. |
| My Report   | ✅ built     | RMs see their own report (same detail view). |
| Users       | ✅ built     | Same flow as old "Users" (CRUD + role + manager + area scope). Admin only. |
| Logs        | ✅ built     | Same flow as old "Activity". Admin only. |

## API contract

Reuses the original Flask endpoints (`/api/inventory`, `/api/inventory/counts`,
`/api/inventory/:id`, `/api/inventory/:id/notes`, `/api/users`, `/api/activity*`,
`/api/auth/*`, `/api/inventory/notifications`, …) plus two new aggregate
endpoints the backend should implement:

- `GET /api/home/summary` — the four Home quadrants in one scoped response.
- `GET /api/post-token/counts` — post-token stage counts (separate DB).

New reject reasons for the Leads flow: `ground_floor`, `listing_removed`, `duplicate`.
New stage `lead` (unacted intake) precedes `qualified` (acted).
