import { googleJson } from "./auth.js";

const CAL_BASE = "https://www.googleapis.com/calendar/v3";

export async function listCalendars(token: string) {
  const body = await googleJson<{
    items?: Array<{
      id: string;
      summary?: string;
      primary?: boolean;
      accessRole?: string;
      timeZone?: string;
    }>;
  }>(token, `${CAL_BASE}/users/me/calendarList`);
  return (body.items ?? []).map((c) => ({
    id: c.id,
    summary: c.summary ?? c.id,
    primary: Boolean(c.primary),
    accessRole: c.accessRole,
    timeZone: c.timeZone,
  }));
}

export async function listEvents(
  token: string,
  opts: {
    calendarId?: string;
    timeMin: string;
    timeMax: string;
    maxResults?: number;
    query?: string;
  },
) {
  const calendarId = encodeURIComponent(opts.calendarId ?? "primary");
  const params = new URLSearchParams({
    timeMin: opts.timeMin,
    timeMax: opts.timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.min(Math.max(opts.maxResults ?? 25, 1), 100)),
  });
  if (opts.query) params.set("q", opts.query);

  const body = await googleJson<{
    items?: Array<{
      id: string;
      summary?: string;
      description?: string;
      location?: string;
      status?: string;
      htmlLink?: string;
      hangoutLink?: string;
      start?: { dateTime?: string; date?: string; timeZone?: string };
      end?: { dateTime?: string; date?: string; timeZone?: string };
      attendees?: Array<{ email?: string; responseStatus?: string; displayName?: string }>;
    }>;
  }>(token, `${CAL_BASE}/calendars/${calendarId}/events?${params}`);

  return (body.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary ?? "(no title)",
    description: e.description,
    location: e.location,
    status: e.status,
    htmlLink: e.htmlLink,
    hangoutLink: e.hangoutLink,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    attendees: e.attendees,
  }));
}

export async function getEvent(token: string, calendarId: string, eventId: string) {
  const cal = encodeURIComponent(calendarId);
  const ev = encodeURIComponent(eventId);
  return googleJson(token, `${CAL_BASE}/calendars/${cal}/events/${ev}`);
}

export async function createEvent(
  token: string,
  opts: {
    calendarId?: string;
    summary: string;
    description?: string;
    location?: string;
    start: string;
    end: string;
    timeZone?: string;
    attendees?: string[];
  },
) {
  const calendarId = encodeURIComponent(opts.calendarId ?? "primary");
  const isAllDay = !opts.start.includes("T");
  const body: Record<string, unknown> = {
    summary: opts.summary,
    description: opts.description,
    location: opts.location,
    start: isAllDay
      ? { date: opts.start }
      : { dateTime: opts.start, timeZone: opts.timeZone ?? "UTC" },
    end: isAllDay
      ? { date: opts.end }
      : { dateTime: opts.end, timeZone: opts.timeZone ?? "UTC" },
  };
  if (opts.attendees?.length) {
    body.attendees = opts.attendees.map((email) => ({ email }));
  }

  return googleJson(token, `${CAL_BASE}/calendars/${calendarId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function updateEvent(
  token: string,
  opts: {
    calendarId?: string;
    eventId: string;
    summary?: string;
    description?: string;
    location?: string;
    start?: string;
    end?: string;
    timeZone?: string;
  },
) {
  const calendarId = encodeURIComponent(opts.calendarId ?? "primary");
  const eventId = encodeURIComponent(opts.eventId);
  const patch: Record<string, unknown> = {};
  if (opts.summary !== undefined) patch.summary = opts.summary;
  if (opts.description !== undefined) patch.description = opts.description;
  if (opts.location !== undefined) patch.location = opts.location;
  if (opts.start) {
    const isAllDay = !opts.start.includes("T");
    patch.start = isAllDay
      ? { date: opts.start }
      : { dateTime: opts.start, timeZone: opts.timeZone ?? "UTC" };
  }
  if (opts.end) {
    const isAllDay = !opts.end.includes("T");
    patch.end = isAllDay
      ? { date: opts.end }
      : { dateTime: opts.end, timeZone: opts.timeZone ?? "UTC" };
  }

  return googleJson(token, `${CAL_BASE}/calendars/${calendarId}/events/${eventId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function deleteEvent(token: string, calendarId: string, eventId: string) {
  const cal = encodeURIComponent(calendarId);
  const ev = encodeURIComponent(eventId);
  await googleJson(token, `${CAL_BASE}/calendars/${cal}/events/${ev}`, { method: "DELETE" });
}

export async function freebusy(
  token: string,
  opts: {
    timeMin: string;
    timeMax: string;
    calendarIds?: string[];
  },
) {
  const items = (opts.calendarIds?.length ? opts.calendarIds : ["primary"]).map((id) => ({
    id,
  }));
  const body = await googleJson<{
    calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }>;
  }>(token, `${CAL_BASE}/freeBusy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      items,
    }),
  });

  return Object.entries(body.calendars ?? {}).map(([calendarId, info]) => ({
    calendarId,
    busy: info.busy ?? [],
    errors: info.errors,
  }));
}

export async function respondEvent(
  token: string,
  opts: {
    calendarId?: string;
    eventId: string;
    response: "accepted" | "declined" | "tentative";
    email: string;
  },
) {
  const calendarId = encodeURIComponent(opts.calendarId ?? "primary");
  const eventId = encodeURIComponent(opts.eventId);
  const existing = await googleJson<{
    attendees?: Array<{ email?: string; responseStatus?: string; self?: boolean }>;
  }>(token, `${CAL_BASE}/calendars/${calendarId}/events/${eventId}`);

  const attendees = [...(existing.attendees ?? [])];
  const idx = attendees.findIndex(
    (a) => a.self || a.email?.toLowerCase() === opts.email.toLowerCase(),
  );
  if (idx >= 0) {
    attendees[idx] = { ...attendees[idx], responseStatus: opts.response };
  } else {
    attendees.push({ email: opts.email, responseStatus: opts.response, self: true });
  }

  return googleJson(token, `${CAL_BASE}/calendars/${calendarId}/events/${eventId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attendees }),
  });
}
