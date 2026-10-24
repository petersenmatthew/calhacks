export function money(cents: number | null | undefined, opts: { cents?: boolean; sign?: boolean } = {}) {
  if (cents === null || cents === undefined) return "—";
  const showCents = opts.cents ?? true;
  const abs = Math.abs(cents) / 100;
  const body = abs.toLocaleString("en-US", {
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  });
  const sign = cents < 0 ? "-" : opts.sign && cents > 0 ? "+" : "";
  return sign + "$" + body;
}

export function compactMoney(cents: number) {
  const v = cents / 100;
  if (Math.abs(v) >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (Math.abs(v) >= 10_000) return "$" + (v / 1_000).toFixed(1) + "K";
  return money(cents, { cents: false });
}

export function hours(h: number | null | undefined) {
  if (h === null || h === undefined) return "—";
  return (Math.round(h * 100) / 100).toLocaleString("en-US") + " h";
}

export function pct(x: number, digits = 1) {
  return (x * 100).toFixed(digits) + "%";
}

const dtf = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
const tf = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const df = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function dateTimeUtc(iso: string | null | undefined) {
  if (!iso) return "—";
  return dtf.format(new Date(iso)) + " UTC";
}

export function clockTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return tf.format(new Date(iso));
}

export function dateOnly(iso: string | null | undefined) {
  if (!iso) return "—";
  return df.format(new Date(iso));
}

export function relativeTime(iso: string | null | undefined, now: number) {
  if (!iso) return "—";
  if (!now) return clockTime(iso);
  const diff = Math.max(0, now - Date.parse(iso));
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function periodLabel(period: string, short = false) {
  const [y, m] = period.split("-").map(Number);
  const name = MONTHS[(m ?? 1) - 1] ?? period;
  return (short ? name.slice(0, 3) : name) + " " + y;
}

export function titleCase(s: string) {
  return s
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
