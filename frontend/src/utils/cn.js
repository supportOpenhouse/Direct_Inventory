// Minimal classnames joiner — stands in for shadcn's `cn` (we don't use
// clsx / tailwind-merge). Filters falsy values and space-joins the rest.
export const cn = (...parts) => parts.filter(Boolean).join(' ');
