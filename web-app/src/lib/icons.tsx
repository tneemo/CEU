// Stroke icons, 16px grid, 1.5 stroke — same set as web/js/icons.js.
const P: Record<string, string> = {
  new: '<path d="M8 3.5v9M3.5 8h9"/>',
  search: '<circle cx="7.2" cy="7.2" r="4.2"/><path d="m10.4 10.4 3.1 3.1"/>',
  settings: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
  sidebar: '<rect x="2" y="2.8" width="12" height="10.4" rx="2"/><path d="M6 2.8v10.4"/>',
  menu: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>',
  "chevron-down": '<path d="m4.5 6.2 3.5 3.6 3.5-3.6"/>',
  "chevron-right": '<path d="m6.2 4.5 3.6 3.5-3.6 3.5"/>',
  "chevron-left": '<path d="M9.8 4.5 6.2 8l3.6 3.5"/>',
  "arrow-up": '<path d="M8 13V3.5M3.8 7.6 8 3.4l4.2 4.2"/>',
  "arrow-down": '<path d="M8 3v9.5M3.8 8.4 8 12.6l4.2-4.2"/>',
  stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none"/>',
  attach: '<path d="m13.2 7.6-5.1 5.1a3.2 3.2 0 0 1-4.5-4.5l5.4-5.4a2.1 2.1 0 0 1 3 3L6.6 11.2a1.1 1.1 0 0 1-1.5-1.5l4.7-4.7"/>',
  copy: '<rect x="5.2" y="5.2" width="8.3" height="8.3" rx="1.8"/><path d="M10.8 5.2V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5.3A1.5 1.5 0 0 0 4 10.8h1.2"/>',
  check: '<path d="m3.2 8.4 3 3 6.6-6.8"/>',
  retry: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.8v3h-3"/>',
  edit: '<path d="M10.3 2.9a1.6 1.6 0 0 1 2.3 2.3L5.5 12.3l-3 .7.7-3Z"/>',
  more: '<circle cx="3.6" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.4" cy="8" r=".9" fill="currentColor"/>',
  pin: '<path d="M9.8 2.2 13.8 6.2l-2.3.8-2.4 2.4-.3 3-5-5 3-.3 2.4-2.4Z"/><path d="m5.4 10.6-3 3"/>',
  unpin: '<path d="M9.8 2.2 13.8 6.2l-2.3.8-2.4 2.4-.3 3-5-5 3-.3 2.4-2.4Z"/><path d="m5.4 10.6-3 3M2.5 2.5l11 11"/>',
  trash: '<path d="M2.8 4.3h10.4M6.4 4.3V2.9h3.2v1.4M4.2 4.3l.6 8.4a1.2 1.2 0 0 0 1.2 1.1h4a1.2 1.2 0 0 0 1.2-1.1l.6-8.4"/>',
  rename: '<path d="M2.5 13.5h11M9.6 3.1a1.4 1.4 0 0 1 2 2L6.2 10.5l-2.6.6.6-2.6Z"/>',
  download: '<path d="M8 2.5v8M4.5 7.2 8 10.7l3.5-3.5M2.8 13.5h10.4"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  alert: '<path d="M8 2.2 14.2 13H1.8Z"/><path d="M8 6.4v3M8 11.2v.1"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.6v1.3M8 13.1v1.3M1.6 8h1.3M13.1 8h1.3M3.5 3.5l.9.9M11.6 11.6l.9.9M3.5 12.5l.9-.9M11.6 4.4l.9-.9"/>',
  moon: '<path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z"/>',
  keyboard: '<rect x="1.8" y="3.8" width="12.4" height="8.4" rx="1.6"/><path d="M4.4 6.4h.1M6.8 6.4h.1M9.2 6.4h.1M11.6 6.4h.1M5 9.6h6"/>',
  chat: '<path d="M2.6 4.4A1.8 1.8 0 0 1 4.4 2.6h7.2a1.8 1.8 0 0 1 1.8 1.8v5a1.8 1.8 0 0 1-1.8 1.8H6.8l-3 2.4v-2.4h0a1.2 1.2 0 0 1-1.2-1.2Z"/>',
  cube: '<path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5Z"/><path d="M2.5 5 8 8.2 13.5 5M8 8.2v6" opacity=".6"/>',
  sliders: '<path d="M2.5 4.5h6.5M12 4.5h1.5M2.5 11.5H4M7 11.5h6.5"/><circle cx="10.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/>',
  text: '<path d="M3 3.5h10M8 3.5v9"/>',
  plug: '<path d="M5.5 2.5v3M10.5 2.5v3M3.8 5.5h8.4v2a4.2 4.2 0 0 1-8.4 0ZM8 11.7v2"/>',
  database: '<ellipse cx="8" cy="3.8" rx="5" ry="1.8"/><path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.4"/><circle cx="4.5" cy="12.5" r="1.4"/><circle cx="11.5" cy="5.5" r="1.4"/><path d="M4.5 4.9v6.2M11.5 6.9c0 2.4-2 3-4.2 3.4-1.4.3-2.8.7-2.8 2.2"/>',
  file: '<path d="M4 1.8h5.2L12.5 5v9.2H4Z"/><path d="M9 1.8V5h3.5"/>',
  external: '<path d="M9.5 2.5h4v4M13.5 2.5 7.8 8.2M11.5 9.5v3.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V5.3a.8.8 0 0 1 .8-.8h3.2"/>',
  archive: '<rect x="2" y="2.8" width="12" height="3" rx=".8"/><path d="M3 5.8v6.4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.8M6.4 8.6h3.2"/>',
  unarchive: '<rect x="2" y="2.8" width="12" height="3" rx=".8"/><path d="M3 5.8v6.4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.8M8 12V8.2M6.4 9.6 8 8l1.6 1.6"/>',
  filter: '<path d="M2.5 4h11M4.5 8h7M6.5 12h3"/>',
  "thumb-up": '<path d="M5.2 7.2 7.6 2.6a1.5 1.5 0 0 1 1.9 1.7l-.4 2.3h3.3a1.3 1.3 0 0 1 1.3 1.6l-1 4.2a1.3 1.3 0 0 1-1.3 1H5.2ZM5.2 7.2H3a.8.8 0 0 0-.8.8v4.8a.8.8 0 0 0 .8.8h2.2"/>',
  "thumb-down": '<path d="M10.8 8.8 8.4 13.4a1.5 1.5 0 0 1-1.9-1.7l.4-2.3H3.6a1.3 1.3 0 0 1-1.3-1.6l1-4.2a1.3 1.3 0 0 1 1.3-1h6.2ZM10.8 8.8H13a.8.8 0 0 0 .8-.8V3.2a.8.8 0 0 0-.8-.8h-2.2"/>',
  speaker: '<path d="M2.5 6.2h2.2L8 3.4v9.2L4.7 9.8H2.5Z"/><path d="M10.4 5.8a3 3 0 0 1 0 4.4M12.2 4a5.6 5.6 0 0 1 0 8"/>',
  ghost: '<path d="M3.5 13.5V7a4.5 4.5 0 0 1 9 0v6.5l-1.5-1.2-1.5 1.2L8 12.3l-1.5 1.2L5 12.3Z"/><path d="M6.3 7h.1M9.6 7h.1"/>',
  bell: '<path d="M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1.2 1.3H2.8ZM6.6 14h2.8"/>',
  memory: '<path d="M5.6 2.8a2.3 2.3 0 0 0-2.3 2.3v.2a2.3 2.3 0 0 0-.6 4 2.4 2.4 0 0 0 2.7 3.6A2.3 2.3 0 0 0 8 13.2V3.9a2.2 2.2 0 0 0-2.4-1.1ZM10.4 2.8a2.3 2.3 0 0 1 2.3 2.3v.2a2.3 2.3 0 0 1 .6 4 2.4 2.4 0 0 1-2.7 3.6A2.3 2.3 0 0 1 8 13.2"/>',
  palette: '<path d="M8 2a6 6 0 0 0 0 12c.9 0 1.3-.6 1.3-1.2 0-.9-.8-1.2-.8-2 0-.6.5-1 1.1-1h1.6A2.8 2.8 0 0 0 14 7.1C14 4.3 11.3 2 8 2Z"/><circle cx="5" cy="7.6" r=".8" fill="currentColor"/><circle cx="7.2" cy="4.9" r=".8" fill="currentColor"/><circle cx="10.4" cy="5.2" r=".8" fill="currentColor"/>',
  user: '<circle cx="8" cy="5.4" r="2.6"/><path d="M2.8 13.6a5.2 5.2 0 0 1 10.4 0"/>',
  gauge: '<path d="M2.4 11.5a6 6 0 1 1 11.2 0"/><path d="m8 9.4 2.6-3.1"/><circle cx="8" cy="9.6" r=".9" fill="currentColor"/>',
  code: '<path d="M5.4 4.6 2 8l3.4 3.4M10.6 4.6 14 8l-3.4 3.4M9 3.2 7 12.8"/>',
  tools: '<path d="M9.8 2.6a3 3 0 0 0-3.4 4L2.8 10.2a1.4 1.4 0 0 0 2 2l3.6-3.6a3 3 0 0 0 4-3.4l-1.8 1.8-1.7-.4-.4-1.7Z"/>',
  voice: '<rect x="6" y="2" width="4" height="7.5" rx="2"/><path d="M3.6 7.8a4.4 4.4 0 0 0 8.8 0M8 12.2v1.8"/>',
};

export type IconName = keyof typeof P;

/** SVG markup string — for HTML produced outside React (markdown code blocks). */
export function iconHtml(name: string) {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;
}

export function Icon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: P[name] || "" }}
    />
  );
}

/** `<span class="ic">` wrapper used across menus, buttons and cards. */
export function Ic({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span className={"ic " + className}>
      <Icon name={name} />
    </span>
  );
}
