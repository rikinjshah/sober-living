// Intake validation and screening. Pure functions, no I/O, so they run under
// Deno (edge functions) and Node (tests) alike.
//
// Screening only raises flags for the operator. It never declines anyone:
// fair-housing and disability law protect people in recovery, including
// people on medication-assisted treatment, so the decision stays human.

export type IntakeInput = Record<string, unknown>;

export interface IntakeRecord {
  submitted_by: "self" | "family" | "professional";
  contact_name: string;
  contact_email: string;
  contact_phone: string | null;
  contact_relationship: string | null;
  contact_organization: string | null;
  applicant_name: string;
  applicant_email: string | null;
  applicant_phone: string | null;
  applicant_age: number | null;
  preferred_room: "private" | "shared" | null;
  desired_move_in: string | null;
  current_setting: string | null;
  treatment_program: string | null;
  expected_discharge: string | null;
  sobriety_date: string | null;
  needs_medical_detox: boolean;
  heard_about_us: string | null;
  heard_about_us_detail: string | null;
  message: string | null;
  consent_contact: boolean;
  consent_privacy: boolean;
  screening_flags: string[];
}

const SUBMITTED_BY = ["self", "family", "professional"];
const ROOM = ["private", "shared"];
const SETTINGS = [
  "residential_treatment", "detox", "iop_php", "home", "other_sober_living", "other",
];
const HEARD = [
  "treatment_program", "clinician", "attorney", "monitoring_program",
  "alumni", "family_friend", "search", "other",
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function bool(v: unknown): boolean {
  return v === true || v === "true" || v === "on" || v === "yes";
}

function oneOf(v: unknown, allowed: string[]): string | null {
  const s = str(v, 50);
  return s && allowed.includes(s) ? s : null;
}

function date(v: unknown): string | null {
  const s = str(v, 10);
  if (!s || !DATE_RE.test(s)) return null;
  return isNaN(Date.parse(s + "T00:00:00Z")) ? null : s;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

export function validateIntake(
  input: IntakeInput,
  today: string = new Date().toISOString().slice(0, 10),
): { ok: true; record: IntakeRecord } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const submitted_by = oneOf(input.submitted_by, SUBMITTED_BY) as IntakeRecord["submitted_by"] | null;
  if (!submitted_by) errors.submitted_by = "Tell us who is filling in this form.";

  const contact_name = str(input.contact_name, 120);
  if (!contact_name) errors.contact_name = "Your name is required.";

  const contact_email = str(input.contact_email, 200)?.toLowerCase() ?? null;
  if (!contact_email || !EMAIL_RE.test(contact_email)) errors.contact_email = "A valid email is required.";

  const applicant_email_raw = str(input.applicant_email, 200)?.toLowerCase() ?? null;
  if (applicant_email_raw && !EMAIL_RE.test(applicant_email_raw)) {
    errors.applicant_email = "That email doesn't look right.";
  }

  // When someone applies for themselves, the contact is the applicant.
  const applicant_name = submitted_by === "self" ? contact_name : str(input.applicant_name, 120);
  if (!applicant_name) errors.applicant_name = "The prospective resident's name is required.";

  let applicant_age: number | null = null;
  if (input.applicant_age !== undefined && input.applicant_age !== "" && input.applicant_age !== null) {
    const n = Number(input.applicant_age);
    if (!Number.isInteger(n) || n < 0 || n > 120) errors.applicant_age = "Enter an age in years.";
    else applicant_age = n;
  }

  const consent_contact = bool(input.consent_contact);
  const consent_privacy = bool(input.consent_privacy);
  if (!consent_contact) errors.consent_contact = "We need permission to contact you.";
  if (!consent_privacy) errors.consent_privacy = "Please accept the privacy notice.";

  const desired_move_in = date(input.desired_move_in);
  const expected_discharge = date(input.expected_discharge);
  const sobriety_date = date(input.sobriety_date);
  if (sobriety_date && sobriety_date > today) errors.sobriety_date = "Sobriety date can't be in the future.";

  if (Object.keys(errors).length) return { ok: false, errors };

  const record: IntakeRecord = {
    submitted_by: submitted_by!,
    contact_name: contact_name!,
    contact_email: contact_email!,
    contact_phone: str(input.contact_phone, 40),
    contact_relationship: submitted_by === "self" ? null : str(input.contact_relationship, 80),
    contact_organization: submitted_by === "professional" ? str(input.contact_organization, 160) : null,
    applicant_name: applicant_name!,
    applicant_email: submitted_by === "self" ? contact_email : applicant_email_raw,
    applicant_phone: submitted_by === "self" ? str(input.contact_phone, 40) : str(input.applicant_phone, 40),
    applicant_age,
    preferred_room: oneOf(input.preferred_room, ROOM) as IntakeRecord["preferred_room"],
    desired_move_in,
    current_setting: oneOf(input.current_setting, SETTINGS),
    treatment_program: str(input.treatment_program, 160),
    expected_discharge,
    sobriety_date,
    needs_medical_detox: bool(input.needs_medical_detox),
    heard_about_us: oneOf(input.heard_about_us, HEARD),
    heard_about_us_detail: str(input.heard_about_us_detail, 200),
    message: str(input.message, 4000),
    consent_contact,
    consent_privacy,
    screening_flags: [],
  };
  record.screening_flags = screen(record, today);
  return { ok: true, record };
}

// Flags are prompts for the operator's call, not verdicts.
export function screen(r: IntakeRecord, today: string): string[] {
  const flags: string[] = [];
  if (r.applicant_age !== null && r.applicant_age < 18) flags.push("under_18");
  if (r.needs_medical_detox) flags.push("needs_detox_first");
  if (r.current_setting === "detox") flags.push("currently_in_detox");
  if (r.sobriety_date && daysBetween(r.sobriety_date, today) < 14) flags.push("sobriety_under_14_days");
  if (!r.sobriety_date) flags.push("no_sobriety_date");
  if (r.current_setting === "residential_treatment" && !r.expected_discharge) flags.push("discharge_date_unknown");
  if (r.desired_move_in && daysBetween(today, r.desired_move_in) <= 3) flags.push("urgent_move_in");
  if (r.submitted_by !== "self" && !r.applicant_email && !r.applicant_phone) flags.push("no_direct_applicant_contact");
  if (r.heard_about_us === "treatment_program" || r.heard_about_us === "clinician") flags.push("professional_referral");
  return flags;
}

export const FLAG_LABELS: Record<string, string> = {
  under_18: "Under 18. Adults only.",
  needs_detox_first: "Says medical detox is needed first.",
  currently_in_detox: "Currently in detox.",
  sobriety_under_14_days: "Less than 14 days sober.",
  no_sobriety_date: "No sobriety date given.",
  discharge_date_unknown: "In residential treatment, discharge date unknown.",
  urgent_move_in: "Wants to move in within 3 days.",
  no_direct_applicant_contact: "No direct contact for the applicant.",
  professional_referral: "Came from a treatment program or clinician.",
};
