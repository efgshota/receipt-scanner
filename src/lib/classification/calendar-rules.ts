import type { Bucket } from "@/lib/types";

interface CalendarEvent {
  calendarId: string;
  summary: string;
  start: string;
  end: string;
}

// Calendar IDs mapped to buckets
const WORK_CALENDARS = [
  "s.fujii@stadiums.co.jp", // stadiums / THE PERSON
  "s.fujii@ttne.jp", // TTNE
  // cohan and zapass calendars - to be configured
];

const PERSONAL_CALENDAR = "efgshota@gmail.com";

function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr);
  const day = d.getDay();
  return day === 0 || day === 6;
}

export async function applyCalendarRules(
  transactionDate: string,
  calendarEvents?: CalendarEvent[]
): Promise<{ bucket: Bucket; confidence: number; details: string } | null> {
  if (!calendarEvents || calendarEvents.length === 0) {
    // No calendar data available — use day-of-week heuristic
    if (isWeekend(transactionDate)) {
      return {
        bucket: "family",
        confidence: 0.6,
        details: "Weekend, no calendar data — likely family",
      };
    }
    return {
      bucket: "nagi",
      confidence: 0.5,
      details: "Weekday, no calendar data — default NAGI",
    };
  }

  const workEvents = calendarEvents.filter((e) =>
    WORK_CALENDARS.some((cal) => e.calendarId.includes(cal))
  );
  const personalEvents = calendarEvents.filter(
    (e) => e.calendarId === PERSONAL_CALENDAR
  );

  // Work events on this date → stadiums
  if (workEvents.length > 0 && personalEvents.length === 0) {
    return {
      bucket: "stadiums",
      confidence: 0.9,
      details: `Work event: ${workEvents[0].summary}`,
    };
  }

  // Only personal events → depends on day
  if (workEvents.length === 0 && personalEvents.length > 0) {
    if (isWeekend(transactionDate)) {
      return {
        bucket: "family",
        confidence: 0.8,
        details: `Weekend personal event: ${personalEvents[0].summary}`,
      };
    }
    return {
      bucket: "nagi",
      confidence: 0.7,
      details: "Weekday personal activity — default NAGI",
    };
  }

  // Both work and personal events — ambiguous
  if (workEvents.length > 0 && personalEvents.length > 0) {
    return {
      bucket: "stadiums",
      confidence: 0.5,
      details: `Mixed: work(${workEvents[0].summary}) + personal(${personalEvents[0].summary})`,
    };
  }

  // No events at all
  if (isWeekend(transactionDate)) {
    return {
      bucket: "family",
      confidence: 0.6,
      details: "Weekend, no events",
    };
  }
  return {
    bucket: "nagi",
    confidence: 0.5,
    details: "Weekday, no events — default NAGI",
  };
}
